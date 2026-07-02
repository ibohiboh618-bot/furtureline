const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');

const DEVNET_PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const MAINNET_PROGRAM_ID = new PublicKey('9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunGgcKaA');

let cachedProgram = null;
let cachedWallet = null;

function resolveProgramId(rpcUrl) {
  const isMainnet = rpcUrl && !rpcUrl.includes('devnet') && !rpcUrl.includes('localhost') && !rpcUrl.includes('127.0.0.1');
  return isMainnet ? MAINNET_PROGRAM_ID : DEVNET_PROGRAM_ID;
}

function loadWalletKeypair() {
  if (cachedWallet) return cachedWallet;

  const walletPath = process.env.SOLANA_WALLET_KEYPAIR_PATH || './secrets/wallet.json';
  const resolvedPath = path.resolve(process.cwd(), walletPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Solana wallet file not found at ${resolvedPath}. Set SOLANA_WALLET_KEYPAIR_PATH in your environment.`);
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')));
  cachedWallet = Keypair.fromSecretKey(secretKey);
  return cachedWallet;
}

async function getValidationProgram() {
  if (cachedProgram) return cachedProgram;

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(loadWalletKeypair());
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const programId = new PublicKey(process.env.TXODDS_PROGRAM_ID || resolveProgramId(rpcUrl));

  const idl = await anchor.Program.fetchIdl(programId, provider);
  if (!idl) {
    throw new Error('Unable to load TxODDS Anchor IDL for proof validation.');
  }

  cachedProgram = new anchor.Program(idl, programId, provider);
  return cachedProgram;
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}

function normalizeProofNode(node) {
  if (!node) return null;
  const hash = node.hash;
  let hashBytes;
  if (typeof hash === 'string') {
    if (/^[0-9a-fA-F]+$/.test(hash)) {
      hashBytes = Uint8Array.from(Buffer.from(hash, 'hex'));
    } else {
      hashBytes = Uint8Array.from(Buffer.from(hash, 'base64'));
    }
  } else if (Array.isArray(hash)) {
    hashBytes = Uint8Array.from(hash);
  } else if (hash?.data) {
    hashBytes = Uint8Array.from(hash.data);
  } else {
    throw new Error('Unsupported proof node hash type');
  }

  return {
    hash: hashBytes,
    isRightSibling: node.isRightSibling ?? node.is_right_sibling ?? node.is_right ?? false,
  };
}

function normalizeProofArray(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(normalizeProofNode);
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const normalized = { ...snapshot };
  for (const key of Object.keys(normalized)) {
    normalized[key] = normalizeNumber(normalized[key]);
  }
  return normalized;
}

async function verifyFixtureProof(proofPayload) {
  const program = await getValidationProgram();

  const snapshot = normalizeSnapshot(proofPayload.snapshot || proofPayload.Snapshot || proofPayload.fixture);
  const summary = normalizeSnapshot(proofPayload.summary || proofPayload.Summary || proofPayload.batchSummary);
  const subTreeProof = normalizeProofArray(proofPayload.subTreeProof || proofPayload.sub_tree_proof || proofPayload.sub_tree_proof_nodes || proofPayload.subProof);
  const mainTreeProof = normalizeProofArray(proofPayload.mainTreeProof || proofPayload.main_tree_proof || proofPayload.main_tree_proof_nodes || proofPayload.mainProof);

  if (!snapshot || !summary || !Array.isArray(subTreeProof) || !Array.isArray(mainTreeProof)) {
    throw new Error('The proof payload does not contain the expected snapshot/summary/proof fields.');
  }

  const [tenDailyFixturesRoots] = await PublicKey.findProgramAddressSync(
    [Buffer.from('ten_daily_fixtures_roots')],
    program.programId
  );

  const txSig = await program.methods
    .validateFixture(snapshot, summary, subTreeProof, mainTreeProof)
    .accounts({ tenDailyFixturesRoots })
    .rpc();

  return txSig;
}

module.exports = {
  verifyFixtureProof,
};
