// bot/wdk.js
// Lightweight WDK adapter for the current bot flow.
// The goal is not to implement a full wallet stack here; it is to provide a
// deterministic settlement envelope that the bot can persist and later use as
// proof or audit data when a wallet/signing layer is enabled.

const crypto = require('node:crypto');

function createSettlementEnvelope({ prediction, fixture, outcome, pointsAwarded }) {
  const payload = {
    kind: 'settlement',
    predictionId: prediction.id,
    fixtureId: fixture.id,
    market: prediction.market,
    selection: prediction.selection,
    outcome,
    pointsAwarded,
    fixtureLabel: `${fixture.home_team} vs ${fixture.away_team}`,
  };

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const signature = crypto.createHash('sha256').update(`${payloadHash}:${process.env.WDK_SIGNER_SECRET || 'fixtureline-dev'}`).digest('hex');

  return {
    kind: 'settlement',
    status: 'prepared',
    signer: 'wdk-local-adapter',
    payloadHash,
    signature,
    payload,
  };
}

module.exports = { createSettlementEnvelope };
