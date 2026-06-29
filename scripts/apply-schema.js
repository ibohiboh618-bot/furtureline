/**
 * apply-schema.js
 * Reads db/schema.sql and executes it against DATABASE_URL.
 * Run once: node scripts/apply-schema.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

  const client = new Client({ connectionString: url });
  await client.connect();
  console.log('✅ Connected to database');

  try {
    await client.query(sql);
    console.log('✅ Schema applied successfully');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Tables already exist — schema is up to date');
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
