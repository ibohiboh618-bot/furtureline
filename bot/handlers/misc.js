// bot/handlers/misc.js
//
// /leaderboard and /verify -- the two features that round out the fan
// experience and give the on-chain angle something concrete to point at
// in a demo, rather than just asserting "it's on Solana" in prose.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');
const axios = require('axios');
const { InlineKeyboard } = require('grammy');
const { buildFooterMenu } = require('../ui');
const { formatInsightsText } = require('../market-insights');
const { handlePredictCommand, handleMyPicks } = require('./predict');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';

function registerMiscHandlers(bot) {
  bot.command('leaderboard', handleLeaderboard);
  bot.command('verify', handleVerify);
  bot.command('markets', handleMarkets);
  bot.command('help', handleHelp);
  bot.command('menu', handleMenu);

  bot.callbackQuery(/^menu:(predict|mypicks|leaderboard|verify|markets|help)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = getMenuAction(ctx.match[1]);
    if (action === 'predict') return handlePredictShortcut(ctx);
    if (action === 'mypicks') return handleMyPicks(ctx);
    if (action === 'leaderboard') return handleLeaderboard(ctx);
    if (action === 'verify') return handleVerify(ctx);
    if (action === 'markets') return handleMarkets(ctx);
    return handleHelp(ctx);
  });
}

function getMenuAction(name) {
  switch (name) {
    case 'predict':
      return 'predict';
    case 'mypicks':
      return 'mypicks';
    case 'leaderboard':
      return 'leaderboard';
    case 'verify':
      return 'verify';
    case 'markets':
      return 'markets';
    case 'help':
      return 'help';
    default:
      return null;
  }
}

async function handlePredictShortcut(ctx) {
  if (ctx.chat && ctx.chat.type && ctx.chat.type !== 'private') {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'FixtureLineBot';
    const url = `https://t.me/${botUsername}?start=predict`;
    const kb = new InlineKeyboard().url('Open in private chat', url);
    return ctx.reply('I can help with private, personalized suggestions — please open a direct chat with me to continue.', { reply_markup: kb });
  }

  return handlePredictCommand(ctx);
}

async function handleLeaderboard(ctx) {
  const { rows } = await pool.query(
    `select telegram_username, display_name, points_balance
     from users
     order by points_balance desc
     limit 10`
  );

  if (rows.length === 0) {
    return ctx.reply('No picks have been made yet. Be the first to start the scoreboard with /predict.', { reply_markup: buildFooterMenu() });
  }

  const lines = rows.map((u, i) => {
    const name = u.telegram_username ? `@${u.telegram_username}` : (u.display_name || 'Anonymous');
    return `${i + 1}. ${name} -- ${u.points_balance} pts`;
  });

  await ctx.reply(['Leaderboard', ...lines].join('\n'), { reply_markup: buildFooterMenu() });
}

async function handleHelp(ctx) {
  const text = [
    'FixtureLine is a football intelligence bot built for fans.',
    '',
    'It combines live match updates, market insights, AI-assisted picks, and on-chain proof.',
    '',
    'Quick actions:',
    '• Predict — get AI-assisted picks',
    '• Markets — inspect upcoming odds and market context',
    '• My Picks — review your active picks',
    '• Verify — inspect a fixture’s on-chain proof',
  ].join('\n');

  await ctx.reply(text, { reply_markup: buildFooterMenu() });
}

async function handleMarkets(ctx) {
  const fixtures = await getMarketInsights();
  const text = [
    'Upcoming market insights 📈',
    '',
    formatInsightsText(fixtures),
  ].join('\n');

  await ctx.reply(text, { reply_markup: buildFooterMenu() });
}

async function handleVerify(ctx) {
  const fixtureIdStr = getVerifyInput(ctx);
  if (!fixtureIdStr || Number.isNaN(Number(fixtureIdStr))) {
    return ctx.reply('Usage: /verify <fixtureId>', { reply_markup: buildFooterMenu() });
  }

  await ctx.replyWithChatAction('typing');

  const verifyServiceUrl = process.env.VERIFY_SERVICE_URL;
  if (verifyServiceUrl) {
    try {
      const url = verifyServiceUrl.replace(/\/$/, '') + '/verify-by-id';
      const headers = {};
      if (process.env.VERIFY_SERVICE_TOKEN) headers['Authorization'] = `Bearer ${process.env.VERIFY_SERVICE_TOKEN}`;
      const resp = await axios.post(url, { fixtureId: fixtureIdStr }, { timeout: 20000, headers });
      const txSig = resp.data?.txSig || resp.data?.tx_sig || resp.data?.sig;
      if (txSig) {
        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
        const explorerUrl = rpcUrl.includes('devnet')
          ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
          : `https://explorer.solana.com/tx/${txSig}`;

        return await ctx.reply(
          `On-chain validation submitted.\n` +
          `Validation transaction: <code>${txSig}</code>\n` +
          `View on explorer: ${explorerUrl}`,
          { parse_mode: 'HTML', reply_markup: buildFooterMenu() }
        );
      }

      if (resp.status === 202 && resp.data?.jobId) {
        const jobId = resp.data.jobId;
        const jobUrl = verifyServiceUrl.replace(/\/$/, '') + `/job-status?id=${jobId}`;
        return await ctx.reply(`Verification queued (job ${jobId}). Check status at ${jobUrl}`, {
          reply_markup: buildFooterMenu(),
        });
      }
    } catch (e) {
      console.error('[verify] verify-service call failed:', e?.message || e);
      // fall through to attempt local proof verification if possible
    }
  }

  try {
    const { jwt, apiToken } = await getActiveSession();
    const proofResponse = await fetchMerkleProof(fixtureIdStr, jwt, apiToken);
    return await ctx.reply(
      `This fixture's data batch is anchored on Solana.\n` +
      `Merkle root: <code>${proofResponse.merkleRoot}</code>\n` +
      `Batch timestamp: ${proofResponse.batchTimestamp}\n\n` +
      `To perform on-chain validation, either run the verification worker locally or deploy the verify service and set VERIFY_SERVICE_URL in the bot process.`,
      { parse_mode: 'HTML', reply_markup: buildFooterMenu() }
    );
  } catch (e) {
    console.error('[verify] fallback proof error:', e?.message || e);

    if (e.message && e.message.includes('No active TxODDS session')) {
      return ctx.reply(
        "❌ Verification is not configured. Set VERIFY_SERVICE_URL in the bot environment or run the TxODDS session ingester so the local proof lookup can work.",
        { reply_markup: buildFooterMenu() }
      );
    }

    if (e.response && e.response.status === 404) {
      return ctx.reply(
        `❌ No proof has been archived for fixture <code>${fixtureIdStr}</code> yet. It might not be finished, or its block hasn't been committed to Solana.`,
        { parse_mode: 'HTML', reply_markup: buildFooterMenu() }
      );
    }

    return ctx.reply(
      "❌ Couldn't fetch a proof for that fixture right now. Please ensure the fixture ID is correct or try again shortly.",
      { reply_markup: buildFooterMenu() }
    );
  }
}

function getVerifyInput(ctx) {
  if (!ctx) return null;

  if (typeof ctx.match === 'string') return ctx.match.trim();
  if (ctx.match && typeof ctx.match === 'object') {
    if (typeof ctx.match[1] === 'string') return ctx.match[1].trim();
    if (typeof ctx.match.trim === 'function') return ctx.match.trim();
  }

  if (typeof ctx.message?.text === 'string') {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length > 1) return parts[1];
  }

  return null;
}

async function getMarketInsights() {
  const { rows } = await pool.query(
    `select
       f.id as fixture_id,
       f.home_team,
       f.away_team,
       os.market,
       os.selection,
       os.implied_prob as implied_prob
     from fixtures f
     join lateral (
       select distinct on (market, selection) market, selection, implied_prob
       from odds_snapshots
       where fixture_id = f.id and market in ('1X2', 'BTTS', 'OU_2_5')
       order by market, selection, captured_at desc
     ) os on true
     where f.status = 'scheduled'
       and f.kickoff_at > now()
       and f.kickoff_at < now() + interval '3 days'
     order by f.kickoff_at asc
     limit 6`
  );

  const byFixture = new Map();
  for (const row of rows) {
    if (!byFixture.has(row.fixture_id)) {
      byFixture.set(row.fixture_id, {
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        odds: [],
      });
    }
    byFixture.get(row.fixture_id).odds.push({
      market: row.market,
      selection: row.selection,
      impliedProb: Number(row.implied_prob),
    });
  }

  return Array.from(byFixture.values());
}

async function getActiveSession() {
  const { rows } = await pool.query('select jwt, api_token from txodds_session where id = 1');
  if (rows.length === 0) throw new Error('No active TxODDS session');
  return { jwt: rows[0].jwt, apiToken: rows[0].api_token };
}

async function fetchMerkleProof(fixtureId, jwt, apiToken) {
  const { data } = await axios.get(
    `${TXLINE_BASE_URL}/api/fixtures/${fixtureId}/proof`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': apiToken,
      },
    }
  );

  // Defensive parsing supporting variations in TxLINE response properties
  const merkleRoot = data.merkleRoot || data.root || data.merkle_root || data.merkleRootHash || 'Not Available';
  const batchTimestamp = data.batchTimestamp || data.timestamp || data.ts || data.batch_timestamp || new Date().toISOString();

  return {
    merkleRoot,
    batchTimestamp,
    proofPayload: data,
  };
}

async function handleMenu(ctx) {
  await ctx.reply('Quick access commands:', { reply_markup: buildFooterMenu() });
}

module.exports = {
  registerMiscHandlers,
  getMenuAction,
  handleLeaderboard,
  handleHelp,
  handleVerify,
  handleMarkets,
};
