// bot/settlement.js
//
// Polls for fixtures that have finished but still have pending predictions
// tied to them, resolves each prediction against the final score, and
// pays out points. This is the "settlement" piece of the product -- using
// TxODDS's own score feed as the source of truth for who won, which is the
// honest way to tie the prediction/markets and fan-experience ideas
// together without building an actual betting exchange.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');
const { createSettlementEnvelope } = require('./wdk');
const { createRuntimeProof } = require('./pear');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POLL_INTERVAL_MS = 30_000;
const PAYOUT_MULTIPLIER = 1.8; // flat multiplier on stake for a correct pick, kept simple for v1

function start() {
  console.log('[settlement] starting...');
  setInterval(settlePendingPredictions, POLL_INTERVAL_MS);
}

async function settlePendingPredictions() {
  try {
    const { rows: finishedFixtures } = await pool.query(
      `select distinct f.id, f.home_score, f.away_score
       from fixtures f
       join predictions p on p.fixture_id = f.id
       where f.status = 'finished'
         and p.status = 'pending'`
    );

    for (const fixture of finishedFixtures) {
      await settleFixture(fixture);
    }
  } catch (err) {
    console.error('[settlement] poll failed:', err.message);
  }
}

async function settleFixture(fixture) {
  const { rows: predictions } = await pool.query(
    `select * from predictions where fixture_id = $1 and status = 'pending'`,
    [fixture.id]
  );

  for (const prediction of predictions) {
    const outcome = resolveOutcome(prediction, fixture);
    await applySettlement(prediction, outcome, fixture);
  }
}

/**
 * Currently handles the 1X2 market only -- HOME / DRAW / AWAY against the
 * final score. Other markets (BTTS, over/under) can be added here as
 * separate branches without touching the rest of the settlement flow.
 */
function resolveOutcome(prediction, fixture) {
  const { home_score: home, away_score: away } = fixture;
  if (home == null || away == null) return 'void';

  if (prediction.market === '1X2') {
    let actualResult;
    if (home > away) actualResult = 'HOME';
    else if (away > home) actualResult = 'AWAY';
    else actualResult = 'DRAW';

    return prediction.selection === actualResult ? 'won' : 'lost';
  }

  if (prediction.market === 'BTTS') {
    const bothScored = home > 0 && away > 0;
    const actualResult = bothScored ? 'YES' : 'NO';
    return prediction.selection === actualResult ? 'won' : 'lost';
  }

  if (prediction.market.startsWith('OU_')) {
    const threshold = parseFloat(prediction.market.slice(3).replace('_', '.'));
    if (Number.isNaN(threshold)) return 'void';

    const totalGoals = home + away;
    const actualResult = totalGoals > threshold ? 'OVER' : 'UNDER';
    return prediction.selection === actualResult ? 'won' : 'lost';
  }

  return 'void'; // unsupported market for now -- refund rather than guess
}

async function applySettlement(prediction, outcome, fixture) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    let pointsAwarded = 0;
    if (outcome === 'won') {
      pointsAwarded = Math.round(prediction.points_staked * PAYOUT_MULTIPLIER);
    } else if (outcome === 'void') {
      pointsAwarded = prediction.points_staked; // refund the stake
    }
    // 'lost' -> pointsAwarded stays 0, stake was already debited at confirm time

    await client.query(
      `update predictions set status = $1, points_awarded = $2, settled_at = now()
       where id = $3`,
      [outcome, pointsAwarded, prediction.id]
    );

    if (pointsAwarded > 0) {
      const { rows: [user] } = await client.query(
        `update users set points_balance = points_balance + $1
         where id = $2
         returning points_balance`,
        [pointsAwarded, prediction.user_id]
      );

      await client.query(
        `insert into points_ledger (user_id, prediction_id, delta, reason, balance_after)
         values ($1, $2, $3, 'payout', $4)`,
        [prediction.user_id, prediction.id, pointsAwarded, user.points_balance]
      );
    }

    await client.query('commit');
    console.log(`[settlement] prediction ${prediction.id} -> ${outcome} (+${pointsAwarded} pts)`);

    try {
      const envelope = createSettlementEnvelope({
        prediction,
        fixture,
        outcome,
        pointsAwarded,
      });
      await persistSettlementEnvelope({ predictionId: prediction.id, envelope });
      await persistRuntimeProof({
        predictionId: prediction.id,
        proof: createRuntimeProof({
          eventType: 'prediction-settled',
          entityId: prediction.id,
          payload: { outcome, pointsAwarded, fixtureId: fixture.id },
        }),
      });
    } catch (persistErr) {
      console.warn('[settlement] metadata persistence failed:', persistErr.message);
    }
  } catch (err) {
    await client.query('rollback');
    console.error('[settlement] failed for prediction', prediction.id, err.message);
  } finally {
    client.release();
  }
}

async function persistSettlementEnvelope({ predictionId, envelope }) {
  await pool.query(
    `insert into settlement_envelopes (prediction_id, envelope_kind, signer, payload_hash, signature, payload)
     values ($1, $2, $3, $4, $5, $6)`,
    [predictionId, envelope.kind, envelope.signer, envelope.payloadHash, envelope.signature, JSON.stringify(envelope.payload)]
  );
}

async function persistRuntimeProof({ predictionId, proof }) {
  await pool.query(
    `insert into runtime_proofs (prediction_id, proof_kind, event_type, proof_hash, payload)
     values ($1, $2, $3, $4, $5)`,
    [predictionId, proof.kind, proof.eventType, proof.proofHash, JSON.stringify(proof.payload)]
  );
}

if (require.main === module) {
  start();
}

module.exports = { start, resolveOutcome, settlePendingPredictions };
