// bot/handlers/misc.js
//
// /leaderboard and /verify -- the two features that round out the fan
// experience and give the on-chain angle something concrete to point at
// in a demo, rather than just asserting "it's on Solana" in prose.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');
const axios = require('axios');
const { InlineKeyboard } = require('grammy');
const { buildFooterMenu, buildOnboardingMenu, buildMainMenu } = require('../ui');
const { formatInsightsText } = require('../market-insights');
const { createWalletSetup, verifyWalletPin, decryptSecret } = require('../wallet');
const { handlePredictCommand, handleMyPicks, getOrCreateUser } = require('./predict');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';
const pendingWalletActions = new Map();

function registerMiscHandlers(bot) {
  bot.command('leaderboard', handleLeaderboard);
  bot.command('verify', handleVerify);
  bot.command('verify-status', handleVerifyStatus);
  bot.command('diagnose', handleDiagnose);
  bot.command('about', handleAbout);
  bot.command('markets', handleMarkets);
  bot.command('odds', handleOdds);
  bot.command('follow', handleFollow);
  bot.command('unfollow', handleUnfollow);
  bot.command('favorites', handleFavorites);
  bot.command('favorite-alerts', handleFavoriteAlerts);
  bot.command('favorite-alert-level', handleFavoriteAlerts);
  bot.command('help', handleHelp);
  bot.command('menu', handleMenu);
  bot.command('wallet', handleWalletSetup);
  bot.command('settings', handleSettings);

  bot.hears(/^Predict$/i, handlePredictShortcut);
  bot.hears(/^Markets$/i, handleMarkets);
  bot.hears(/^My Picks$/i, handleMyPicks);
  bot.hears(/^Verify$/i, handleVerify);
  bot.hears(/^Verify status$/i, handleVerifyStatus);
  bot.hears(/^Diagnostics$/i, handleDiagnose);
  bot.hears(/^About$/i, handleAbout);
  bot.hears(/^Leaderboard$/i, handleLeaderboard);
  bot.hears(/^Live odds$/i, handleOdds);
  bot.hears(/^Help$/i, handleHelp);

  bot.callbackQuery(/^menu:(predict|mypicks|leaderboard|verify|markets|help|odds|about|diagnose|wallet|settings)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = getMenuAction(ctx.match[1]);
    if (action === 'predict') return handlePredictShortcut(ctx);
    if (action === 'mypicks') return handleMyPicks(ctx);
    if (action === 'leaderboard') return handleLeaderboard(ctx);
    if (action === 'verify') return ctx.reply('Usage: /verify <fixtureId>. Copy a fixture ID from /odds output if you need one.', { reply_markup: buildFooterMenu() });
    if (action === 'markets') return handleMarkets(ctx);
    if (action === 'odds') return handleOdds(ctx, null, true);
    if (action === 'about') return handleAbout(ctx);
    if (action === 'diagnose') return handleDiagnose(ctx);
    if (action === 'wallet') return handleWalletSetup(ctx);
    if (action === 'settings') return handleSettings(ctx);
    return handleHelp(ctx);
  });

  bot.callbackQuery(/^group:(alertlevel|odds|help)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1];
    if (action === 'odds') return handleOdds(ctx, null, true);
    if (action === 'help') return handleHelp(ctx);
    return ctx.reply('Admins can set alert level with /alertlevel goals_only | goals_and_cards | all_events.', { reply_markup: buildFooterMenu() });
  });

  bot.callbackQuery(/^odds:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return handleOdds(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^[\s\S]*$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: 'Sorry, I could not process that button. Please try again or send /menu.', show_alert: false });
    } catch (err) {
      // swallow errors from repeated answer attempts
    }
    console.warn('[bot] unhandled callback data:', ctx.callbackQuery?.data);
  });

  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;
    const state = pendingWalletActions.get(ctx.from.id);
    if (!state) return;

    pendingWalletActions.delete(ctx.from.id);
    const normalizedPin = String(ctx.message.text || '').replace(/\D/g, '');
    if (normalizedPin.length !== 6) {
      await ctx.reply('Please send exactly 6 digits for the pin.');
      return;
    }

    if (state.kind === 'wallet-create') {
      await createWalletForUser(ctx, normalizedPin);
    } else if (state.kind === 'wallet-export') {
      await exportWalletForUser(ctx, normalizedPin);
    }
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
    case 'odds':
      return 'odds';
    case 'help':
      return 'help';
    case 'about':
      return 'about';
    case 'diagnose':
      return 'diagnose';
    case 'wallet':
      return 'wallet';
    case 'settings':
      return 'settings';
    default:
      return null;
  }
}

async function handleOdds(ctx, overrideFixtureId = null, forceList = false) {
  const fixtureId = forceList ? null : (overrideFixtureId || getOddsInput(ctx));

  if (!fixtureId) {
    // list upcoming fixtures with a short id so users can call /odds <fixtureId>
    const { rows } = await pool.query(
      `select id, home_team, away_team, kickoff_at
       from fixtures
       where status = 'scheduled' and kickoff_at > now()
         and kickoff_at < now() + interval '3 days'
       order by kickoff_at asc
       limit 6`
    );

    if (rows.length === 0) {
      return ctx.reply('No upcoming fixtures with odds available right now.', { reply_markup: buildFooterMenu() });
    }

    const lines = rows.map(r => `${r.id} — ${r.home_team} vs ${r.away_team} (kickoff ${new Date(r.kickoff_at).toISOString()})`);
    lines.unshift(
      'Upcoming fixtures with live odds:',
      'Tap Copy ID to paste the fixture ID into the chat, then send /odds <fixtureId> or /verify <fixtureId>.',
      ''
    );

    const keyboard = new InlineKeyboard();
    for (const r of rows) {
      keyboard
        .switchInlineCurrent(`Copy ${r.id}`, r.id)
        .text('Show odds', `odds:${r.id}`)
        .row();
    }
    keyboard.text('Help', 'menu:help');

    return ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  }

  // show latest market snapshots for the fixture
  try {
    const { rows } = await pool.query(
      `select distinct on (market, selection) market, selection, implied_prob
       from odds_snapshots
       where fixture_id = $1
       order by market, selection, captured_at desc`,
      [fixtureId]
    );

    if (rows.length === 0) {
      return ctx.reply(`No odds found for fixture ${fixtureId}.`, { reply_markup: buildFooterMenu() });
    }

    const byMarket = new Map();
    for (const r of rows) {
      if (!byMarket.has(r.market)) byMarket.set(r.market, []);
      byMarket.get(r.market).push({ selection: r.selection, impliedProb: Number(r.implied_prob) });
    }

    const partsOut = [`Markets for fixture ${fixtureId}:`, ''];
    for (const [market, entries] of byMarket.entries()) {
      partsOut.push(`-- ${market}`);
      for (const e of entries) partsOut.push(`  ${e.selection}: ${(e.impliedProb * 100).toFixed(2)}%`);
      partsOut.push('');
    }

    return ctx.reply(partsOut.join('\n'), { reply_markup: buildFooterMenu() });
  } catch (err) {
    console.error('[odds] query failed:', err.message);
    return ctx.reply('Error fetching odds. Try again later.', { reply_markup: buildFooterMenu() });
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
    'FixtureLine is a football intelligence bot for fans who want live odds, picks, and proof.',
    '',
    'How the flow works:',
    '• Start the bot and read the welcome message.',
    '• Create a wallet with /wallet by setting a transaction pin.',
    '• The private key is not shown in chat; it is available later in Settings after you enter the pin.',
    '• Ask for a pick with /predict and confirm it as usual.',
    '• Settlement and proof events are recorded for your confirmed pick.',
    '',
    'Use the buttons below or type one of these commands:',
    '• /predict — get an AI-assisted pick',
    '• /odds <fixtureId> — view odds for a match',
    '• /verify <fixtureId> — validate match data on-chain',
    '• /mypicks — see your active picks',
    '• /leaderboard — view the top players',
    '• /wallet — create or manage your wallet',
    '• /settings — unlock wallet export details',
    '',
    'To get a fixture ID, open /odds and tap Copy ID next to a match.',
  ].join('\n');

  await ctx.reply(text, { reply_markup: buildFooterMenu() });
}

async function handleWalletSetup(ctx) {
  if (!ctx.from) return;

  const providedPin = getCommandArg(ctx);
  if (providedPin) {
    return createWalletForUser(ctx, providedPin);
  }

  const text = [
    'Wallet setup',
    '',
    'Create a transaction pin to approve wallet actions.',
    'This pin is used to unlock wallet export and settings later.',
    'Your private key will not be shown in the main chat flow.',
  ].join('\n');

  await ctx.reply(text, { reply_markup: buildOnboardingMenu() });
  await ctx.reply('Reply with a 6-digit pin to create your wallet.');
  pendingWalletActions.set(ctx.from.id, { kind: 'wallet-create' });
}

async function handleSettings(ctx) {
  if (!ctx.from) return;

  const providedPin = getCommandArg(ctx);
  if (providedPin) {
    return exportWalletForUser(ctx, providedPin);
  }

  await ctx.reply('Enter your wallet pin to unlock export details.');
  await ctx.reply('Reply with your 6-digit pin.');
  pendingWalletActions.set(ctx.from.id, { kind: 'wallet-export' });
}

async function createWalletForUser(ctx, pin) {
  const user = await getOrCreateUser(ctx.from);
  const existingWallet = await getWalletForUser(user.id);
  if (existingWallet) {
    return ctx.reply(`A wallet already exists for you.\nAddress: ${existingWallet.address}\nUse /settings <pin> to export your private key.`);
  }

  const normalizedPin = String(pin || '').replace(/\D/g, '');
  if (normalizedPin.length !== 6) {
    return ctx.reply('Please send exactly 6 digits for the pin.');
  }

  const wallet = createWalletSetup({ pin: normalizedPin });
  await pool.query(
    `insert into user_wallets (user_id, address, pin_hash, encrypted_private_key, iv)
     values ($1, $2, $3, $4, $5)`,
    [user.id, wallet.address, wallet.pinHash, wallet.encryptedPrivateKey, wallet.iv]
  );

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'FixtureLineBot';
  await ctx.reply(
    `Wallet created successfully.\nAddress: ${wallet.address}\nYour private key is kept hidden for now and can be exported later from /settings after you enter the same pin.`,
    { reply_markup: buildMainMenu({ botUsername }) }
  );
}

async function exportWalletForUser(ctx, pin) {
  const user = await getOrCreateUser(ctx.from);
  const wallet = await getWalletForUser(user.id);
  if (!wallet) {
    return ctx.reply('No wallet has been created yet. Use /wallet <6-digit-pin> to create one first.');
  }

  const normalizedPin = String(pin || '').replace(/\D/g, '');
  if (normalizedPin.length !== 6) {
    return ctx.reply('That pin is not valid.');
  }

  const verified = verifyWalletPin({ pin: normalizedPin, pinHash: wallet.pin_hash });
  if (!verified) {
    return ctx.reply('The pin did not match.');
  }

  const privateKey = decryptSecret({ ciphertext: wallet.encrypted_private_key, iv: wallet.iv });
  await ctx.reply(`Wallet unlocked.\nAddress: ${wallet.address}\nPrivate key: ${privateKey}`);
}

async function getWalletForUser(userId) {
  const { rows } = await pool.query('select * from user_wallets where user_id = $1', [userId]);
  return rows[0] || null;
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

async function handleAbout(ctx) {
  const text = [
    'FixtureLine is a football intelligence companion that brings live odds, picks, and verification into Telegram.',
    '',
    'What it does:',
    '• Shows upcoming fixtures and current market odds',
    '• Suggests AI-assisted picks when you ask for them',
    '• Lets you verify match data with on-chain proof when available',
    '',
    'Try these commands:',
    '• /predict — get a pick recommendation',
    '• /odds <fixtureId> — view match odds',
    '• /verify <fixtureId> — request proof verification',
    '• /verify-status <fixtureId> — check the bot’s verification setup for that match',
    '• /follow <team> — save a team for future alerts',
    '• /favorites — list your saved teams',
    '• /diagnose — check verify service and local ingestion status',
  ].join('\n');

  await ctx.reply(text, { reply_markup: buildFooterMenu() });
}

async function handleVerifyStatus(ctx) {
  const fixtureIdStr = getVerifyInput(ctx);
  if (!fixtureIdStr || Number.isNaN(Number(fixtureIdStr))) {
    return ctx.reply('Usage: /verify-status <fixtureId>. You can copy a fixture ID from /odds.', { reply_markup: buildFooterMenu() });
  }

  const parts = [];
  const verifyServiceUrl = process.env.VERIFY_SERVICE_URL;
  if (verifyServiceUrl) {
    parts.push('Verify service is configured.');
    const health = await checkVerifyServiceHealth(verifyServiceUrl);
    parts.push(`• Service health: ${health.ok ? 'ok' : `unreachable (${health.error})`}`);
    parts.push(`• VERIFY_SERVICE_TOKEN: ${process.env.VERIFY_SERVICE_TOKEN ? 'present' : 'missing'}`);
  } else {
    parts.push('Verify service is not configured. Set VERIFY_SERVICE_URL and optionally VERIFY_SERVICE_TOKEN.');
  }

  try {
    const { jwt, apiToken } = await getActiveSession();
    parts.push('Local TxODDS session: active.');
    try {
      const proof = await fetchMerkleProof(fixtureIdStr, jwt, apiToken);
      parts.push(`• Proof lookup: available (root ${proof.merkleRoot.slice(0, 12)}...)`);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        parts.push('• Proof lookup: no proof archived yet for that fixture.');
      } else {
        parts.push(`• Proof lookup: unavailable (${err.message})`);
      }
    }
  } catch (err) {
    parts.push(`Local TxODDS session: unavailable (${err.message}).`);
  }

  return ctx.reply(parts.join('\n'), { reply_markup: buildFooterMenu() });
}

async function handleDiagnose(ctx) {
  const parts = [];
  parts.push('Diagnostics summary:');

  if (process.env.VERIFY_SERVICE_URL) {
    const health = await checkVerifyServiceHealth(process.env.VERIFY_SERVICE_URL);
    parts.push(`• Verify service: configured (${health.ok ? 'reachable' : `unreachable: ${health.error}`})`);
    parts.push(`• VERIFY_SERVICE_TOKEN: ${process.env.VERIFY_SERVICE_TOKEN ? 'present' : 'missing'}`);
  } else {
    parts.push('• Verify service: not configured');
  }

  try {
    await getActiveSession();
    parts.push('• Local TxODDS session: active');
  } catch (err) {
    parts.push(`• Local TxODDS session: unavailable (${err.message})`);
  }

  try {
    const { rows } = await pool.query('select count(*)::int as count from fixtures');
    parts.push(`• Fixture data: ${rows[0].count} fixtures in the database`);
  } catch (err) {
    parts.push(`• Fixture data: unavailable (${err.message})`);
  }

  const user = await getOrCreateUser(ctx.from);
  parts.push(`• Favorite alert level: ${user.favorite_alert_level || 'goals_only'}`);

  return ctx.reply(parts.join('\n'), { reply_markup: buildFooterMenu() });
}

async function handleFollow(ctx) {
  const team = getCommandArg(ctx);
  if (!team) {
    return ctx.reply('Usage: /follow <team>. Example: /follow Brazil', { reply_markup: buildFooterMenu() });
  }

  const user = await getOrCreateUser(ctx.from);
  const favorites = user.favorite_teams || [];
  if (favorites.includes(team)) {
    return ctx.reply(`You are already following ${team}.`, { reply_markup: buildFooterMenu() });
  }

  const updated = [...favorites, team];
  await pool.query('update users set favorite_teams = $1 where id = $2', [updated, user.id]);
  return ctx.reply(`Added ${team} to your followed teams. Use /favorites to see them.`, { reply_markup: buildFooterMenu() });
}

async function handleUnfollow(ctx) {
  const team = getCommandArg(ctx);
  if (!team) {
    return ctx.reply('Usage: /unfollow <team>. Example: /unfollow Brazil', { reply_markup: buildFooterMenu() });
  }

  const user = await getOrCreateUser(ctx.from);
  const favorites = user.favorite_teams || [];
  const updated = favorites.filter((t) => t !== team);
  if (updated.length === favorites.length) {
    return ctx.reply(`You were not following ${team}.`, { reply_markup: buildFooterMenu() });
  }

  await pool.query('update users set favorite_teams = $1 where id = $2', [updated, user.id]);
  return ctx.reply(`Removed ${team} from your followed teams.`, { reply_markup: buildFooterMenu() });
}

async function handleFavorites(ctx) {
  const user = await getOrCreateUser(ctx.from);
  const favorites = user.favorite_teams || [];
  if (favorites.length === 0) {
    return ctx.reply('You are not following any teams yet. Use /follow <team> to save one.', { reply_markup: buildFooterMenu() });
  }
  return ctx.reply(
    `Your followed teams:\n• ${favorites.join('\n• ')}\n\nFavorite alert level: ${user.favorite_alert_level || 'goals_only'}`,
    { reply_markup: buildFooterMenu() }
  );
}

async function handleFavoriteAlerts(ctx) {
  const level = getCommandArg(ctx)?.toLowerCase();
  const valid = ['goals_only', 'goals_and_cards', 'all_events'];
  if (!level || !valid.includes(level)) {
    return ctx.reply(
      'Usage: /favorite-alerts <goals_only|goals_and_cards|all_events>\n' +
      'Example: /favorite-alerts goals_and_cards',
      { reply_markup: buildFooterMenu() }
    );
  }

  const user = await getOrCreateUser(ctx.from);
  await pool.query('update users set favorite_alert_level = $1 where id = $2', [level, user.id]);
  return ctx.reply(`Favorite team alerts set to ${level}.`, { reply_markup: buildFooterMenu() });
}

function getCommandArg(ctx) {
  if (!ctx?.message?.text) return null;
  const parts = ctx.message.text.trim().split(/\s+/);
  return parts.slice(1).join(' ').trim() || null;
}

async function checkVerifyServiceHealth(url) {
  try {
    const healthUrl = new URL('/health', url.replace(/\/$/, '')).toString();
    const resp = await axios.get(healthUrl, { timeout: 5000 });
    return { ok: resp.status === 200, error: resp.status === 200 ? null : `status ${resp.status}` };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function handleVerify(ctx) {
  const fixtureIdStr = getVerifyInput(ctx);
  if (!fixtureIdStr || Number.isNaN(Number(fixtureIdStr))) {
    return ctx.reply('Usage: /verify <fixtureId>. Copy a fixture ID from /odds output if you need one.', { reply_markup: buildFooterMenu() });
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

function getOddsInput(ctx) {
  if (!ctx) return null;

  if (ctx.match && typeof ctx.match === 'object' && typeof ctx.match[1] === 'string') {
    return ctx.match[1].trim();
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
  if (!ctx.from) {
    return ctx.reply('Choose an action below, or type /help for guidance.', { reply_markup: buildOnboardingMenu() });
  }

  const user = await getOrCreateUser(ctx.from);
  const wallet = await getWalletForUser(user.id);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'FixtureLineBot';
  const keyboard = wallet ? buildMainMenu({ botUsername }) : buildOnboardingMenu();

  return ctx.reply('Choose an action below, or type /help for guidance.', { reply_markup: keyboard });
}

module.exports = {
  registerMiscHandlers,
  getMenuAction,
  handleLeaderboard,
  handleHelp,
  handleVerify,
  handleMarkets,
  handleOdds,
  handleWalletSetup,
  handleMenu,
  getWalletForUser,
};
