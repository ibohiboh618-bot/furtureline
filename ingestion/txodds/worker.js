// ingestion/txodds/worker.js
// Dedicated BullMQ worker process for processing verify jobs.
require('dotenv').config();
const Redis = require('ioredis');
const { Worker } = require('bullmq');
const axios = require('axios');
const { Pool } = require('pg');
const { verifyFixtureProof } = require('./verify');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bullRedis = new Redis(process.env.REDIS_URL);

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

async function fetchProofFromTxline(fixtureId) {
  const { rows } = await pool.query('select jwt, api_token from txodds_session where id = 1');
  if (rows.length === 0) throw new Error('No active TxODDS session available');
  const jwt = rows[0].jwt;
  const apiToken = rows[0].api_token;

  const { data } = await axios.get(`${process.env.TXLINE_BASE_URL || 'https://txline.txodds.com'}/api/fixtures/${fixtureId}/proof`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': apiToken,
    },
    timeout: 15000,
  });

  return data;
}

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is required to run the BullMQ worker');
  process.exit(1);
}

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
    const attempts = (job.attemptsMade || 0) + 1;
    const nextStatus = attempts >= 3 ? 'failed' : 'pending';
    try {
      await pool.query("update verify_jobs set attempts = $2, status = $3, result = $4, updated_at = now() where id = $1", [job.id, attempts, nextStatus, JSON.stringify({ error: err.message })]);
    } catch (e) {
      console.error('failed to update verify_jobs state', e?.message || e);
    }
    console.error('[verify-worker] job', job.id, 'failed', err?.message || err);
    throw err;
  }
}, { connection: bullRedis });

worker.on('completed', (job, returnvalue) => {
  console.log('[worker] completed', job.id, returnvalue);
});

worker.on('failed', (job, err) => {
  console.error('[worker] failed', job.id, err?.message || err);
});

console.log('verify-worker started, connected to Redis');

process.on('uncaughtException', (err) => {
  console.error('uncaughtException in verify-worker:', err);
  process.exit(1);
});
