const test = require('node:test');
const assert = require('node:assert/strict');

const modulePath = require.resolve('./prediction-agent');

test('loads prediction-agent without a Groq API key', () => {
  delete process.env.GROQ_API_KEY;
  delete require.cache[modulePath];

  assert.doesNotThrow(() => require('./prediction-agent'));
});
