'use strict';

// Apaga o arquivo do banco (e WAL/SHM). Uso: npm run reset

const fs = require('fs');
const config = require('../src/config');
const { closeDb } = require('../src/db');

closeDb();
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    console.log(`[reset] removido: ${p}`);
  }
}
console.log('[reset] ok — rode "npm run seed" para recriar.');
