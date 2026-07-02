function formatInsightsText(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return 'No upcoming market data is available right now. Try again shortly.';
  }

  return fixtures
    .slice(0, 3)
    .map((fixture) => {
      const oddsText = (fixture.odds || [])
        .slice(0, 3)
        .map((odd) => `${odd.market}:${odd.selection} (${Math.round(odd.impliedProb * 100)}%)`)
        .join(' • ');

      return `${fixture.homeTeam} vs ${fixture.awayTeam}\n${oddsText}`;
    })
    .join('\n\n');
}

module.exports = { formatInsightsText };
