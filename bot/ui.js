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

  lines.push('', ...commands, '', footer, '', 'Tap a button below to get started.');

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
    'Admins can choose the alert intensity with /alertlevel.',
    'Options: goals_only, goals_and_cards, or all_events.',
    'Use /odds to see live market snapshots and the latest betting lines for matches.',
    '',
    isChannel
      ? 'Use it to broadcast match moments, market flashes, and odds updates to your audience.'
      : 'Tip: add the bot to a channel too for the same live-match flow.',
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
