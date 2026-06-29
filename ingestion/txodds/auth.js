// ingestion/txodds/auth.js
//
// Handles the full TxODDS auth handshake for the free World Cup tier:
//   1. Get an anonymous guest JWT
//   2. Submit a Solana `subscribe` transaction (free tier costs 0 TxL,
//      but it is still a real on-chain transaction you pay gas for)
//   3. Sign a message binding {txSig, leagues, jwt} with your wallet
//   4. POST to /api/token/activate to get a long-lived API token
//
// This module is intentionally side-effect-light: it does not decide *when*
// to re-auth, that's the caller's job (see workers/session-keeper.js).

const axios = require('axios');
const nacl = require('tweetnacl');
const anchor = require('@coral-xyz/anchor');
const {
  Connection,
  Keypair,
  SystemProgram,
  PublicKey,
} = require('@solana/web3.js');
const {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Free World Cup tier service levels (see TxODDS docs):
//   1  = World Cup & Int'l Friendlies, 60s delay
//   12 = World Cup & Int'l Friendlies, real-time
const SERVICE_LEVEL_FREE_REALTIME = 12;
const SUBSCRIPTION_DURATION_WEEKS = 4; // must be a multiple of 4

/**
 * Step 1: obtain an anonymous guest JWT.
 * Valid for 30 days. Caller is responsible for refreshing before expiry
 * or on a 401 response from any data endpoint.
 */
async function getGuestJwt() {
  const { data } = await axios.post(`${TXLINE_BASE_URL}/auth/guest/start`);
  return data.token;
}

/**
 * Step 2: submit the on-chain `subscribe` instruction.
 * Returns the confirmed transaction signature (txSig).
 *
 * `program` is an Anchor Program instance already wired to the TxLINE IDL.
 * Wiring that up is environment-specific (devnet vs mainnet program id),
 * so we accept it as a parameter rather than constructing it here.
 */
async function subscribeOnChain({ program, wallet, connection, leagues = [] }) {
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_treasury_v2')],
    program.programId
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    program.subscriptionTokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pricing_matrix')],
    program.programId
  );

  const userTokenAccount = getAssociatedTokenAddressSync(
    program.subscriptionTokenMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_FREE_REALTIME, SUBSCRIPTION_DURATION_WEEKS)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: program.subscriptionTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(txSig, 'confirmed');
  return txSig;
}

/**
 * Step 3 + 4: sign the activation message and exchange it for an API token.
 */
async function activateApiToken({ txSig, leagues, jwt, walletKeypair }) {
  const messageString = `${txSig}:${leagues.join(',')}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, walletKeypair.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString('base64');

  const { data } = await axios.post(
    `${TXLINE_BASE_URL}/api/token/activate`,
    { txSig, walletSignature, leagues },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );

  // The API returns either a bare string or { token: string } depending on
  // deployment -- normalize here so callers don't need to care.
  return typeof data === 'string' ? data : data.token;
}

/**
 * Full handshake, run once per subscription period (every ~4 weeks), or
 * whenever there is no valid session in txodds_session.
 */
async function runFullActivation({ walletKeypair, program }) {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const jwt = await getGuestJwt();

  const txSig = await subscribeOnChain({
    program,
    wallet: { publicKey: walletKeypair.publicKey },
    connection,
    leagues: [], // empty = standard free World Cup bundle
  });

  const apiToken = await activateApiToken({
    txSig,
    leagues: [],
    jwt,
    walletKeypair,
  });

  return { jwt, apiToken, txSig };
}

/**
 * Cheap re-auth: get a fresh guest JWT only. Use this when the existing
 * subscription is still valid on-chain (within its 4-week window) but the
 * 30-day JWT has expired or a 401 was received.
 *
 * NOTE: a fresh JWT alone does not produce a new API token -- the API token
 * is tied to the txSig at activation time. In practice this means: keep the
 * original txSig around, and re-activate with the same txSig + a new JWT if
 * the API token itself ever needs rotating.
 */
async function refreshJwtOnly() {
  return getGuestJwt();
}

module.exports = {
  getGuestJwt,
  subscribeOnChain,
  activateApiToken,
  runFullActivation,
  refreshJwtOnly,
  SERVICE_LEVEL_FREE_REALTIME,
  SUBSCRIPTION_DURATION_WEEKS,
};
