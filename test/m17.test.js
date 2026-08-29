'use strict';

// Download do APK do player Android (Configuração → Digital → Players).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m17-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m17';
process.env.SEED_ADMIN_EMAIL = 'admin@m17.local';
process.env.SEED_ADMIN_PASSWORD = 'm17-senha-123';
process.env.SEED_COMPANY_NAME = 'M17Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token;

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await (await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@m17.local', password: 'm17-senha-123' }),
  })).json()).token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function upload(name, bytes, bearer) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), name);
  const h = {};
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${baseUrl}/api/downloads/apk`, { method: 'POST', headers: h, body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('info diz que não há APK antes do upload', async () => {
  const r = await (await fetch(`${baseUrl}/api/downloads/apk/info`)).json();
  assert.equal(r.exists, false);
});

test('upload exige auth e extensão .apk', async () => {
  assert.equal((await upload('x.apk', 'PKfake', null)).status, 401);
  assert.equal((await upload('x.txt', 'nope', token)).status, 400);
});

test('upload .apk publica e fica baixável em /downloads', async () => {
  const apk = Buffer.from('PK' + 'x'.repeat(2048));
  const up = await upload('a3k-player-1.0.apk', apk, token);
  assert.equal(up.status, 201);
  assert.equal(up.body.url, '/downloads/a3k-player.apk');
  assert.equal(up.body.size, apk.length);

  const info = await (await fetch(`${baseUrl}/api/downloads/apk/info`)).json();
  assert.equal(info.exists, true);
  assert.equal(info.size, apk.length);

  const dl = await fetch(`${baseUrl}/downloads/a3k-player.apk`);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, apk.length);
});
