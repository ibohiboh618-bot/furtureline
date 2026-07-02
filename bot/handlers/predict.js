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
const { buildFooterMenu } = require('../ui');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_STAKE = 50; // points, not currency

function registerPredictHandlers(bot) {
  bot.command('predict', handlePredictCommand);
  bot.command('mypicks', handleMyPicks);

  // Verify a specific prediction (button shown in DM under My Picks)
  bot.callbackQuery(/^verify_pick:(\d+):(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    const [, predictionIdStr, fixtureIdStr] = ctx.match;
    const predictionId = Number(predictionIdStr);
    const fixtureId = Number(fixtureIdStr);

    // Ensure the callback is invoked by the owner of the prediction
    const { rows } = await pool.query(
      `select u.telegram_user_id as telegram_id
       from predictions p
       join users u on u.id = p.user_id
       where p.id = $1`,
      [predictionId]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Prediction not found.', show_alert: true });
      return;
    }
    const ownerTelegramId = rows[0].telegram_id;
    if (ownerTelegramId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Only the owner can verify this prediction.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    // Provide progress feedback: send a placeholder message and edit it later
    const progress = await ctx.reply('Verifying... this may take a moment.');
    // Call the verify service (if configured) and show result; otherwise instruct
    // the user how to run verification.
    const verifyServiceUrl = process.env.VERIFY_SERVICE_URL;
    if (verifyServiceUrl) {
      try {
        const axios = require('axios');
        const url = verifyServiceUrl.replace(/\/$/, '') + '/verify-by-id';
        const headers = {};
        if (process.env.VERIFY_SERVICE_TOKEN) headers['Authorization'] = `Bearer ${process.env.VERIFY_SERVICE_TOKEN}`;
        const resp = await axios.post(url, { fixtureId }, { timeout: 20000, headers });
        const txSig = resp.data?.txSig || resp.data?.tx_sig || resp.data?.sig;
        if (txSig) {
          const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
          const explorerUrl = rpcUrl.includes('devnet')
            ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
            : `https://explorer.solana.com/tx/${txSig}`;
          // Edit the in-progress message with the result
          return ctx.api.editMessageText(ctx.chat.id, progress.message_id,
            `On-chain validation submitted.\n` +
            `Validation transaction: <code>${txSig}</code>\n` +
            `View on explorer: ${explorerUrl}`,
            { parse_mode: 'HTML' }
          ).catch(async () => {
            await ctx.reply(
              `On-chain validation submitted.\n` +
              `Validation transaction: <code>${txSig}</code>\n` +
              `View on explorer: ${explorerUrl}`,
              { parse_mode: 'HTML' }
            );
          });
        }
        // If the service queued the job, show queued notice with a link to job-status
        if (resp.status === 202 && resp.data?.jobId) {
          const jobId = resp.data.jobId;
          const jobUrl = verifyServiceUrl.replace(/\/$/, '') + `/job-status?id=${jobId}`;
          const { InlineKeyboard } = require('grammy');
          const kb = new InlineKeyboard().url('Check job status', jobUrl);
          return ctx.api.editMessageText(ctx.chat.id, progress.message_id, `Verification queued (job ${jobId}). Check status: ${jobUrl}`, { reply_markup: kb }).catch(async () => {
            await ctx.reply(`Verification queued (job ${jobId}). Check status: ${jobUrl}`);
          });
        }
      } catch (e) {
        console.error('[predict.verify_pick] verify service error:', e?.message || e);
      }
    }

    await ctx.api.editMessageText(ctx.chat.id, progress.message_id, 'Verification service unavailable. You can run verification locally or ask an admin to deploy the verify-worker.').catch(() => {
      ctx.reply('Verification service unavailable. You can run verification locally or ask an admin to deploy the verify-worker.');
    });
  });

  // Explain what Verify does (short helper) and offer to run verification
  bot.callbackQuery(/^verify_explain:(\d+):(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    const [, predictionIdStr, fixtureIdStr] = ctx.match;
    await ctx.answerCallbackQuery();
    await ctx.reply('Verify fetches the merkle proof archived by TxODDS for this fixture and submits it to the on-chain validator. This proves the batch that contained the fixture was anchored. Tap Verify to run it now.');
    const kb = new InlineKeyboard().text('Run Verify', `verify_pick:${predictionIdStr}:${fixtureIdStr}`);
    await ctx.reply('Ready?', { reply_markup: kb });
  });

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

    const prediction = await confirmPrediction({
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

    // Send a follow-up message with Explain + Verify buttons so user can learn or trigger verification
    try {
      const { InlineKeyboard } = require('grammy');
      const kb = new InlineKeyboard()
        .text('What does Verify do?', `verify_explain:${prediction.id}:${fixtureId}`)
        .row()
        .text('Verify this fixture', `verify_pick:${prediction.id}:${fixtureId}`);
      await ctx.reply('If you want to validate this fixture on-chain, tap Verify or learn more with What does Verify do?', { reply_markup: kb });
    } catch (e) {
      // ignore errors here
    }
  });
}

async function handlePredictCommand(ctx) {
  if (!ctx.from) return;
  // If issued in a group or channel, route users to DM for private picks
  if (ctx.chat && ctx.chat.type && ctx.chat.type !== 'private') {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'FixtureLineBot';
    const url = `https://t.me/${botUsername}?start=predict`;
    const kb = new InlineKeyboard().url('Open in private chat', url);
    return ctx.reply('I can help with private, personalized suggestions — please open a direct chat with me to continue.', { reply_markup: kb });
  }

  const preferenceText = getPredictionInput(ctx);

  if (!preferenceText) {
    return ctx.reply(
      'Tell me what you are after, e.g.\n' +
      '<code>/predict I like Brazil, keep it low risk</code>',
      { parse_mode: 'HTML', reply_markup: buildFooterMenu() }
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
    return ctx.reply("I don't have enough upcoming fixtures with odds to suggest anything right now. Try again closer to matchday.", { reply_markup: buildFooterMenu() });
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
    return ctx.reply('You do not have any active picks yet. Try /predict to get a fresh suggestion.', { reply_markup: buildFooterMenu() });
  }

  // In private chats include a per-prediction Verify button; avoid sending
  // verify controls in groups to prevent public triggers.
  for (const p of rows) {
    const statusIcon = { pending: '⏳', won: '✅', lost: '❌', void: '➖', cancelled: '🚫' }[p.status];
    const text = `${statusIcon} ${p.home_team} vs ${p.away_team} — ${p.selection} (${p.points_staked} pts)`;

    if (ctx.chat && ctx.chat.type === 'private') {
      const kb = new InlineKeyboard().text('Verify', `verify_pick:${p.id}:${p.fixture_id}`);
      await ctx.reply(text, { reply_markup: kb });
    } else {
      await ctx.reply(text);
    }
  }
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
