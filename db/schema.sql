-- FixtureLine database schema
-- Postgres 14+
--
-- Design notes:
-- - We never store raw TxODDS payloads verbatim long-term. We normalize into
--   our own shape (see ingestion/txodds/normalize.js). This keeps us inside
--   the hackathon data terms (no redistribution of TxODDS's raw feed) and
--   keeps our own queries fast and stable even if TxODDS changes their wire
--   format.
-- - "points" are an in-app currency for predictions. Never real money. This
--   is a deliberate compliance boundary, not just a feature choice.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Fixtures (matches)
-- ---------------------------------------------------------------------------
create table fixtures (
  id              bigint primary key,        -- TxODDS FixtureId, used as-is
  competition     text not null,             -- e.g. 'FIFA World Cup 2026'
  home_team       text not null,
  away_team       text not null,
  kickoff_at      timestamptz not null,
  status          text not null default 'scheduled'
                    check (status in ('scheduled', 'live', 'finished', 'postponed', 'cancelled')),
  home_score      smallint,
  away_score      smallint,
  venue           text,
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index idx_fixtures_kickoff on fixtures (kickoff_at);
create index idx_fixtures_status on fixtures (status);

-- ---------------------------------------------------------------------------
-- Odds history (normalized, de-vig'd snapshots, not raw bookmaker feeds)
-- ---------------------------------------------------------------------------
-- One row per (fixture, market, captured_at) snapshot. We keep history so the
-- prediction agent can reason about line movement, not just the latest price.
create table odds_snapshots (
  id              uuid primary key default gen_random_uuid(),
  fixture_id      bigint not null references fixtures(id) on delete cascade,
  market          text not null,             -- e.g. '1X2', 'OU_2_5', 'BTTS'
  selection       text not null,              -- e.g. 'HOME', 'DRAW', 'AWAY', 'OVER'
  implied_prob    numeric(6,4) not null,      -- de-vig'd probability, 0..1
  captured_at     timestamptz not null,
  source_message_id text,                     -- TxODDS MessageId, for our own
                                               -- audit trail / Merkle lookup,
                                               -- not re-exposed to users as data
  created_at      timestamptz not null default now()
);

create index idx_odds_fixture_market on odds_snapshots (fixture_id, market, captured_at desc);

-- ---------------------------------------------------------------------------
-- Score events (goals, cards, subs) -- drives live alerts
-- ---------------------------------------------------------------------------
create table score_events (
  id              uuid primary key default gen_random_uuid(),
  fixture_id      bigint not null references fixtures(id) on delete cascade,
  event_type      text not null check (event_type in ('goal', 'red_card', 'yellow_card', 'sub', 'kickoff', 'half_time', 'full_time', 'penalty_miss')),
  minute          smallint,
  team            text,                       -- 'home' | 'away' | null for match-level events
  description     text,
  occurred_at     timestamptz not null,
  broadcast_at    timestamptz,                -- when we actually pushed this to chats
  created_at      timestamptz not null default now()
);

create index idx_score_events_fixture on score_events (fixture_id, occurred_at);
create index idx_score_events_unbroadcast on score_events (fixture_id) where broadcast_at is null;

-- ---------------------------------------------------------------------------
-- Users (Telegram identity, no wallet custody, no real-money balance ever)
-- ---------------------------------------------------------------------------
create table users (
  id                  uuid primary key default gen_random_uuid(),
  telegram_user_id    bigint not null unique,
  telegram_username   text,
  display_name        text,
  points_balance       integer not null default 1000,  -- starting points, free
  risk_preference     text check (risk_preference in ('low', 'medium', 'high')),
  favorite_teams      text[] default '{}',
  favorite_alert_level text check (favorite_alert_level in ('goals_only', 'goals_and_cards', 'all_events')) not null default 'goals_only',
  created_at          timestamptz not null default now(),
  last_active_at      timestamptz not null default now()
);

create index idx_users_telegram on users (telegram_user_id);

-- ---------------------------------------------------------------------------
-- Predictions (the human-confirmed pick, never auto-placed by the agent)
-- ---------------------------------------------------------------------------
create table predictions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  fixture_id      bigint not null references fixtures(id) on delete cascade,
  market          text not null,
  selection       text not null,
  points_staked   integer not null check (points_staked > 0),
  agent_reasoning text,                      -- snapshot of why the agent suggested this,
                                              -- stored for transparency / settlement audit
  status          text not null default 'pending'
                    check (status in ('pending', 'won', 'lost', 'void', 'cancelled')),
  points_awarded  integer,                    -- filled in at settlement
  confirmed_at    timestamptz not null default now(),
  settled_at      timestamptz
);

create index idx_predictions_user on predictions (user_id, confirmed_at desc);
create index idx_predictions_fixture on predictions (fixture_id);
create index idx_predictions_pending on predictions (fixture_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Points ledger (append-only audit trail backing points_balance)
-- ---------------------------------------------------------------------------
create table points_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  prediction_id   uuid references predictions(id) on delete set null,
  delta           integer not null,           -- positive or negative
  reason          text not null,              -- 'stake', 'payout', 'signup_bonus', 'admin_adjustment'
  balance_after   integer not null,
  created_at      timestamptz not null default now()
);

create index idx_ledger_user on points_ledger (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Broadcast targets (groups/channels the bot posts live updates into)
-- ---------------------------------------------------------------------------
create table broadcast_targets (
  id                uuid primary key default gen_random_uuid(),
  chat_id           bigint not null unique,   -- Telegram chat id (negative for groups/channels)
  chat_type         text not null check (chat_type in ('group', 'supergroup', 'channel')),
  title             text,
  is_admin_bot      boolean not null default false,  -- true once bot confirmed as admin
  subscribed_competitions text[] default '{}',         -- empty = all
  alert_level       text not null default 'goals_only'
                       check (alert_level in ('goals_only', 'goals_and_cards', 'all_events')),
  added_at          timestamptz not null default now(),
  active            boolean not null default true
);

create index idx_broadcast_active on broadcast_targets (active) where active = true;

-- ---------------------------------------------------------------------------
-- Ingestion auth state (single row, holds the live TxODDS session)
-- ---------------------------------------------------------------------------
create table txodds_session (
  id              smallint primary key default 1 check (id = 1), -- singleton
  jwt             text not null,
  jwt_expires_at  timestamptz not null,
  api_token       text not null,
  leagues         integer[] default '{}',
  updated_at      timestamptz not null default now()
);
