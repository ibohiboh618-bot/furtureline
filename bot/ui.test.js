const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMainMenu, buildStartCarouselContent, buildGroupOnboardingMessage } = require('./ui');

test('buildMainMenu includes add-to-group and add-to-channel actions', () => {
  const keyboard = buildMainMenu({ botUsername: 'FixtureLineBot' });
  const urls = keyboard.inline_keyboard.flat().filter((btn) => btn.url).map((btn) => btn.url);

  assert.ok(urls.includes('https://t.me/FixtureLineBot?startgroup=fixtureline'));
  assert.ok(urls.includes('https://t.me/FixtureLineBot?startchannel=fixtureline'));
});

test('buildStartCarouselContent returns a featured-match card for the welcome flow', () => {
  const content = buildStartCarouselContent({ step: 3, featuredFixture: { home_team: 'Brazil', away_team: 'Argentina' } });

  assert.match(content.text, /Featured match/i);
  assert.match(content.text, /Brazil/i);
  assert.match(content.text, /Argentina/i);
});

test('buildGroupOnboardingMessage includes branded guidance for groups and channels', () => {
  const message = buildGroupOnboardingMessage({ chatType: 'group' });

  assert.match(message.text, /FixtureLine is ready/i);
  assert.match(message.text, /goals_only/i);
});
