// ingestion/txodds/verify-service.js
// Lightweight HTTP service that exposes a /verify endpoint.
// This file intentionally lives outside the bot process so Anchor and
// other ESM-heavy dependencies can be loaded in an isolated worker.

require('dotenv').config();
const http = require('http');
const axios = require('axios');
const { Pool } = require('pg');

const { verifyFixtureProof } = require('./verify');

const PORT = process.env.VERIFY_SERVICE_PORT || 3001;
const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function jsonResponse(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function fetchProofFromTxline(fixtureId) {
  const { rows } = await pool.query('select jwt, api_token from txodds_session where id = 1');
  if (rows.length === 0) throw new Error('No active TxODDS session available');
  const jwt = rows[0].jwt;
  const apiToken = rows[0].api_token;

  const { data } = await axios.get(`${TXLINE_BASE_URL}/api/fixtures/${fixtureId}/proof`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': apiToken,
    },
    timeout: 15000,
  });

  return data;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/verify') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const txSig = await verifyFixtureProof(payload);
        return jsonResponse(res, 200, { txSig });
      } catch (err) {
        console.error('[verify-service] /verify error:', err?.message || err);
        return jsonResponse(res, 500, { error: err?.message || String(err) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/verify-by-id') {
    // Optional simple bearer token authentication
    const token = process.env.VERIFY_SERVICE_TOKEN;
    if (token) {
      const auth = req.headers['authorization'] || '';
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
        return jsonResponse(res, 401, { error: 'unauthorized' });
      }
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const fixtureId = payload.fixtureId || payload.fixture_id || payload.id;
        if (!fixtureId) return jsonResponse(res, 400, { error: 'missing fixtureId' });

        const proofPayload = await fetchProofFromTxline(String(fixtureId));
        const txSig = await verifyFixtureProof(proofPayload);
        return jsonResponse(res, 200, { txSig });
      } catch (err) {
        console.error('[verify-service] /verify-by-id error:', err?.message || err);
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
