require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('select * from txodds_session');
  console.log('Session rows:', rows);
  await client.end();
}

main().catch(console.error);
