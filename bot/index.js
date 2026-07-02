// bot/index.js
//
// Entrypoint for the Telegram bot process. Run this separately from the
// ingestion workers (odds-listener, score-listener) -- see /README.md for
// the full process layout and why they're split.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Bot } = require('grammy');

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
  const content = buildStartCarouselContent({
    title: 'Welcome to FixtureLine — your live football intelligence hub.',
    quickStart: 'Ready to make a pick? Tap Predict or type /predict now.',
    commands: [
      '⚡ /predict <what you are after> — get AI-suggested picks',
      '📌 /mypicks — review your active and recent picks',
      '🏆 /leaderboard — see the top players by points',
      '🔎 /verify <fixtureId> — validate a match with on-chain proof',
    ],
    footer: 'Add me to a group or channel for live goal alerts and match edge highlights.',
  });
  await ctx.reply(content.text, {
    reply_markup: content.reply_markup,
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

    console.log('[bot] starting long polling...');
    await bot.start();
  } catch (err) {
    console.error('[bot] startup failed:', err.message);
    process.exit(1);
  }
}

main();
