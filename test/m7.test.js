'use strict';

// Fase 3: rotacao (orientacao) na playlist, aplicada pelo player.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m7-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m7';
process.env.SEED_ADMIN_EMAIL = 'admin@m7.local';
process.env.SEED_ADMIN_PASSWORD = 'm7-senha-123';
process.env.SEED_COMPANY_NAME = 'M7Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token;

async function req(method, p, { auth = true, json, deviceToken } = {}) {
  const headers = {};
  if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
  else if (auth) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let plId;

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m7.local', password: 'm7-senha-123' } })).body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('playlist nasce com rotation 0', async () => {
  const r = await req('POST', '/api/playlists', { json: { name: 'Grade' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.playlist.rotation, 0);
  plId = r.body.playlist.id;
});

test('POST aceita rotation valido e rejeita invalido', async () => {
  const ok = await req('POST', '/api/playlists', { json: { name: 'Vertical', rotation: 90 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.playlist.rotation, 90);

  const bad = await req('POST', '/api/playlists', { json: { name: 'X', rotation: 45 } });
  assert.equal(bad.status, 400);
});

test('PATCH rotation bumpa version e reflete no manifest', async () => {
  const before = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;
  const r = await req('PATCH', `/api/playlists/${plId}`, { json: { rotation: 270 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.playlist.rotation, 270);
  assert.equal(r.body.playlist.version, before + 1);

  const man = await req('GET', `/api/playlists/${plId}/manifest`);
  assert.equal(man.body.rotation, 270);
});

test('PATCH rotation igual nao bumpa version', async () => {
  const v1 = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;
  await req('PATCH', `/api/playlists/${plId}`, { json: { rotation: 270 } });
  const v2 = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;
  assert.equal(v2, v1);
});

test('PATCH rotation invalido -> 400', async () => {
  assert.equal((await req('PATCH', `/api/playlists/${plId}`, { json: { rotation: 'landscape' } })).status, 400);
  assert.equal((await req('PATCH', `/api/playlists/${plId}`, { json: { rotation: 360 } })).status, 400);
});

test('manifest de device carrega a rotation da playlist atribuida', async () => {
  const pair = await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-m7' } });
  const { deviceId, token: dtok } = pair.body;
  await req('POST', `/api/devices/${deviceId}/assign`, { json: { playlist_id: plId } });

  const man = await req('GET', `/api/devices/${deviceId}/manifest?v=-1&p=-1`, { deviceToken: dtok });
  assert.equal(man.status, 200);
  assert.equal(man.body.rotation, 270);

  // sem playlist -> rotation 0
  const pair2 = await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-m7b' } });
  const m2 = await req('GET', `/api/devices/${pair2.body.deviceId}/manifest?v=-1&p=-1`, { deviceToken: pair2.body.token });
  assert.equal(m2.body.rotation, 0);
});
