/**
 * scripts/verify-settlement.js
 * Unit tests to verify multi-market settlement logic.
 * Run with: node scripts/verify-settlement.js
 */

const { resolveOutcome } = require('../bot/settlement');

const testCases = [
  // --- 1X2 Market ---
  {
    name: '1X2 HOME wins - Home prediction won',
    prediction: { market: '1X2', selection: 'HOME' },
    fixture: { home_score: 3, away_score: 1 },
    expected: 'won'
  },
  {
    name: '1X2 HOME wins - Away prediction lost',
    prediction: { market: '1X2', selection: 'AWAY' },
    fixture: { home_score: 3, away_score: 1 },
    expected: 'lost'
  },
  {
    name: '1X2 DRAW wins - Draw prediction won',
    prediction: { market: '1X2', selection: 'DRAW' },
    fixture: { home_score: 2, away_score: 2 },
    expected: 'won'
  },
  {
    name: '1X2 DRAW wins - Home prediction lost',
    prediction: { market: '1X2', selection: 'HOME' },
    fixture: { home_score: 2, away_score: 2 },
    expected: 'lost'
  },
  {
    name: '1X2 AWAY wins - Away prediction won',
    prediction: { market: '1X2', selection: 'AWAY' },
    fixture: { home_score: 0, away_score: 1 },
    expected: 'won'
  },

  // --- BTTS Market ---
  {
    name: 'BTTS Yes - Both scored (2-1) - Yes prediction won',
    prediction: { market: 'BTTS', selection: 'YES' },
    fixture: { home_score: 2, away_score: 1 },
    expected: 'won'
  },
  {
    name: 'BTTS Yes - Both scored (2-1) - No prediction lost',
    prediction: { market: 'BTTS', selection: 'NO' },
    fixture: { home_score: 2, away_score: 1 },
    expected: 'lost'
  },
  {
    name: 'BTTS No - Only home scored (1-0) - No prediction won',
    prediction: { market: 'BTTS', selection: 'NO' },
    fixture: { home_score: 1, away_score: 0 },
    expected: 'won'
  },
  {
    name: 'BTTS No - Neither scored (0-0) - No prediction won',
    prediction: { market: 'BTTS', selection: 'NO' },
    fixture: { home_score: 0, away_score: 0 },
    expected: 'won'
  },
  {
    name: 'BTTS No - Neither scored (0-0) - Yes prediction lost',
    prediction: { market: 'BTTS', selection: 'YES' },
    fixture: { home_score: 0, away_score: 0 },
    expected: 'lost'
  },

  // --- OU_2_5 Market ---
  {
    name: 'OU_2_5 Over - 3 goals (2-1) - Over prediction won',
    prediction: { market: 'OU_2_5', selection: 'OVER' },
    fixture: { home_score: 2, away_score: 1 },
    expected: 'won'
  },
  {
    name: 'OU_2_5 Over - 3 goals (2-1) - Under prediction lost',
    prediction: { market: 'OU_2_5', selection: 'UNDER' },
    fixture: { home_score: 2, away_score: 1 },
    expected: 'lost'
  },
  {
    name: 'OU_2_5 Under - 2 goals (1-1) - Under prediction won',
    prediction: { market: 'OU_2_5', selection: 'UNDER' },
    fixture: { home_score: 1, away_score: 1 },
    expected: 'won'
  },
  {
    name: 'OU_2_5 Under - 2 goals (1-1) - Over prediction lost',
    prediction: { market: 'OU_2_5', selection: 'OVER' },
    fixture: { home_score: 1, away_score: 1 },
    expected: 'lost'
  },

  // --- OU_0_5 Market ---
  {
    name: 'OU_0_5 Over - 1 goal (1-0) - Over prediction won',
    prediction: { market: 'OU_0_5', selection: 'OVER' },
    fixture: { home_score: 1, away_score: 0 },
    expected: 'won'
  },
  {
    name: 'OU_0_5 Under - 0 goals (0-0) - Under prediction won',
    prediction: { market: 'OU_0_5', selection: 'UNDER' },
    fixture: { home_score: 0, away_score: 0 },
    expected: 'won'
  },

  // --- Error/Void Cases ---
  {
    name: 'Null score returns void',
    prediction: { market: '1X2', selection: 'HOME' },
    fixture: { home_score: null, away_score: null },
    expected: 'void'
  },
  {
    name: 'Unsupported market returns void',
    prediction: { market: 'DOUBLE_CHANCE', selection: 'HOME_DRAW' },
    fixture: { home_score: 2, away_score: 1 },
    expected: 'void'
  }
];

let failed = 0;

console.log('🧪 Running settlement resolution tests...');

for (const tc of testCases) {
  const outcome = resolveOutcome(tc.prediction, tc.fixture);
  if (outcome === tc.expected) {
    console.log(`✅ PASS: ${tc.name}`);
  } else {
    console.error(`❌ FAIL: ${tc.name}`);
    console.error(`   Expected: ${tc.expected}, Got: ${outcome}`);
    failed++;
  }
}

console.log('\n----------------------------------------');
if (failed === 0) {
  console.log('🎉 All settlement tests passed!');
  process.exit(0);
} else {
  console.error(`🚨 ${failed} settlement tests failed.`);
  process.exit(1);
}
