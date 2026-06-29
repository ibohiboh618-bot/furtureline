// ingestion/txodds/normalize.js
//
// Converts raw TxODDS payloads into our own internal shape before anything
// touches Postgres or the bot. This matters for two reasons:
//
//   1. Compliance: the hackathon data terms prohibit redistributing TxODDS's
//      raw feed. We store *derived* values (de-vig'd implied probability,
//      our own event taxonomy), not their wire format or bookmaker-level
//      detail. What we serve users is a different product, not a mirror.
//
//   2. Stability: if TxODDS changes field names or adds bookmakers, only
//      this file needs to change. Nothing downstream knows TxODDS exists.

/**
 * Convert one TxODDS OddsPayload into zero or more normalized rows ready
 * for insertion into odds_snapshots.
 *
 * Raw shape (per TxODDS API reference):
 *   { FixtureId, MessageId, Ts, Bookmaker, BookmakerId, SuperOddsType,
 *     GameState, InRunning, MarketParameters, MarketPeriod,
 *     PriceNames: string[], Prices: number[], Pct: string[] }
 *
 * We don't keep individual bookmaker prices. We keep the de-vig'd
 * consensus percentage per selection, which is what TxODDS calls "Stable
 * Price" -- this is the part of their product explicitly designed for
 * consumption like this.
 */
function normalizeOddsPayload(raw) {
  if (!raw || !Array.isArray(raw.PriceNames) || !Array.isArray(raw.Pct)) {
    return [];
  }

  const capturedAt = new Date(raw.Ts);
  const market = mapMarket(raw.SuperOddsType, raw.MarketParameters);

  return raw.PriceNames.map((selectionRaw, i) => {
    const pctRaw = raw.Pct[i];
    if (pctRaw === 'NA') return null;

    const impliedProb = parseFloat(pctRaw) / 100;
    if (Number.isNaN(impliedProb)) return null;

    return {
      fixtureId: raw.FixtureId,
      market,
      selection: mapSelection(selectionRaw),
      impliedProb: round4(impliedProb),
      capturedAt,
      sourceMessageId: raw.MessageId, // kept for our own audit/proof lookup only
    };
  }).filter(Boolean);
}

/**
 * Convert one TxODDS score update into zero or one normalized score_event row.
 * Raw score payloads vary by sport; this handles the soccer shape used for
 * the World Cup feed (goals, cards, period changes).
 */
function normalizeScoreEvent(raw) {
  if (!raw || !raw.FixtureId) return null;

  const eventType = mapEventType(raw.EventType || raw.Type);
  if (!eventType) return null;

  return {
    fixtureId: raw.FixtureId,
    eventType,
    minute: raw.Minute ?? null,
    team: mapTeamSide(raw.Team),
    description: raw.Description ?? null,
    occurredAt: new Date(raw.Ts),
  };
}

// --- mapping helpers -------------------------------------------------------

function mapMarket(superOddsType, marketParameters) {
  // TxODDS market taxonomy -> our own short codes.
  // Extend this table as more markets are wired up; unknown types fall
  // through to a generic bucket rather than throwing, so a feed quirk
  // doesn't take down ingestion.
  const table = {
    MATCH_ODDS: '1X2',
    OVER_UNDER: marketParameters ? `OU_${marketParameters.replace('.', '_')}` : 'OU',
    BOTH_TEAMS_TO_SCORE: 'BTTS',
    DOUBLE_CHANCE: 'DOUBLE_CHANCE',
  };
  return table[superOddsType] || 'OTHER';
}

function mapSelection(name) {
  const table = {
    Home: 'HOME',
    Draw: 'DRAW',
    Away: 'AWAY',
    Over: 'OVER',
    Under: 'UNDER',
    Yes: 'YES',
    No: 'NO',
  };
  return table[name] || name.toUpperCase();
}

function mapEventType(raw) {
  const table = {
    Goal: 'goal',
    RedCard: 'red_card',
    YellowCard: 'yellow_card',
    Substitution: 'sub',
    KickOff: 'kickoff',
    HalfTime: 'half_time',
    FullTime: 'full_time',
    PenaltyMissed: 'penalty_miss',
  };
  return table[raw] || null;
}

function mapTeamSide(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === 'home' || v === '1') return 'home';
  if (v === 'away' || v === '2') return 'away';
  return null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  normalizeOddsPayload,
  normalizeScoreEvent,
};
