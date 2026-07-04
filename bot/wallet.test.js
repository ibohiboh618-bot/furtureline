const test = require('node:test');
const assert = require('node:assert/strict');

const { createWalletSetup, verifyWalletPin, decryptSecret } = require('./wallet');

test('createWalletSetup creates an address and verifies the pin', () => {
  const result = createWalletSetup({ pin: '123456' });

  assert.match(result.address, /^0x[0-9a-f]{40}$/i);
  assert.equal(result.pinHash.length > 0, true);
  assert.equal(verifyWalletPin({ pin: '123456', pinHash: result.pinHash }), true);
  assert.equal(verifyWalletPin({ pin: '654321', pinHash: result.pinHash }), false);
  assert.equal(decryptSecret({ ciphertext: result.encryptedPrivateKey, iv: result.iv }), result.privateKey);
});
