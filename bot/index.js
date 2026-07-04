// bot/index.js
//
// Entrypoint for the Telegram bot process. Run this separately from the
// ingestion workers (odds-listener, score-listener) -- see /README.md for
// the full process layout and why they're split.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Bot } = require('grammy');
const express = require('express');
const { webhookCallback } = require('grammy');

const { registerPredictHandlers, getOrCreateUser } = require('./handlers/predict');
const { registerGroupHandlers } = require('./handlers/groups');
const { registerMiscHandlers, getWalletForUser } = require('./handlers/misc');
const broadcastQueue = require('./broadcast-queue');
const settlement = require('./settlement');
const { buildOnboardingMenu, buildStartCarouselContent, buildMainMenu } = require('./ui');

function assertEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
}

assertEnv('TELEGRAM_BOT_TOKEN');
assertEnv('DATABASE_URL');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.command('start', async (ctx) => {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'FixtureLineBot';
  const content = buildStartCarouselContent({
    title: 'FixtureLine is a live football intelligence bot for fans who want match odds, picks, and proof.',
    quickStart: 'Start by creating a transaction pin with /wallet <6-digit-pin>. That pin unlocks wallet settings later, while the private key stays hidden until you enter the pin in /settings.',
    commands: [
      '⚡ /predict <what you are after> — get AI-suggested picks',
      '📌 /mypicks — review your active and recent picks',
      '🏆 /leaderboard — see the top players by points',
      '🔎 /verify <fixtureId> — validate a match with on-chain proof',
      '🔐 /wallet <6-digit-pin> — create your wallet and transaction pin',
      '🛡️ /settings <6-digit-pin> — unlock wallet export details',
      '📋 /menu — open the shortcut keyboard',
    ],
    footer: 'After the wallet is created, the prediction flow stays the same: ask for a pick, confirm it, and let settlement and proof tracking handle the rest.',
  });

  let keyboard = buildOnboardingMenu();
  if (ctx.from) {
    const user = await getOrCreateUser(ctx.from);
    const wallet = await getWalletForUser(user.id);
    if (wallet) {
      keyboard = buildMainMenu({ botUsername });
    }
  }

  await ctx.reply(content.text, {
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });
});

registerPredictHandlers(bot);
registerGroupHandlers(bot);
registerMiscHandlers(bot);

bot.catch((err) => {
  console.error('[bot] unhandled error:', err.error ?? err);
});

async function startPolling() {
  const retryCount = 2;
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`[bot] polling attempt ${attempt}/${retryCount}...`);
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await bot.start();
      return;
    } catch (e) {
      const message = (e && e.message) ? e.message : String(e);
      const isConflict = message.includes('terminated by other getUpdates request');
      console.warn('[bot] polling startup failed:', message);
      if (!isConflict || attempt === retryCount) {
        throw e;
      }
      console.warn('[bot] detected stale getUpdates session; retrying after delay...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  try {
    broadcastQueue.init(bot);
    settlement.start();

    const mode = (process.env.TELEGRAM_MODE || 'polling').toLowerCase();
    if (mode === 'webhook') {
      const strict = (process.env.TELEGRAM_STRICT_WEBHOOK || '').toLowerCase() === 'true';
      let webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();

      if (!webhookUrl) {
        if (!strict) {
          console.warn('[bot] TELEGRAM_WEBHOOK_URL is missing; falling back to long polling');
          await startPolling();
          return;
        }
        throw new Error('TELEGRAM_WEBHOOK_URL required when TELEGRAM_MODE=webhook');
      }

      // basic validation: must be an https URL
      try {
        const u = new URL(webhookUrl);
        if (u.protocol !== 'https:') throw new Error('webhook URL must use https');
      } catch (e) {
        if (!strict) {
          console.warn('[bot] Invalid TELEGRAM_WEBHOOK_URL:', e.message);
          console.warn('[bot] falling back to long polling (TELEGRAM_STRICT_WEBHOOK is not set)');
          await startPolling();
          return;
        }
        throw new Error(`Invalid TELEGRAM_WEBHOOK_URL: ${e.message}`);
      }

      console.log('[bot] starting in webhook mode...');

      try {
        await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
      } catch (e) {
        console.error('[bot] setWebhook failed:', e.message || e);
        if (!strict) {
          console.warn('[bot] falling back to long polling (TELEGRAM_STRICT_WEBHOOK is not set)');
          console.warn('[bot] NOTE: consider fixing TELEGRAM_WEBHOOK_URL or set TELEGRAM_STRICT_WEBHOOK=true to fail fast');
          await startPolling();
          return;
        }
        throw e;
      }

      const app = express();
      app.use(express.json());
      app.post('/telegram-webhook', webhookCallback(bot, 'express'));
      app.get('/', (req, res) => res.send('ok'));

      const port = process.env.PORT || 3000;
      app.listen(port, () => console.log(`[bot] webhook listening on ${port}`));
    } else {
      await startPolling();
    }
  } catch (err) {
    console.error('[bot] startup failed:', err.message);
    console.error('[bot] If the bot token is in use by another process, stop that process or use a different bot token.');
    process.exit(1);
  }
}

main();
