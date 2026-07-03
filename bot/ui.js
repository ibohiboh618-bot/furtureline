const { InlineKeyboard } = require('grammy');

function buildMainMenu({ botUsername = 'FixtureLineBot' } = {}) {
  const keyboard = new InlineKeyboard()
    .text('Predict', 'menu:predict')
    .text('Markets', 'menu:markets')
    .row()
    .text('My Picks', 'menu:mypicks')
    .text('Verify', 'menu:verify')
    .row()
    .text('Leaderboard', 'menu:leaderboard')
    .text('Live odds', 'menu:odds')
    .row()
    .text('How it works', 'menu:help')
    .row()
    .url('Add to group', `https://t.me/${botUsername}?startgroup=fixtureline`)
    .url('Add to channel', `https://t.me/${botUsername}?startchannel=fixtureline`);

  return keyboard;
}

function buildFooterMenu() {
  return new InlineKeyboard()
    .text('Predict', 'menu:predict')
    .text('Markets', 'menu:markets')
    .row()
    .text('My Picks', 'menu:mypicks')
    .text('Verify', 'menu:verify')
    .row()
    .text('Leaderboard', 'menu:leaderboard')
    .text('Live odds', 'menu:odds')
    .row()
    .text('Help', 'menu:help');
}

function buildStartCarouselContent({ title = 'Welcome to FixtureLine.', quickStart = null, commands = [], footer = 'Add me to a group or channel to get live goal alerts.' } = {}) {
  const lines = [
    title,
  ];

  if (quickStart) {
    lines.push('', quickStart);
  }

  lines.push('', ...commands, '', footer, '', 'Tap a button below to start, or type /help for details.');

  return {
    text: lines.join('\n'),
    reply_markup: buildFooterMenu(),
  };
}

function buildGroupOnboardingMessage({ chatType = 'group' } = {}) {
  const isChannel = chatType === 'channel';
  const headline = isChannel ? 'FixtureLine is ready for this channel.' : 'FixtureLine is ready in this group.';
  const body = [
    headline,
    '',
    'Use /odds to list upcoming fixtures and copy the fixture ID for /verify or /odds.',
    'Admins can change alert intensity with /alertlevel: goals_only, goals_and_cards, all_events.',
    'Press Live odds to see the next matches with market pricing and pick context.',
    '',
    isChannel
      ? 'Use me in a channel to broadcast alerts and live-match updates to your audience.'
      : 'Add the bot to a channel too for a cleaner live match feed.',
  ];

  return { text: body.join('\n') };
}

function buildGroupAdminGuide() {
  const keyboard = new InlineKeyboard()
    .text('Alert levels', 'group:alertlevel')
    .text('Live odds', 'group:odds')
    .row()
    .text('How it works', 'group:help');

  return keyboard;
}

function getAutoDeleteMs({ chatType, kind }) {
  if (kind === 'onboarding') {
    return chatType === 'channel' ? 0 : 5 * 60 * 1000;
  }

  if (kind === 'alert') {
    return chatType === 'channel' ? 0 : 3 * 60 * 1000;
  }

  return 0;
}

module.exports = {
  buildMainMenu,
  buildFooterMenu,
  buildStartCarouselContent,
  buildGroupOnboardingMessage,
  buildGroupAdminGuide,
  getAutoDeleteMs,
};
