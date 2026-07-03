// bot/broadcast-queue.js
//
// Polls for score_events that haven't been broadcast yet and pushes them
// to subscribed groups/channels, respecting Telegram's rate limits:
//   - ~1 message/sec to a single chat
//   - ~20 messages/min into a single group
//   - ~30 messages/sec globally across all chats
//
// We stay well under all three by using a single global token-bucket
// limiter rather than trying to track per-chat limits separately -- with
// a few hundred broadcast targets this is simpler and safe by construction.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POLL_INTERVAL_MS = 2000;
const GLOBAL_SEND_INTERVAL_MS = 50; // ~20 sends/sec, safely under the ~30/sec cap

let bot = null; // injected via init(), so this module doesn't construct its own bot instance
let queue = [];
let draining = false;

function init(botInstance) {
  bot = botInstance;
  setInterval(pollForNewEvents, POLL_INTERVAL_MS);
  drainQueue();
}

async function pollForNewEvents() {
  try {
    const { rows: events } = await pool.query(
      `select se.*, f.home_team, f.away_team, f.home_score, f.away_score, f.competition
       from score_events se
       join fixtures f on f.id = se.fixture_id
       where se.broadcast_at is null
       order by se.occurred_at asc
       limit 50`
    );

    if (events.length === 0) return;

    for (const event of events) {
      const targets = await getTargetsFor(event);
      for (const target of targets) {
        queue.push({ event, target, type: 'broadcast' });
      }

      const favorites = await getFavoriteTargetsFor(event);
      for (const target of favorites) {
        queue.push({ event, target, type: 'favorite' });
      }

      await pool.query(`update score_events set broadcast_at = now() where id = $1`, [event.id]);
    }

    // Trigger draining since new items were added
    drainQueue();
  } catch (err) {
    console.error('[broadcast-queue] poll failed:', err.message);
  }
}

async function getTargetsFor(event) {
  try {
    const { rows } = await pool.query(
      `select * from broadcast_targets
       where active = true
         and (subscribed_competitions = '{}' or $1 = any(subscribed_competitions))
         and (
           alert_level = 'all_events'
           or (alert_level = 'goals_and_cards' and $2 in ('goal', 'red_card', 'yellow_card'))
           or (alert_level = 'goals_only' and $2 = 'goal')
         )`,
      [event.competition, event.event_type]
    );
    return rows;
  } catch (err) {
    console.error('[broadcast-queue] target lookup failed:', err.message);
    return [];
  }
}

async function getFavoriteTargetsFor(event) {
  try {
    const { rows } = await pool.query(
      `select telegram_user_id as chat_id, favorite_alert_level, favorite_teams
       from users
       where telegram_user_id is not null
         and ($1 = any(favorite_teams) or $2 = any(favorite_teams))`,
      [event.home_team, event.away_team]
    );

    const targets = [];
    const seen = new Set();

    for (const row of rows) {
      const level = row.favorite_alert_level || 'goals_only';
      if (!shouldNotifyForFavorite(level, event.event_type)) continue;

      const favorites = Array.isArray(row.favorite_teams) ? row.favorite_teams : [];
      const followsHome = favorites.includes(event.home_team);
      const followsAway = favorites.includes(event.away_team);
      const isMatchLevel = !event.team;

      if (event.team === 'home' && !followsHome) continue;
      if (event.team === 'away' && !followsAway) continue;
      if (isMatchLevel && !followsHome && !followsAway) continue;

      const chatId = Number(row.chat_id);
      if (!chatId || seen.has(chatId)) continue;
      seen.add(chatId);

      targets.push({
        chat_id: chatId,
        home_team: event.home_team,
        away_team: event.away_team,
        event_type: event.event_type,
        team: event.team,
      });
    }

    return targets;
  } catch (err) {
    console.error('[broadcast-queue] favorite target lookup failed:', err.message);
    return [];
  }
}

function shouldNotifyForFavorite(level, eventType) {
  if (level === 'all_events') return true;
  if (level === 'goals_and_cards') {
    return ['goal', 'red_card'].includes(eventType);
  }
  return eventType === 'goal';
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await sendBroadcast(job);
    } catch (err) {
      console.error('[broadcast-queue] send failed:', err.message, 'chat:', job.target.chat_id);
      // Telegram returns 403 if the bot was removed/blocked -- deactivate
      // the target so we stop retrying a dead chat forever.
      if (err.error_code === 403) {
        try {
          await pool.query(
            `update broadcast_targets set active = false where chat_id = $1`,
            [job.target.chat_id]
          );
        } catch (dbErr) {
          console.error('[broadcast-queue] deactivate target failed:', dbErr.message);
        }
      }
    }
    await sleep(GLOBAL_SEND_INTERVAL_MS);
  }

  draining = false;
}

async function sendBroadcast({ event, target, type }) {
  const text = formatEventText(event, type);
  await bot.api.sendMessage(target.chat_id, text, { parse_mode: 'HTML' });
}

function formatEventText(event, type = 'broadcast') {
  const score = `${event.home_score ?? 0}-${event.away_score ?? 0}`;
  const matchLabel = `${event.home_team} vs ${event.away_team}`;
  const prefix = type === 'favorite' ? '⭐ Favorite team update:' : '';

  switch (event.event_type) {
    case 'goal': {
      const scorer = event.team === 'home' ? event.home_team : event.away_team;
      return `${prefix} ⚽ <b>Goal!</b> ${scorer} (${event.minute}') — ${matchLabel} now ${score}`;
    }
    case 'red_card': {
      const side = event.team === 'home' ? event.home_team : event.away_team;
      return `${prefix} 🟥 Red card, ${side} (${event.minute}') — ${matchLabel}`;
    }
    case 'yellow_card': {
      const side = event.team === 'home' ? event.home_team : event.away_team;
      return `${prefix} 🟨 Yellow card, ${side} (${event.minute}') — ${matchLabel}`;
    }
    case 'half_time':
      return `${prefix} ⏱ Half time — ${matchLabel} ${score}`;
    case 'full_time':
      return `${prefix} 🏁 Full time — ${matchLabel} ${score}`;
    default:
      return `${prefix} ${matchLabel}: ${event.description ?? event.event_type}`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { init };
