// bot/handlers/misc.js
//
// /leaderboard and /verify -- the two features that round out the fan
// experience and give the on-chain angle something concrete to point at
// in a demo, rather than just asserting "it's on Solana" in prose.

const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';

function registerMiscHandlers(bot) {
  bot.command('leaderboard', async (ctx) => {
    const { rows } = await pool.query(
      `select telegram_username, display_name, points_balance
       from users
       order by points_balance desc
       limit 10`
    );

    if (rows.length === 0) {
      return ctx.reply('No one has made a pick yet. Be the first with /predict.');
    }

    const lines = rows.map((u, i) => {
      const name = u.telegram_username ? `@${u.telegram_username}` : (u.display_name || 'Anonymous');
      return `${i + 1}. ${name} -- ${u.points_balance} pts`;
    });

    await ctx.reply(['Leaderboard', ...lines].join('\n'));
  });

  bot.command('verify', async (ctx) => {
    const fixtureIdStr = ctx.match?.trim();
    if (!fixtureIdStr || Number.isNaN(Number(fixtureIdStr))) {
      return ctx.reply('Usage: /verify <fixtureId>');
    }

    await ctx.replyWithChatAction('typing');

    try {
      const { jwt, apiToken } = await getActiveSession();
      const proof = await fetchMerkleProof(fixtureIdStr, jwt, apiToken);

      await ctx.reply(
        `This fixture's data batch is anchored on Solana.\n` +
        `Merkle root: <code>${proof.merkleRoot}</code>\n` +
        `Batch timestamp: ${proof.batchTimestamp}\n\n` +
        `Anyone can independently verify this against the on-chain root using TxODDS's public validate instruction.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[verify] error details:', err.message);
      if (err.response) {
        if (err.response.status === 404) {
          return ctx.reply(`❌ No proof has been archived for fixture <code>${fixtureIdStr}</code> yet. It might not be finished, or its block hasn't been committed to Solana.`, { parse_mode: 'HTML' });
        }
        return ctx.reply(`❌ Failed to retrieve proof (API returned status ${err.response.status}). Please try again later.`);
      }
      await ctx.reply("❌ Couldn't fetch a proof for that fixture right now. Please ensure the fixture ID is correct or try again shortly.");
    }
  });
}

async function getActiveSession() {
  const { rows } = await pool.query('select jwt, api_token from txodds_session where id = 1');
  if (rows.length === 0) throw new Error('No active TxODDS session');
  return { jwt: rows[0].jwt, apiToken: rows[0].api_token };
}

async function fetchMerkleProof(fixtureId, jwt, apiToken) {
  const { data } = await axios.get(
    `${TXLINE_BASE_URL}/api/fixtures/${fixtureId}/proof`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': apiToken,
      },
    }
  );

  // Defensive parsing supporting variations in TxLINE response properties
  const merkleRoot = data.merkleRoot || data.root || data.merkle_root || 'Not Available';
  const batchTimestamp = data.batchTimestamp || data.timestamp || data.ts || new Date().toISOString();

  return {
    merkleRoot,
    batchTimestamp,
  };
}

module.exports = { registerMiscHandlers };
