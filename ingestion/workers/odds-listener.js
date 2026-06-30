// ingestion/workers/odds-listener.js
//
// Long-running worker: connects to the TxODDS odds SSE stream and writes
// normalized rows into odds_snapshots. Run this as its own process
// (separate from the bot) so a bot restart never drops live data, and a
// data hiccup never takes down the bot.

require('dotenv').config();
const { Pool } = require('pg');
const { connectStream } = require('../txodds/sse-client');
const { normalizeOddsPayload } = require('../txodds/normalize');
const { getCredentials, forceRefresh } = require('./session-keeper');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const INSERT_SQL = `
  insert into odds_snapshots
    (fixture_id, market, selection, implied_prob, captured_at, source_message_id)
  values ($1, $2, $3, $4, $5, $6)
`;

async function persist(rows) {
  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const row of rows) {
      await client.query(INSERT_SQL, [
        row.fixtureId,
        row.market,
        row.selection,
        row.impliedProb,
        row.capturedAt,
        row.sourceMessageId,
      ]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('[odds-listener] failed to persist batch:', err.message);
  } finally {
    client.release();
  }
}

function start() {
  console.log('[odds-listener] starting...');

  let consecutiveAuthFailures = 0;

  const stop = connectStream({
    stream: 'odds',
    getCredentials: async () => {
      try {
        const creds = await getCredentials();
        consecutiveAuthFailures = 0;
        return creds;
      } catch (err) {
        consecutiveAuthFailures += 1;
        if (consecutiveAuthFailures >= 2) {
          // getCredentials() itself is failing repeatedly -- force a hard
          // refresh rather than retrying the same stale path.
          console.warn('[odds-listener] forcing session refresh after repeated auth failures');
          return forceRefresh();
        }
        throw err;
      }
    },
    onEvent: async (payload) => {
      const rows = normalizeOddsPayload(payload);
      await persist(rows);
    },
    onError: (err) => {
      console.error('[odds-listener]', err.message);
    },
  });

  process.on('SIGTERM', () => {
    console.log('[odds-listener] shutting down');
    stop();
    pool.end();
  });
}

if (require.main === module) {
  start();
}

module.exports = { start };
