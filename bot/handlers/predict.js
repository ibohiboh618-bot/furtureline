// bot/handlers/predict.js
//
// /predict <free text> -> agent suggests up to 3 picks -> user taps a
// button to confirm exactly one -> we write a pending prediction and debit
// points. The agent never writes to predictions or points_ledger itself;
// only this confirm handler does, and only after an explicit tap.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');
const { InlineKeyboard } = require('grammy');
const { suggestPicks } = require('../agent/prediction-agent');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_STAKE = 50; // points, not currency

function registerPredictHandlers(bot) {
  bot.command('predict', handlePredictCommand);
  bot.command('mypicks', handleMyPicks);

  bot.callbackQuery(/^confirm_pick:(\d+):([A-Z0-9_]+):([A-Z]+)$/, async (ctx) => {
    if (!ctx.from) return;
    const [, fixtureIdStr, market, selection] = ctx.match;
    const fixtureId = Number(fixtureIdStr);

    const user = await getOrCreateUser(ctx.from);

    if (user.points_balance < DEFAULT_STAKE) {
      await ctx.answerCallbackQuery({ text: 'Not enough points for this stake.', show_alert: true });
      return;
    }

    const fixture = await getFixture(fixtureId);
    if (!fixture || fixture.status !== 'scheduled') {
      await ctx.answerCallbackQuery({ text: 'This fixture is no longer open for predictions.', show_alert: true });
      return;
    }

    await confirmPrediction({
      userId: user.id,
      fixtureId,
      market,
      selection,
      pointsStaked: DEFAULT_STAKE,
    });

    await ctx.answerCallbackQuery({ text: 'Pick locked in ✅' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply(
      `✅ Pick locked in for ${fixture.home_team} vs ${fixture.away_team}.\n` +
      `${selection} is now in your active picks with ${DEFAULT_STAKE} pts staked.\n` +
      `You’ll get an update when the match settles.`
    );
  });
}

async function handlePredictCommand(ctx) {
  if (!ctx.from) return;
  const preferenceText = getPredictionInput(ctx);

  if (!preferenceText) {
    return ctx.reply(
      'Tell me what you are after, e.g.\n' +
      '<code>/predict I like Brazil, keep it low risk</code>',
      { parse_mode: 'HTML' }
    );
  }

  const user = await getOrCreateUser(ctx.from);

  await ctx.replyWithChatAction('typing');

  const picks = await suggestPicks({
    preferenceText,
    riskPreference: user.risk_preference,
    favoriteTeams: user.favorite_teams,
  });

  if (picks.length === 0) {
    return ctx.reply("I don't have enough upcoming fixtures with odds to suggest anything right now. Try again closer to matchday.");
  }

  for (const [index, pick] of picks.entries()) {
    const fixture = await getFixture(pick.fixtureId);
    const fixtureName = fixture ? `${fixture.home_team} vs ${fixture.away_team}` : `Fixture #${pick.fixtureId}`;

    const keyboard = new InlineKeyboard().text(
      `Confirm this pick (${DEFAULT_STAKE} pts)`,
      `confirm_pick:${pick.fixtureId}:${pick.market}:${pick.selection}`
    );

    await ctx.reply(formatPickText(pick, index, fixtureName), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}

function getPredictionInput(ctx) {
  if (!ctx) return null;

  if (typeof ctx.match === 'string') return ctx.match.trim();
  if (ctx.match && typeof ctx.match === 'object') {
    if (typeof ctx.match[1] === 'string') return ctx.match[1].trim();
    if (typeof ctx.match.trim === 'function') return ctx.match.trim();
  }

  if (typeof ctx.message?.text === 'string') {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length > 1) return parts.slice(1).join(' ');
  }

  return null;
}

async function handleMyPicks(ctx) {
  if (!ctx.from) return;
  const user = await getOrCreateUser(ctx.from);
  const { rows } = await pool.query(
    `select p.*, f.home_team, f.away_team, f.kickoff_at
     from predictions p
     join fixtures f on f.id = p.fixture_id
     where p.user_id = $1
     order by p.confirmed_at desc
     limit 10`,
    [user.id]
  );

  if (rows.length === 0) {
    return ctx.reply('You do not have any active picks yet. Try /predict to get a fresh suggestion.');
  }

  const lines = rows.map((p) => {
    const statusIcon = { pending: '⏳', won: '✅', lost: '❌', void: '➖', cancelled: '🚫' }[p.status];
    return `${statusIcon} ${p.home_team} vs ${p.away_team} — ${p.selection} (${p.points_staked} pts)`;
  });

  await ctx.reply(['Your recent picks:', ...lines].join('\n'));
}

// --- data access -------------------------------------------------------

async function getOrCreateUser(from) {
  const { rows } = await pool.query(
    `insert into users (telegram_user_id, telegram_username, display_name)
     values ($1, $2, $3)
     on conflict (telegram_user_id) do update set
       last_active_at = now(),
       telegram_username = excluded.telegram_username
     returning *`,
    [from.id, from.username ?? null, from.first_name ?? null]
  );
  return rows[0];
}

async function getFixture(fixtureId) {
  const { rows } = await pool.query('select * from fixtures where id = $1', [fixtureId]);
  return rows[0] || null;
}

async function confirmPrediction({ userId, fixtureId, market, selection, pointsStaked }) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const { rows: [prediction] } = await client.query(
      `insert into predictions (user_id, fixture_id, market, selection, points_staked)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [userId, fixtureId, market, selection, pointsStaked]
    );

    const { rows: [user] } = await client.query(
      `update users set points_balance = points_balance - $1
       where id = $2
       returning points_balance`,
      [pointsStaked, userId]
    );

    await client.query(
      `insert into points_ledger (user_id, prediction_id, delta, reason, balance_after)
       values ($1, $2, $3, 'stake', $4)`,
      [userId, prediction.id, -pointsStaked, user.points_balance]
    );

    await client.query('commit');
    return prediction;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

function formatPickText(pick, index, fixtureName) {
  const pct = Math.round(pick.impliedProb * 100);
  return (
    `<b>Suggestion ${index + 1}</b>: ${fixtureName}\n` +
    `${pick.market} — ${pick.selection} (market gives this about ${pct}%)\n\n` +
    `${pick.reasoning}`
  );
}

module.exports = { registerPredictHandlers, handlePredictCommand, handleMyPicks };
