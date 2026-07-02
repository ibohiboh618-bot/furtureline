const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const { ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { buildSubscriptionTransaction } = require('./auth');

test('buildSubscriptionTransaction creates an ATA instruction when the user token account is missing', async () => {
  const program = {
    programId: new PublicKey('11111111111111111111111111111111'),
    subscriptionTokenMint: new PublicKey('So11111111111111111111111111111111111111112'),
    methods: {
      subscribe: () => ({
        accounts: () => ({
          instruction: async () => ({
            programId: new PublicKey('So11111111111111111111111111111111111111112'),
            keys: [],
            data: Buffer.alloc(0),
          }),
        }),
      }),
    },
  };

  const wallet = { publicKey: new PublicKey('11111111111111111111111111111111') };
  const connection = { getAccountInfo: async () => null };

  const tx = await buildSubscriptionTransaction({ program, wallet, connection });

  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
});
