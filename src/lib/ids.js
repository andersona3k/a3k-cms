'use strict';

const crypto = require('crypto');

// Serial legivel do device: A3K-XXXXXX (base32 sem ambiguidade).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newSerial() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `A3K-${s}`;
}

// Segredo opaco do device (Bearer nos endpoints de player).
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { newSerial, newToken };
