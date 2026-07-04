// bot/wallet.js
// Lightweight wallet setup for the onboarding flow.
// The private key is intentionally not exposed in chat until the user unlocks
// the settings screen with the transaction pin.

const crypto = require('node:crypto');

function createWalletSetup({ pin }) {
  if (!pin) throw new Error('A wallet pin is required.');

  const privateKey = crypto.randomBytes(32).toString('hex');
  const address = crypto.createHash('sha256').update(privateKey).digest('hex').slice(0, 40);
  const pinHash = crypto.createHash('sha256').update(String(pin)).digest('hex');
  const { iv, ciphertext } = encryptSecret(privateKey);

  return {
    privateKey,
    address: `0x${address}`,
    pinHash,
    encryptedPrivateKey: ciphertext,
    iv,
    createdAt: new Date().toISOString(),
  };
}

function verifyWalletPin({ pin, pinHash }) {
  const expected = crypto.createHash('sha256').update(String(pin)).digest('hex');
  return expected === pinHash;
}

function encryptSecret(secret) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), ciphertext: encrypted.toString('hex') };
}

function decryptSecret({ ciphertext, iv }) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function getEncryptionKey() {
  const secret = process.env.WALLET_ENCRYPTION_KEY || 'fixtureline-wallet-dev-key';
  return crypto.createHash('sha256').update(secret).digest();
}

module.exports = { createWalletSetup, verifyWalletPin, decryptSecret };
