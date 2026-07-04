const { InlineKeyboard } = require('grammy');

function buildMainMenu({ botUsername = 'FixtureLineBot' } = {}) {
  const keyboard = new InlineKeyboard()
    .text('Predict', 'menu:predict')
    .text('Markets', 'menu:markets')
    .row()
    .text('My Picks', 'menu:mypicks')
    .text('Verify', 'menu:verify')
    .row()
    .text('Wallet', 'menu:wallet')
    .text('Settings', 'menu:settings')
    .row()
    .text('Leaderboard', 'menu:leaderboard')
    .text('Live odds', 'menu:odds')
    .row()
    .text('How it works', 'menu:help')
    .text('About', 'menu:about')
    .row()
    .text('Diagnostics', 'menu:diagnose')
    .row()
    .url('Add to group', `https://t.me/${botUsername}?startgroup=fixtureline`)
    .url('Add to channel', `https://t.me/${botUsername}?startchannel=fixtureline`);

  return keyboard;
}

function buildOnboardingMenu() {
  return new InlineKeyboard().text('Create wallet', 'menu:wallet');
}

function buildFooterMenu(hasWallet = true) {
  const keyboard = new InlineKeyboard()
    .text('Predict', 'menu:predict')
    .text('Markets', 'menu:markets')
    .row();

  if (hasWallet) {
    keyboard.text('My Picks', 'menu:mypicks');
  } else {
    keyboard.text('Wallet', 'menu:wallet');
  }

  keyboard.text('Verify', 'menu:verify')
    .row()
    .text('Leaderboard', 'menu:leaderboard')
    .text('Live odds', 'menu:odds')
    .row()
    .text('About', 'menu:about')
    .text('Diagnostics', 'menu:diagnose');

  return keyboard;
}

function buildStartCarouselContent({ title = 'Welcome to FixtureLine.', quickStart = null, commands = [], footer = 'Add me to a group or channel to get live goal alerts.' } = {}) {
  const lines = [
    title,
  ];

  if (quickStart) {
    lines.push('', quickStart);
  }

  lines.push('', ...commands, '', footer, '', 'Use the buttons below to get started, or type /help for a quick guide.');

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
    'FixtureLine sends match alerts, live betting odds, and verification guidance into this chat.',
    'Admins can set alert intensity with /alertlevel goals_only | goals_and_cards | all_events.',
    'Any member can use /odds to list upcoming fixtures and copy a fixture ID.',
    'Use /follow <team> to save a favorite team for future alerts.',
    'Then use /verify <fixtureId> to check match data with on-chain proof when available.',
    '',
    isChannel
      ? 'This channel can broadcast alerts and live-match updates cleanly to your audience.'
      : 'Use /help anytime for a short guide to all commands and buttons.',
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
  buildOnboardingMenu,
  buildStartCarouselContent,
  buildGroupOnboardingMessage,
  buildGroupAdminGuide,
  getAutoDeleteMs,
};
