// ingestion/txodds/verify-service.js
// Lightweight HTTP service that exposes a /verify endpoint.
// This file intentionally lives outside the bot process so Anchor and
// other ESM-heavy dependencies can be loaded in an isolated worker.

require('dotenv').config();
const http = require('http');

const { verifyFixtureProof } = require('./verify');

const PORT = process.env.VERIFY_SERVICE_PORT || 3001;

function jsonResponse(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/verify') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        // The verify module expects the proof payload object from TxLINE
        const txSig = await verifyFixtureProof(payload);
        return jsonResponse(res, 200, { txSig });
      } catch (err) {
        console.error('[verify-service] error:', err?.message || err);
        return jsonResponse(res, 500, { error: err?.message || String(err) });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`verify-service listening on port ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException in verify-service:', err);
  process.exit(1);
});
