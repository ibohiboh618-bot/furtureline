require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const fixturesCount = await client.query('select count(*) from fixtures');
  const oddsCount = await client.query('select count(*) from odds_snapshots');
  const usersCount = await client.query('select count(*) from users');
  const predictionsCount = await client.query('select count(*) from predictions');
  
  console.log('--- Data Summary ---');
  console.log(`Fixtures: ${fixturesCount.rows[0].count}`);
  console.log(`Odds Snapshots: ${oddsCount.rows[0].count}`);
  console.log(`Users: ${usersCount.rows[0].count}`);
  console.log(`Predictions: ${predictionsCount.rows[0].count}`);
  
  if (fixturesCount.rows[0].count > 0) {
    const sampleFixtures = await client.query('select * from fixtures limit 3');
    console.log('Sample Fixtures:', sampleFixtures.rows);
  }
  
  await client.end();
}

main().catch(console.error);
