const test = require('node:test');
const assert = require('node:assert/strict');
const { formatInsightsText } = require('./market-insights');

test('formats a compact market summary for upcoming fixtures', () => {
  const text = formatInsightsText([
    {
      homeTeam: 'Brazil',
      awayTeam: 'Argentina',
      odds: [
        { market: '1X2', selection: 'HOME', impliedProb: 0.58 },
        { market: 'BTTS', selection: 'YES', impliedProb: 0.45 },
      ],
    },
  ]);

  assert.match(text, /Brazil vs Argentina/);
  assert.match(text, /1X2/);
  assert.match(text, /BTTS/);
});

test('returns a fallback message when no fixtures are available', () => {
  assert.match(formatInsightsText([]), /No upcoming market data/);
});
