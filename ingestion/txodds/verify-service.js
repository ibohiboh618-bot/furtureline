// ingestion/txodds/verify-service.js
// Lightweight HTTP service that exposes a /verify endpoint.
// This file intentionally lives outside the bot process so Anchor and
// other ESM-heavy dependencies can be loaded in an isolated worker.

require('dotenv').config();
const http = require('http');
const axios = require('axios');
const { Pool } = require('pg');
const Redis = require('ioredis');

const { verifyFixtureProof } = require('./verify');
const crypto = require('crypto');

// Simple in-memory rate limiter settings; can be backed by Redis
const RATE_LIMIT_WINDOW_MS = Number(process.env.VERIFY_RATE_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.VERIFY_RATE_MAX || 20);
const ipCounters = new Map();

let redisClient = null;
let bullConnection = null;
let verifyQueue = null;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL);
  // separate ioredis instance for bullmq
  bullConnection = new Redis(process.env.REDIS_URL);
  const { Queue, Worker } = require('bullmq');
  verifyQueue = new Queue('verify', { connection: bullConnection });

  // Start a Bull worker to process verification jobs
  const worker = new Worker('verify', async (job) => {
    const fixtureId = job.data.fixtureId;
    try {
      // persist a job row in Postgres for visibility
      await pool.query(
        `insert into verify_jobs (id, fixture_id, status, attempts, created_at, updated_at)
         values ($1, $2, 'pending', 0, now(), now())
         on conflict (id) do nothing`,
        [job.id, String(fixtureId)]
      );

      const proofPayload = await fetchProofFromTxline(String(fixtureId));
      const txSig = await withRetries(() => verifyFixtureProof(proofPayload), 3, 600);

      await pool.query("update verify_jobs set status='done', result = $2, updated_at = now() where id = $1", [job.id, JSON.stringify({ txSig })]);
      console.log('[verify-worker] job', job.id, 'done', txSig);
      return { txSig };
    } catch (err) {
      // increment attempts and mark failed if too many
      const attempts = (job.attempts || 0) + 1;
      const nextStatus = attempts >= 3 ? 'failed' : 'pending';
      await pool.query("update verify_jobs set attempts = $2, status = $3, result = $4, updated_at = now() where id = $1", [job.id, attempts, nextStatus, JSON.stringify({ error: err.message })]);
      console.error('[verify-worker] job', job.id, 'failed', err?.message || err);
      throw err;
    }
  }, { connection: bullConnection });

  worker.on('failed', (job, err) => {
    console.error('[bull-worker] job failed', job.id, err?.message || err);
  });
}

// Rate limiter: prefer Redis when configured
async function isRateLimited(ip) {
  if (redisClient) {
    const key = `verify:rate:${ip}`;
    const tx = redisClient.multi();
    tx.incr(key);
    tx.pexpire(key, RATE_LIMIT_WINDOW_MS);
    const results = await tx.exec();
    const count = Number(results?.[0]?.[1] || 0);
    return count > RATE_LIMIT_MAX;
  }

  const now = Date.now();
  let entry = ipCounters.get(ip);
  if (!entry) {
    entry = { count: 1, start: now };
    ipCounters.set(ip, entry);
    return false;
  }
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.start = now;
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Simple retry helper
async function withRetries(fn, retries = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

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

  // Admin rotate token: POST /rotate-token (Authorization: Bearer <ADMIN_TOKEN>)
  if (req.method === 'POST' && req.url === '/rotate-token') {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) return jsonResponse(res, 403, { error: 'admin_not_configured' });
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== adminToken) return jsonResponse(res, 401, { error: 'unauthorized' });

    // create a new verify token and return it in response. Note: you should
    // copy this token into your secret storage for bot and worker.
    const newToken = crypto.randomBytes(24).toString('hex');
    process.env.VERIFY_SERVICE_TOKEN = newToken;
    console.log('[verify-service] rotated VERIFY_SERVICE_TOKEN (admin)');
    return jsonResponse(res, 200, { verifyToken: newToken });
  }

  // Check job status endpoint: /job-status?id=123
  if (req.method === 'GET' && req.url.startsWith('/job-status')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const id = url.searchParams.get('id');
      if (!id) return jsonResponse(res, 400, { error: 'missing id' });
      // If Redis/Bull is configured, prefer to fetch job status from Bull
      if (verifyQueue && bullConnection) {
        const { Job } = require('bullmq');
        const job = await Job.fromId(bullConnection, 'verify', id).catch(() => null);
        if (job) {
          const state = await job.getState();
          const returnValue = await job.returnvalue;
          return jsonResponse(res, 200, { id: job.id, state, returnValue, attempts: job.attemptsMade });
        }
      }

      const { rows } = await pool.query('select id, status, attempts, result, created_at, updated_at from verify_jobs where id = $1', [id]);
      if (rows.length === 0) return jsonResponse(res, 404, { error: 'not_found' });
      return jsonResponse(res, 200, rows[0]);
    } catch (err) {
      return jsonResponse(res, 500, { error: err?.message || String(err) });
    }
  }

  if (req.method === 'POST' && req.url === '/verify') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const ip = req.socket.remoteAddress || 'unknown';
        if (await isRateLimited(ip)) return jsonResponse(res, 429, { error: 'rate_limited' });

        const txSig = await withRetries(() => verifyFixtureProof(payload), 3, 600);
        return jsonResponse(res, 200, { txSig });
      } catch (err) {
        console.error('[verify-service] /verify error:', err?.message || err);
        const status = err?.statusCode || 500;
        return jsonResponse(res, status >= 400 && status < 600 ? status : 500, { error: err?.message || String(err) });
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

        const ip = req.socket.remoteAddress || 'unknown';
        if (await isRateLimited(ip)) return jsonResponse(res, 429, { error: 'rate_limited' });

        // Queue the verification job to avoid blocking the HTTP request.
        // If caller requests synchronous behavior, they can pass { sync: true }.
        if (payload.sync) {
          const proofPayload = await fetchProofFromTxline(String(fixtureId));
          const txSig = await withRetries(() => verifyFixtureProof(proofPayload), 3, 600);
          return jsonResponse(res, 200, { txSig });
        }

        if (verifyQueue) {
          // enqueue to Bull and also create a DB row for visibility
          const job = await verifyQueue.add('verify-fixture', { fixtureId });
          await pool.query(
            `insert into verify_jobs (id, fixture_id, status, attempts, created_at, updated_at)
             values ($1, $2, 'pending', 0, now(), now())
             on conflict (id) do nothing`,
            [job.id, String(fixtureId)]
          );
          return jsonResponse(res, 202, { jobId: job.id });
        }

        const insert = await pool.query(
          `insert into verify_jobs (fixture_id, status, attempts, created_at, updated_at)
           values ($1, 'pending', 0, now(), now()) returning id`,
          [String(fixtureId)]
        );
        const jobId = insert.rows[0].id;
        return jsonResponse(res, 202, { jobId });
      } catch (err) {
        console.error('[verify-service] /verify-by-id error:', err?.message || err);
        const status = err?.statusCode || 500;
        return jsonResponse(res, status >= 400 && status < 600 ? status : 500, { error: err?.message || String(err) });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`verify-service listening on port ${PORT}`);
  // Initialize DB-backed job table and start background worker
  (async function setupQueue() {
    try {
      await pool.query(`
        create table if not exists verify_jobs (
          id serial primary key,
          fixture_id text not null,
          status varchar(20) not null default 'pending',
          attempts integer not null default 0,
          result jsonb,
          created_at timestamptz default now(),
          updated_at timestamptz default now()
        )
      `);

      const POLL_INTERVAL_MS = Number(process.env.VERIFY_POLL_INTERVAL_MS || 5000);
      setInterval(async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const { rows } = await client.query("select * from verify_jobs where status = 'pending' order by created_at asc limit 1 for update skip locked");
          if (rows.length === 0) {
            await client.query('commit');
            client.release();
            return;
          }
          const job = rows[0];
          await client.query("update verify_jobs set status = 'in_progress', updated_at = now() where id = $1", [job.id]);
          await client.query('commit');
          client.release();

          try {
            const proofPayload = await fetchProofFromTxline(String(job.fixture_id));
            const txSig = await withRetries(() => verifyFixtureProof(proofPayload), 3, 600);
            await pool.query("update verify_jobs set status='done', result = $2, updated_at = now() where id = $1", [job.id, JSON.stringify({ txSig })]);
            console.log('[verify-worker] job', job.id, 'done', txSig);
          } catch (err) {
            const attempts = job.attempts + 1;
            const nextStatus = attempts >= 3 ? 'failed' : 'pending';
            await pool.query("update verify_jobs set attempts = $2, status = $3, result = $4, updated_at = now() where id = $1", [job.id, attempts, nextStatus, JSON.stringify({ error: err.message })]);
            console.error('[verify-worker] job', job.id, 'failed attempt', attempts, err?.message || err);
          }
        } catch (err) {
          try { client.release(); } catch (e) {}
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      console.error('[verify-service] setupQueue error', err);
    }
  })();
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException in verify-service:', err);
  process.exit(1);
});
