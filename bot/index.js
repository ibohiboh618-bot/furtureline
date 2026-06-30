// bot/index.js
//
// Entrypoint for the Telegram bot process. Run this separately from the
// ingestion workers (odds-listener, score-listener) -- see /README.md for
// the full process layout and why they're split.

require('dotenv').config();
const { Bot } = require('grammy');

const { registerPredictHandlers } = require('./handlers/predict');
const { registerGroupHandlers } = require('./handlers/groups');
const { registerMiscHandlers } = require('./handlers/misc');
const broadcastQueue = require('./broadcast-queue');
const settlement = require('./settlement');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.command('start', (ctx) =>
  ctx.reply(
    'Welcome to FixtureLine.\n\n' +
    '/predict <what you are after> -- get AI-suggested picks\n' +
    '/mypicks -- your recent picks\n' +
    '/leaderboard -- top players by points\n' +
    '/verify <fixtureId> -- check a match\'s on-chain proof\n\n' +
    'Add me to a group or channel to get live goal alerts.'
  )
);

registerPredictHandlers(bot);
registerGroupHandlers(bot);
registerMiscHandlers(bot);

bot.catch((err) => {
  console.error('[bot] unhandled error:', err.error ?? err);
});

async function main() {
  broadcastQueue.init(bot);
  settlement.start();

  console.log('[bot] starting long polling...');
  await bot.start();
}

main();
