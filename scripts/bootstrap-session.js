// scripts/bootstrap-session.js
//
// Utility script to initialize/bootstrap the TxODDS session in Postgres.
// Automatically:
//   1. Parses `.env` for database, RPC URL, and wallet paths.
//   2. Generates a new Solana wallet if one does not exist at SOLANA_WALLET_KEYPAIR_PATH.
//   3. Airdrops devnet SOL if the wallet has a 0 balance.
//   4. Fetches the IDL on-chain (falling back to a minimal definition if needed).
//   5. Runs the on-chain subscription registration and saves the session to Postgres.

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { bootstrapSession } = require('../ingestion/workers/session-keeper');

// Load environment variables manually
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let value = parts.slice(1).join('=').trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

const DEVNET_PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const DEVNET_TOKEN_MINT = new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG');

// Minimal fallback IDL in case fetchIdl fails or fails offline
const FALLBACK_IDL = {
  version: '0.1.0',
  name: 'txline',
  instructions: [
    {
      name: 'subscribe',
      accounts: [
        { name: 'user', isMut: true, isSigner: true },
        { name: 'pricingMatrix', isMut: false, isSigner: false },
        { name: 'tokenMint', isMut: false, isSigner: false },
        { name: 'userTokenAccount', isMut: true, isSigner: false },
        { name: 'tokenTreasuryVault', isMut: true, isSigner: false },
        { name: 'tokenTreasuryPda', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'associatedTokenProgram', isMut: false, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false }
      ],
      args: [
        { name: 'serviceLevel', type: 'u32' },
        { name: 'durationWeeks', type: 'u32' }
      ]
    }
  ]
};

async function main() {
  const walletPath = process.env.SOLANA_WALLET_KEYPAIR_PATH || './secrets/wallet.json';
  const resolvedWalletPath = path.resolve(__dirname, '..', walletPath);
  const walletDir = path.dirname(resolvedWalletPath);

  if (!fs.existsSync(walletDir)) {
    fs.mkdirSync(walletDir, { recursive: true });
  }

  let walletKeypair;
  if (!fs.existsSync(resolvedWalletPath)) {
    console.log('[bootstrap] Generating a new Solana wallet keypair...');
    walletKeypair = Keypair.generate();
    fs.writeFileSync(resolvedWalletPath, JSON.stringify(Array.from(walletKeypair.secretKey)));
    console.log(`[bootstrap] Wallet generated and saved to ${walletPath}`);
  } else {
    console.log(`[bootstrap] Loading existing wallet from ${walletPath}...`);
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(resolvedWalletPath, 'utf8')));
    walletKeypair = Keypair.fromSecretKey(secretKey);
  }

  console.log(`[bootstrap] Wallet PublicKey: ${walletKeypair.publicKey.toBase58()}`);

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  console.log(`[bootstrap] Connecting to Solana RPC: ${rpcUrl}...`);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Request devnet airdrop if needed
  let balance = await connection.getBalance(walletKeypair.publicKey);
  console.log(`[bootstrap] Wallet Balance: ${balance / 1e9} SOL`);

  if (balance === 0 && rpcUrl.includes('devnet')) {
    console.log('[bootstrap] Requesting devnet SOL airdrop...');
    try {
      const signature = await connection.requestAirdrop(walletKeypair.publicKey, 1e9); // 1 SOL
      await connection.confirmTransaction(signature, 'confirmed');
      balance = await connection.getBalance(walletKeypair.publicKey);
      console.log(`[bootstrap] Airdrop confirmed. New Balance: ${balance / 1e9} SOL`);
    } catch (err) {
      console.warn('[bootstrap] Airdrop failed (rate limit/faucet dry). Please fund the wallet manually if required:', err.message);
    }
  }

  // Set up Anchor provider
  const walletWrapper = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, walletWrapper, {
    commitment: 'confirmed',
  });

  // Construct Anchor Program client
  console.log('[bootstrap] Loading Anchor Program...');
  let idl;
  try {
    idl = await anchor.Program.fetchIdl(DEVNET_PROGRAM_ID, provider);
    console.log('[bootstrap] Successfully fetched IDL from on-chain.');
  } catch (err) {
    console.log('[bootstrap] Fetching IDL failed, falling back to minimal local definitions:', err.message);
    idl = FALLBACK_IDL;
  }

  const program = new anchor.Program(idl, provider);
  // Attach custom property required by auth.js
  program.subscriptionTokenMint = DEVNET_TOKEN_MINT;

  console.log('[bootstrap] Executing bootstrapSession()...');
  const session = await bootstrapSession({ walletKeypair, program });
  console.log('[bootstrap] Session bootstrapped successfully in database!');
  console.log('[bootstrap] JWT expiration:', session.jwtExpiresAt);
}

main()
  .then(() => {
    console.log('[bootstrap] Completed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[bootstrap] Failed:', err);
    process.exit(1);
  });
