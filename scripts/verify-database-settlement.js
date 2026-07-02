require('dotenv').config();
const { Client } = require('pg');
const { settlePendingPredictions } = require('../bot/settlement');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('🔍 Checking pending predictions before settlement...');
  const beforePreds = await client.query(
    `select p.id, u.display_name, f.home_team, f.away_team, p.market, p.selection, p.points_staked, p.status
     from predictions p
     join users u on u.id = p.user_id
     join fixtures f on f.id = p.fixture_id
     where p.status = 'pending'`
  );
  console.table(beforePreds.rows);

  console.log('\n⚙️ Running settlePendingPredictions()...');
  await settlePendingPredictions();

  console.log('\n🔍 Checking predictions after settlement...');
  const afterPreds = await client.query(
    `select p.id, u.display_name, f.home_team, f.away_team, p.market, p.selection, p.points_staked, p.status, p.points_awarded
     from predictions p
     join users u on u.id = p.user_id
     join fixtures f on f.id = p.fixture_id
     order by p.status desc`
  );
  console.table(afterPreds.rows);

  console.log('\n💰 Checking updated user point balances...');
  const afterUsers = await client.query(
    `select display_name, points_balance from users`
  );
  console.table(afterUsers.rows);

  await client.end();
}

main().catch(console.error);
