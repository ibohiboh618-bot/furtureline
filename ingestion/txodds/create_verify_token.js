#!/usr/bin/env node
// Simple helper to create a random verify token for VERIFY_SERVICE_TOKEN.
const crypto = require('crypto');

function generateToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

console.log(generateToken(24));

// Usage: node create_verify_token.js  -> copy the token and set VERIFY_SERVICE_TOKEN in env/secret store
