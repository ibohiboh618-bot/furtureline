require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('🌱 Seeding mock data for FixtureLine...');

  // Clear existing fixtures & odds to start fresh (cascade handles children)
  await client.query('truncate table fixtures cascade');
  await client.query('truncate table users cascade');

  // 1. Seed Users
  const userRes = await client.query(
    `insert into users (telegram_user_id, telegram_username, display_name, points_balance, risk_preference, favorite_teams)
     values 
       (111111111, 'neymar_jr', 'Neymar Jr', 1500, 'high', '{"Brazil"}'),
       (222222222, 'messi_10', 'Leo Messi', 1200, 'low', '{"Argentina"}'),
       (333333333, 'cr7_goat', 'Cristiano', 800, 'medium', '{"Portugal"}')
     returning *`
  );
  console.log(`✅ Seeded ${userRes.rowCount} mock users`);
  const users = userRes.rows;

  // 2. Seed Upcoming Fixtures
  const upcomingFixtures = [
    {
      id: 1001,
      competition: 'FIFA World Cup 2026',
      home_team: 'Brazil',
      away_team: 'France',
      kickoff_offset_days: 2,
      status: 'scheduled'
    },
    {
      id: 1002,
      competition: 'FIFA World Cup 2026',
      home_team: 'Argentina',
      away_team: 'Germany',
      kickoff_offset_days: 4,
      status: 'scheduled'
    },
    {
      id: 1003,
      competition: 'FIFA World Cup 2026',
      home_team: 'Spain',
      away_team: 'Italy',
      kickoff_offset_days: 5,
      status: 'scheduled'
    }
  ];

  for (const f of upcomingFixtures) {
    const kickoff = new Date();
    kickoff.setDate(kickoff.getDate() + f.kickoff_offset_days);

    await client.query(
      `insert into fixtures (id, competition, home_team, away_team, kickoff_at, status)
       values ($1, $2, $3, $4, $5, $6)`,
      [f.id, f.competition, f.home_team, f.away_team, kickoff, f.status]
    );

    // Seed odds snapshots for this fixture
    const odds = [
      // 1X2
      { market: '1X2', selection: 'HOME', implied_prob: 0.45 },
      { market: '1X2', selection: 'DRAW', implied_prob: 0.30 },
      { market: '1X2', selection: 'AWAY', implied_prob: 0.25 },
      // BTTS
      { market: 'BTTS', selection: 'YES', implied_prob: 0.65 },
      { market: 'BTTS', selection: 'NO', implied_prob: 0.35 },
      // OU_2_5
      { market: 'OU_2_5', selection: 'OVER', implied_prob: 0.58 },
      { market: 'OU_2_5', selection: 'UNDER', implied_prob: 0.42 }
    ];

    for (const o of odds) {
      await client.query(
        `insert into odds_snapshots (fixture_id, market, selection, implied_prob, captured_at)
         values ($1, $2, $3, $4, now())`,
        [f.id, o.market, o.selection, o.implied_prob]
      );
    }
  }
  console.log('✅ Seeded 3 upcoming fixtures with 1X2, BTTS, and OU_2_5 odds snapshots');

  // 3. Seed Finished Fixtures for Settlement Testing
  const finishedFixtures = [
    {
      id: 2001,
      competition: 'FIFA World Cup 2026',
      home_team: 'Argentina',
      away_team: 'France',
      home_score: 3,
      away_score: 3, // Draw! BTTS = YES, OU_2_5 = OVER
      status: 'finished'
    },
    {
      id: 2002,
      competition: 'FIFA World Cup 2026',
      home_team: 'Brazil',
      away_team: 'Germany',
      home_score: 2,
      away_score: 0, // Brazil wins! BTTS = NO, OU_2_5 = UNDER
      status: 'finished'
    }
  ];

  for (const f of finishedFixtures) {
    const kickoff = new Date();
    kickoff.setHours(kickoff.getHours() - 3); // kicked off 3 hours ago

    await client.query(
      `insert into fixtures (id, competition, home_team, away_team, kickoff_at, status, home_score, away_score)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [f.id, f.competition, f.home_team, f.away_team, kickoff, f.status, f.home_score, f.away_score]
    );
  }
  console.log('✅ Seeded 2 finished fixtures with scores');

  // 4. Seed Pending Predictions on the finished fixtures to test settlement
  const predictions = [
    // Predictions on Argentina vs France (3-3)
    { user_index: 0, fixture_id: 2001, market: '1X2', selection: 'DRAW', points: 100 }, // Will win
    { user_index: 1, fixture_id: 2001, market: 'BTTS', selection: 'YES', points: 50 },  // Will win
    { user_index: 2, fixture_id: 2001, market: 'OU_2_5', selection: 'UNDER', points: 80 }, // Will lose

    // Predictions on Brazil vs Germany (2-0)
    { user_index: 0, fixture_id: 2002, market: '1X2', selection: 'HOME', points: 150 }, // Will win
    { user_index: 1, fixture_id: 2002, market: 'BTTS', selection: 'YES', points: 60 },  // Will lose
    { user_index: 2, fixture_id: 2002, market: 'OU_2_5', selection: 'UNDER', points: 100 } // Will win
  ];

  for (const p of predictions) {
    const user = users[p.user_index];
    await client.query(
      `insert into predictions (user_id, fixture_id, market, selection, points_staked, status)
       values ($1, $2, $3, $4, $5, 'pending')`,
      [user.id, p.fixture_id, p.market, p.selection, p.points]
    );
  }
  console.log('✅ Seeded mock pending predictions on the finished fixtures');

  await client.end();
  console.log('🌱 Seed completed successfully!');
}

main().catch(console.error);
