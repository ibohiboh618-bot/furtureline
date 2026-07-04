const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const modulePath = require.resolve('./prediction-agent');
const { buildFallbackPicks } = require('./prediction-agent');

test('loads prediction-agent and references the QVAC SDK', () => {
  delete require.cache[modulePath];

  const source = fs.readFileSync(modulePath, 'utf8');

  assert.doesNotThrow(() => require('./prediction-agent'));
  assert.match(source, /@qvac\/sdk/);
});

test('buildFallbackPicks returns low-risk suggestions from fixture odds', () => {
  const picks = buildFallbackPicks({
    fixtures: [
      {
        fixtureId: 101,
        homeTeam: 'Brazil',
        awayTeam: 'Argentina',
        odds: [
          { market: '1X2', selection: 'HOME', impliedProb: 0.62 },
          { market: '1X2', selection: 'DRAW', impliedProb: 0.2 },
          { market: '1X2', selection: 'AWAY', impliedProb: 0.18 },
        ],
      },
    ],
    preferenceText: 'I like low risk picks',
    riskPreference: 'low',
    favoriteTeams: ['Brazil'],
  });

  assert.equal(picks.length, 1);
  assert.equal(picks[0].fixtureId, 101);
  assert.equal(picks[0].selection, 'HOME');
});
