# FixtureLine

Telegram bot for the TxODDS World Cup hackathon. Live match updates, AI-suggested
predictions (points-based, not real money), and on-chain verified results.

## What users see on /start

Welcome to FixtureLine — your live football intelligence hub.

- ⚡ `/predict <what you are after>` — get AI-suggested picks
- 📌 `/mypicks` — review your active and recent picks
- 🏆 `/leaderboard` — see the top players by points
- 🔎 `/verify <fixtureId>` — validate a match with on-chain proof

Add the bot to a group or channel for live goal alerts and match edge highlights.

## Live devnet verification

The bot fetches TxODDS proof payloads for a fixture and validates them on Solana using the devnet `validate_fixture` instruction. `/verify <fixtureId>` now returns the Merkle root, batch timestamp, and a Solana explorer link for the validation transaction.

## Why three separate processes

Run these independently, not as one monolith:

```
npm run db:migrate     # once, sets up schema
npm run ingest:odds    # long-running, writes odds_snapshots
npm run ingest:scores  # long-running, writes score_events + updates fixtures
npm run bot            # long-running, the Telegram-facing process
```

The ingestion workers never talk to Telegram. The bot never talks to TxODDS
directly. They only share Postgres. This means:

- A bot crash/restart never drops a goal from the live feed.
- A TxODDS hiccup (reconnect, 401, rate limit) never takes the bot offline.
- The broadcast queue's rate-limit logic lives in exactly one place
  (`bot/broadcast-queue.js`), not duplicated across workers.

## First-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in.
3. Generate or import a Solana wallet keypair, fund it with a small amount
   of SOL for gas (the free tier subscription itself costs 0 TxL, but the
   on-chain `subscribe` transaction still needs gas).
4. Run `npm run db:migrate`.
5. Bootstrap the TxODDS session once:
   ```js
   const { bootstrapSession } = require('./ingestion/workers/session-keeper');
   // wire up `program` per TxODDS's IDL/devnet docs, then:
   await bootstrapSession({ walletKeypair, program });
   ```
   This only needs to run once every ~4 weeks (the subscription period).
   After that, `session-keeper.js` refreshes the JWT automatically.
6. Start all three processes (`npm run ingest:odds`, `npm run ingest:scores`,
   `npm run bot`) -- ideally under a process manager (pm2, systemd, or
   separate containers) so each restarts independently on failure.

## Compliance notes, read before extending

- **No real money.** `points_balance` is an in-app number, never
  withdrawable, never tied to a payment processor. This is deliberate:
  Telegram's own ToS prohibits real-money betting bots, and the hackathon
  terms flag gambling-law compliance explicitly. If you're ever tempted to
  add a "cash out" feature, stop and reread the hackathon terms first.
- **No raw TxODDS redistribution.** `ingestion/txodds/normalize.js` is the
  only place allowed to see TxODDS's raw wire format. Everything past that
  point (Postgres, the bot, the prediction agent) only ever sees our own
  normalized shape. Don't pipe raw TxODDS payloads into a Telegram message
  or expose them via any API.
- **The prediction agent suggests, it never confirms.** Only an explicit
  button tap in `bot/handlers/predict.js` (`confirm_pick:...` callback)
  writes to `predictions` or debits `points_ledger`. Keep it that way --
  it's both a hackathon eligibility point (human-authored submissions only)
  and a basic safety boundary against the bot looking like an autonomous
  trading agent.

## Directory layout

```
db/schema.sql              Postgres schema
ingestion/
  txodds/
    auth.js                 Solana subscribe + API token activation
    normalize.js            raw TxODDS payload -> our internal shape
    sse-client.js            reconnecting SSE wrapper
  workers/
    session-keeper.js        owns JWT/API token lifecycle
    odds-listener.js          long-running odds stream consumer
    score-listener.js         long-running scores stream consumer
bot/
  index.js                   entrypoint, wires handlers together
  broadcast-queue.js          rate-limit-aware fan-out to groups/channels
  settlement.js                resolves predictions after full time
  agent/
    prediction-agent.js        QVAC-powered suggestion engine
  handlers/
    predict.js                /predict, /mypicks, confirm callback
    groups.js                  group/channel onboarding, /alertlevel
    misc.js                     /leaderboard, /verify
```

## What's still a stub

- `auth.js` assumes an Anchor `program` object is constructed elsewhere
  (devnet vs mainnet program ID, IDL loading) -- wire that up per TxODDS's
  published IDL before `bootstrapSession()` will run.
- Settlement only handles the `1X2` market. Extend `resolveOutcome()` in
  `settlement.js` for BTTS/over-under once those are wired into the agent.

## Verify worker (deployment)

The repository includes a small verify worker under `ingestion/txodds` that
performs on-chain validation using Anchor. Because Anchor and some Solana
ecosystem libraries are ESM-heavy, the verify worker should run as a
separate service (not inside the Telegram bot process).

Files of interest:

- `ingestion/txodds/verify-service.js` — HTTP worker exposing `/health`,
  `/verify` and `/verify-by-id`.
- `ingestion/txodds/package.json` — focused dependencies for the worker.
- `ingestion/txodds/Dockerfile` — example Dockerfile to build the worker image.
- `ingestion/txodds/railway.json` and `ingestion/txodds/Procfile` — sample
  Railway deployment config for the verify worker.

Local run (verify worker):

```bash
cd ingestion/txodds
npm ci
npm run verify-service
```

Or with Docker:

```bash
docker build -t fixtureline-verify:latest ingestion/txodds
docker run -e DATABASE_URL=... -e VERIFY_SERVICE_TOKEN=secret -p 3001:3001 fixtureline-verify:latest
```

Set `VERIFY_SERVICE_URL` and optionally `VERIFY_SERVICE_TOKEN` in the bot
service environment so the bot can call `/verify-by-id` on behalf of users.
