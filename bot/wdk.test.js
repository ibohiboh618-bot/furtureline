const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettlementEnvelope } = require('./wdk');

test('createSettlementEnvelope returns a signed settlement envelope', () => {
  const envelope = createSettlementEnvelope({
    prediction: { id: 'pred-1', market: '1X2', selection: 'HOME' },
    fixture: { id: 101, home_team: 'A', away_team: 'B' },
    outcome: 'won',
    pointsAwarded: 90,
  });

  assert.equal(envelope.kind, 'settlement');
  assert.equal(envelope.status, 'prepared');
  assert.match(envelope.payloadHash, /^[a-f0-9]{64}$/);
  assert.match(envelope.signature, /^[a-f0-9]{64}$/);
  assert.equal(envelope.signer, 'wdk-local-adapter');
});
