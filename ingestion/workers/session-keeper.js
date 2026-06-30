// ingestion/workers/session-keeper.js
//
// Owns the lifecycle of the TxODDS session (JWT + API token). Other workers
// (odds-listener, score-listener) call getCredentials() from here rather
// than touching auth.js directly -- this is the single place that decides
// "is our session still good, or do we need to refresh it".
//
// Why a singleton row in Postgres instead of just in-memory state: if the
// ingestion process restarts, we don't want to fire a new on-chain
// `subscribe` transaction every time. The on-chain subscription is valid
// for 4 weeks regardless of process restarts; only the JWT needs frequent
// refreshing.

require('dotenv').config();
const { Pool } = require('pg');
const { getGuestJwt, runFullActivation } = require('../txodds/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const JWT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh a day before expiry
const JWT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;  // TxODDS JWTs last 30 days

async function loadSession() {
  const { rows } = await pool.query('select * from txodds_session where id = 1');
  return rows[0] || null;
}

async function saveSession({ jwt, apiToken, leagues = [] }) {
  const jwtExpiresAt = new Date(Date.now() + JWT_LIFETIME_MS);
  await pool.query(
    `insert into txodds_session (id, jwt, jwt_expires_at, api_token, leagues, updated_at)
     values (1, $1, $2, $3, $4, now())
     on conflict (id) do update set
       jwt = excluded.jwt,
       jwt_expires_at = excluded.jwt_expires_at,
       api_token = excluded.api_token,
       leagues = excluded.leagues,
       updated_at = now()`,
    [jwt, jwtExpiresAt, apiToken, leagues]
  );
}

/**
 * The function every stream consumer should call before opening or
 * reopening a connection. Returns a valid {jwt, apiToken} pair, refreshing
 * the JWT transparently if it's close to expiry.
 *
 * Does NOT re-run the full on-chain activation unless there is no session
 * at all in the database -- call bootstrapSession() explicitly for that,
 * typically once at deploy time or via a manual ops command.
 */
async function getCredentials() {
  const session = await loadSession();

  if (!session) {
    throw new Error(
      'No TxODDS session found. Run bootstrapSession() once with a funded ' +
      'wallet before starting any stream consumers.'
    );
  }

  const msUntilExpiry = new Date(session.jwt_expires_at).getTime() - Date.now();

  if (msUntilExpiry < JWT_REFRESH_MARGIN_MS) {
    const jwt = await getGuestJwt();
    await saveSession({ jwt, apiToken: session.api_token, leagues: session.leagues });
    return { jwt, apiToken: session.api_token };
  }

  return { jwt: session.jwt, apiToken: session.api_token };
}

/**
 * Run once, manually, to establish the very first session (and again every
 * ~4 weeks when the on-chain subscription period lapses). Requires a
 * Solana wallet keypair and a wired Anchor program instance -- see
 * auth.js for what `program` needs to expose.
 */
async function bootstrapSession({ walletKeypair, program }) {
  const { jwt, apiToken } = await runFullActivation({ walletKeypair, program });
  await saveSession({ jwt, apiToken, leagues: [] });
  return { jwt, apiToken };
}

/**
 * Call this if a stream consumer gets an explicit 401/403 even after
 * getCredentials() returned what it thought was a fresh JWT -- forces an
 * immediate refresh rather than waiting for the expiry-margin check.
 */
async function forceRefresh() {
  const session = await loadSession();
  if (!session) throw new Error('No session to refresh.');
  const jwt = await getGuestJwt();
  await saveSession({ jwt, apiToken: session.api_token, leagues: session.leagues });
  return { jwt, apiToken: session.api_token };
}

module.exports = {
  getCredentials,
  bootstrapSession,
  forceRefresh,
};
