// ingestion/workers/score-listener.js
//
// Long-running worker: connects to the TxODDS scores SSE stream, writes
// normalized score_events, keeps the fixtures table's running score in
// sync, and enqueues a broadcast job for the bot to pick up. This worker
// never talks to Telegram directly -- it only writes to Postgres. The bot
// process polls/queues from there (see bot/broadcast-queue.js), which
// keeps the rate-limit logic in one place instead of duplicated here.

const { Pool } = require('pg');
const { connectStream } = require('../txodds/sse-client');
const { normalizeScoreEvent } = require('../txodds/normalize');
const { getCredentials, forceRefresh } = require('./session-keeper');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function persistEvent(event) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    await client.query(
      `insert into score_events (fixture_id, event_type, minute, team, description, occurred_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [event.fixtureId, event.eventType, event.minute, event.team, event.description, event.occurredAt]
    );

    if (event.eventType === 'goal' && event.team) {
      const column = event.team === 'home' ? 'home_score' : 'away_score';
      await client.query(
        `update fixtures set ${column} = coalesce(${column}, 0) + 1, last_synced_at = now()
         where id = $1`,
        [event.fixtureId]
      );
    }

    if (event.eventType === 'kickoff') {
      await client.query(
        `update fixtures set status = 'live', last_synced_at = now() where id = $1`,
        [event.fixtureId]
      );
    }

    if (event.eventType === 'full_time') {
      await client.query(
        `update fixtures set status = 'finished', last_synced_at = now() where id = $1`,
        [event.fixtureId]
      );
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('[score-listener] failed to persist event:', err.message);
  } finally {
    client.release();
  }
}

function start() {
  console.log('[score-listener] starting...');

  let consecutiveAuthFailures = 0;

  const stop = connectStream({
    stream: 'scores',
    getCredentials: async () => {
      try {
        const creds = await getCredentials();
        consecutiveAuthFailures = 0;
        return creds;
      } catch (err) {
        consecutiveAuthFailures += 1;
        if (consecutiveAuthFailures >= 2) {
          console.warn('[score-listener] forcing session refresh after repeated auth failures');
          return forceRefresh();
        }
        throw err;
      }
    },
    onEvent: async (payload) => {
      const event = normalizeScoreEvent(payload);
      if (event) await persistEvent(event);
    },
    onError: (err) => {
      console.error('[score-listener]', err.message);
    },
  });

  process.on('SIGTERM', () => {
    console.log('[score-listener] shutting down');
    stop();
    pool.end();
  });
}

if (require.main === module) {
  start();
}

module.exports = { start };
