// bot/pear.js
// Lightweight Pear adapter for state sync and runtime coordination.
// This keeps the bot's distributed-state concerns explicit without requiring a
// separate service at this stage.

const crypto = require('node:crypto');

function createRuntimeProof({ eventType, entityId, payload }) {
  const content = JSON.stringify({ eventType, entityId, payload, createdAt: new Date().toISOString() });
  return {
    kind: 'runtime-proof',
    eventType,
    entityId,
    proofHash: crypto.createHash('sha256').update(content).digest('hex'),
    payload,
  };
}

module.exports = { createRuntimeProof };
