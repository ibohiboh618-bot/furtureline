require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"))
  .then(r => {
    console.log('Tables created:', r.rows.map(x => x.tablename).join(', '));
    c.end();
  })
  .catch(e => { console.error(e.message); c.end(); });
