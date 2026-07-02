Verify worker deploy notes
=========================

Quick checklist to enable Redis-backed verify queue and run service+worker separately.

Required environment variables for the verify worker service:

- `DATABASE_URL` — Postgres connection string used to persist job rows.
- `VERIFY_SERVICE_TOKEN` — Bearer token that the bot will use when calling `/verify-by-id`.
- `ADMIN_TOKEN` — (optional) admin bearer token used to rotate `VERIFY_SERVICE_TOKEN` via `/rotate-token`.
- `REDIS_URL` — set this to enable BullMQ queueing; if unset the service falls back to a DB poller.
- `TXLINE_BASE_URL` — (optional) base URL for TxODDS API (defaults to https://txline.txodds.com).

Running locally with docker-compose (example)

1. Start Redis + Postgres + verify service (worker optional):

```bash
docker run -d --name redis -p 6379:6379 redis:7
# start Postgres (or use your existing DB)
# build image from this folder
docker build -t txodds-verify-image .

# run the HTTP service
docker run -e DATABASE_URL="postgres://..." -e VERIFY_SERVICE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" -e REDIS_URL="redis://redis:6379" -p 3001:3001 --link redis --link your-postgres txodds-verify-image

# run the worker (in another container)
docker run -e DATABASE_URL="postgres://..." -e REDIS_URL="redis://redis:6379" -e TXLINE_BASE_URL="https://txline.txodds.com" --link redis --link your-postgres txodds-verify-image sh -c "npm run start:verify-worker"
```

Railway / cloud notes

- Provision a Redis add-on and copy its connection URL into `REDIS_URL` for the verify service and worker.
- Set `DATABASE_URL`, `VERIFY_SERVICE_TOKEN`, and `ADMIN_TOKEN` in Railway's service environment settings for the verify service.
- Deploy two processes/services:
  - `verify-service` — runs the HTTP endpoint (default). Set `RUN_MODE` to `service` or leave unset.
  - `verify-worker` — runs the BullMQ worker. Set `RUN_MODE` to `worker`.

Security

- Keep `VERIFY_SERVICE_TOKEN` secret and configure the bot to call the verify endpoint with `Authorization: Bearer <token>`.
- Use `ADMIN_TOKEN` only for human-admin endpoints (rotation) and rotate regularly.

Scaling

- For horizontal scaling, run multiple `verify-worker` instances (they will compete for Bull jobs).
- Keep the HTTP service stateless; it only enqueues jobs and serves status endpoints.
