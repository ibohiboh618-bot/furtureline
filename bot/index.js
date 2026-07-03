// bot/index.js
//
// Entrypoint for the Telegram bot process. Run this separately from the
// ingestion workers (odds-listener, score-listener) -- see /README.md for
// the full process layout and why they're split.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Bot } = require('grammy');
const express = require('express');
const { webhookCallback } = require('grammy');

const { registerPredictHandlers } = require('./handlers/predict');
const { registerGroupHandlers } = require('./handlers/groups');
const { registerMiscHandlers } = require('./handlers/misc');
const broadcastQueue = require('./broadcast-queue');
const settlement = require('./settlement');
const { buildMainMenu, buildStartCarouselContent } = require('./ui');

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
    quickStart: 'I can show you upcoming fixtures, live market odds, AI-assisted picks, and on-chain verification options.',
    commands: [
      '⚡ /predict <what you are after> — get AI-suggested picks',
      '📌 /mypicks — review your active and recent picks',
      '🏆 /leaderboard — see the top players by points',
      '🔎 /verify <fixtureId> — validate a match with on-chain proof',
      '📋 /menu — open the shortcut keyboard',
    ],
    footer: 'Add me to a group or channel for live alerts, market updates, and match proof.',
  });
  await ctx.reply(content.text, {
    reply_markup: buildMainMenu({ botUsername }),
    disable_web_page_preview: true,
  });
});

registerPredictHandlers(bot);
registerGroupHandlers(bot);
registerMiscHandlers(bot);

bot.catch((err) => {
  console.error('[bot] unhandled error:', err.error ?? err);
});

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
          console.log('[bot] starting long polling...');
          await bot.start();
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
          console.log('[bot] starting long polling...');
          await bot.start();
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
          console.log('[bot] starting long polling...');
          await bot.start();
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
      console.log('[bot] starting long polling...');
      await bot.start();
    }
  } catch (err) {
    console.error('[bot] startup failed:', err.message);
    process.exit(1);
  }
}

main();
