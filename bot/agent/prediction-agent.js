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

const Groq = require('groq-sdk');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = 'llama-3.3-70b-versatile';

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

  const userContext = JSON.stringify({
    preferenceText,
    riskPreference,
    favoriteTeams,
  });

  const fixtureContext = JSON.stringify(fixtures);

  const completion = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `User context:\n${userContext}\n\nUpcoming fixtures and odds:\n${fixtureContext}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.picks) ? parsed.picks.slice(0, 3) : [];
  } catch (err) {
    console.error('[prediction-agent] failed to parse model output:', err.message);
    return [];
  }
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
       select market, selection, implied_prob
       from odds_snapshots
       where fixture_id = f.id and market = '1X2'
       order by captured_at desc
       limit 3
     ) os on true
     where f.status = 'scheduled'
       and f.kickoff_at > now()
       and f.kickoff_at < now() + interval '7 days'
     order by f.kickoff_at asc
     limit 60` // ~20 fixtures x 3 selections each
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

module.exports = { suggestPicks };
