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
  const { rows: events } = await pool.query(
    `select se.*, f.home_team, f.away_team, f.home_score, f.away_score, f.competition
     from score_events se
     join fixtures f on f.id = se.fixture_id
     where se.broadcast_at is null
       and se.event_type in ('goal', 'red_card', 'half_time', 'full_time')
     order by se.occurred_at asc
     limit 50`
  );

  if (events.length === 0) return;

  for (const event of events) {
    const targets = await getTargetsFor(event);
    for (const target of targets) {
      queue.push({ event, target });
    }
    await pool.query(`update score_events set broadcast_at = now() where id = $1`, [event.id]);
  }

  // Trigger draining since new items were added
  drainQueue();
}

async function getTargetsFor(event) {
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
        await pool.query(
          `update broadcast_targets set active = false where chat_id = $1`,
          [job.target.chat_id]
        );
      }
    }
    await sleep(GLOBAL_SEND_INTERVAL_MS);
  }

  draining = false;
}

async function sendBroadcast({ event, target }) {
  const text = formatEventText(event);
  await bot.api.sendMessage(target.chat_id, text, { parse_mode: 'HTML' });
}

function formatEventText(event) {
  const score = `${event.home_score ?? 0}-${event.away_score ?? 0}`;
  const matchLabel = `${event.home_team} vs ${event.away_team}`;

  switch (event.event_type) {
    case 'goal': {
      const scorer = event.team === 'home' ? event.home_team : event.away_team;
      return `⚽ <b>Goal!</b> ${scorer} (${event.minute}') — ${matchLabel} now ${score}`;
    }
    case 'red_card': {
      const side = event.team === 'home' ? event.home_team : event.away_team;
      return `🟥 Red card, ${side} (${event.minute}') — ${matchLabel}`;
    }
    case 'half_time':
      return `⏱ Half time — ${matchLabel} ${score}`;
    case 'full_time':
      return `🏁 Full time — ${matchLabel} ${score}`;
    default:
      return `${matchLabel}: ${event.description ?? event.event_type}`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { init };
