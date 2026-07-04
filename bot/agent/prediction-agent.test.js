const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const modulePath = require.resolve('./prediction-agent');

test('loads prediction-agent and references the QVAC SDK', () => {
  delete require.cache[modulePath];

  const source = fs.readFileSync(modulePath, 'utf8');

  assert.doesNotThrow(() => require('./prediction-agent'));
  assert.match(source, /@qvac\/sdk/);
});
