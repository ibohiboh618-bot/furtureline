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
    .text('How it works', 'menu:help')
    .row()
    .url('Add to group', `https://t.me/${botUsername}?startgroup=fixtureline`)
    .url('Add to channel', `https://t.me/${botUsername}?startchannel=fixtureline`);

  return keyboard;
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
    reply_markup: buildMainMenu(),
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
    '',
    isChannel
      ? 'Use it to broadcast match moments, market flashes, and updates to your audience.'
      : 'Tip: add the bot to a channel too for the same live-match flow.',
  ];

  return { text: body.join('\n') };
}

function buildGroupAdminGuide() {
  const keyboard = new InlineKeyboard()
    .text('Alert levels', 'group:alertlevel')
    .text('How it works', 'menu:help');

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
  buildStartCarouselContent,
  buildGroupOnboardingMessage,
  buildGroupAdminGuide,
  getAutoDeleteMs,
};
