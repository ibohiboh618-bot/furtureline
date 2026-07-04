// bot/agent/prediction-agent.js
//
// Turns a user's free-text preference ("I like Brazil, I'm cautious, low
// risk picks") into a ranked shortlist of upcoming fixtures + market
// selections, with plain-language reasoning attached.
//
// Hard rule, not just a style choice: this agent only ever *suggests*. It
// never calls confirmPrediction() itself. The human always taps a button
// to lock in a pick. This keeps a clear human-in-the-loop boundary, which
// matters both for the hackathon's "no autonomous agent may control the
// submission" rule and for not quietly drifting into something that looks
// like automated betting.

require('dotenv').config({ path: ['.env', 'bot/.env'] });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let cachedModelId = null;

async function loadQvacSdk() {
  return import('@qvac/sdk');
}

const SYSTEM_PROMPT = `You are a football prediction assistant inside a Telegram bot called FixtureLine.

You are given:
- A user's stated preference in their own words (favorite teams, risk tolerance, mood)
- A list of upcoming fixtures with current de-vig'd implied probabilities per market

Your job: suggest up to 3 picks that best match what the user said, ranked by fit.

Rules:
- You are suggesting, not deciding. The user will confirm or ignore each suggestion.
- Never claim certainty. Use implied probability language ("the market currently gives this about a 62% chance"), not "this will win".
- If risk preference is "low", prefer selections with implied probability above 0.60.
- If risk preference is "high", you may suggest selections below 0.35 implied probability, but say so explicitly.
- Keep reasoning to 2-3 sentences per pick, plain language, no jargon.
- Output strict JSON only, no prose outside the JSON, matching this shape:
  { "picks": [ { "fixtureId": number, "market": string, "selection": string, "impliedProb": number, "reasoning": string } ] }`;

/**
 * @param {Object} params
 * @param {string} params.preferenceText - raw user input
 * @param {string|null} params.riskPreference - 'low' | 'medium' | 'high' | null
 * @param {string[]} params.favoriteTeams
 * @returns {Promise<Array<{fixtureId, market, selection, impliedProb, reasoning}>>}
 */
async function suggestPicks({ preferenceText, riskPreference, favoriteTeams }) {
  const fixtures = await getUpcomingFixturesWithOdds();

  if (fixtures.length === 0) {
    return [];
  }

  const fallbackPicks = buildFallbackPicks({ fixtures, preferenceText, riskPreference, favoriteTeams });
  if (fallbackPicks.length > 0) {
    return fallbackPicks;
  }

  const userContext = JSON.stringify({
    preferenceText,
    riskPreference,
    favoriteTeams,
  });

  const fixtureContext = JSON.stringify(fixtures);

  try {
    const qvac = await loadQvacSdk();
    const { loadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } = qvac;

    if (!cachedModelId) {
      cachedModelId = await loadModel({
        modelSrc: process.env.QVAC_MODEL || LLAMA_3_2_1B_INST_Q4_0,
      });
    }

    const history = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `User context:\n${userContext}\n\nUpcoming fixtures and odds:\n${fixtureContext}`,
      },
    ];

    const result = completion({ modelId: cachedModelId, history, stream: true });
    let raw = '';
    for await (const token of result.tokenStream) {
      raw += token;
    }

    const normalized = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
    if (!normalized) return [];

    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed.picks) ? parsed.picks.slice(0, 3) : [];
  } catch (err) {
    console.warn('[prediction-agent] QVAC SDK request failed:', err.message);
    return buildFallbackPicks({ fixtures, preferenceText, riskPreference, favoriteTeams });
  }
}

function buildFallbackPicks({ fixtures, preferenceText, riskPreference, favoriteTeams }) {
  const lowRisk = (riskPreference || '').toLowerCase() === 'low';
  const preferredTeams = (favoriteTeams || []).map((team) => team.toLowerCase());

  const ranked = fixtures
    .map((fixture) => {
      const bestOdd = (fixture.odds || [])
        .filter((entry) => entry.market === '1X2')
        .sort((a, b) => Number(b.impliedProb) - Number(a.impliedProb))[0];

      if (!bestOdd) return null;
      if (lowRisk && Number(bestOdd.impliedProb) < 0.55) return null;

      const homeTeam = (fixture.homeTeam || '').toLowerCase();
      const awayTeam = (fixture.awayTeam || '').toLowerCase();
      const teamAffinity = preferredTeams.some((team) => homeTeam.includes(team) || awayTeam.includes(team));

      return {
        fixtureId: fixture.fixtureId,
        market: bestOdd.market,
        selection: bestOdd.selection,
        impliedProb: Number(bestOdd.impliedProb),
        reasoning: `${teamAffinity ? 'This lines up with one of your favorite teams and ' : ''}the market currently gives this about ${Math.round(Number(bestOdd.impliedProb) * 100)}% chance.`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.impliedProb) - Number(a.impliedProb));

  return ranked.slice(0, 3);
}

/**
 * Pulls the next ~20 upcoming fixtures with their latest 1X2 implied
 * probabilities -- enough context for the model without flooding the
 * prompt. We intentionally keep this small and pre-filtered rather than
 * dumping the whole fixtures table at the model.
 */
async function getUpcomingFixturesWithOdds() {
  const { rows } = await pool.query(
    `select
       f.id as "fixtureId",
       f.home_team as "homeTeam",
       f.away_team as "awayTeam",
       f.kickoff_at as "kickoffAt",
       os.market,
       os.selection,
       os.implied_prob as "impliedProb"
     from fixtures f
     join lateral (
       select distinct on (market, selection) market, selection, implied_prob
       from odds_snapshots
       where fixture_id = f.id and market in ('1X2', 'BTTS', 'OU_2_5')
       order by market, selection, captured_at desc
     ) os on true
     where f.status = 'scheduled'
       and f.kickoff_at > now()
       and f.kickoff_at < now() + interval '7 days'
     order by f.kickoff_at asc
     limit 200` // enough space for ~20 fixtures with multiple markets
  );

  // group rows back into one object per fixture for a cleaner prompt
  const byFixture = new Map();
  for (const row of rows) {
    if (!byFixture.has(row.fixtureId)) {
      byFixture.set(row.fixtureId, {
        fixtureId: row.fixtureId,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        kickoffAt: row.kickoffAt,
        odds: [],
      });
    }
    byFixture.get(row.fixtureId).odds.push({
      market: row.market,
      selection: row.selection,
      impliedProb: row.impliedProb,
    });
  }

  return Array.from(byFixture.values());
}

module.exports = { suggestPicks, buildFallbackPicks };
