'use strict';

// Orientação da tela = propriedade do device (ativação + PATCH + F2/rotate90).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m19-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m19';
process.env.SEED_ADMIN_EMAIL = 'admin@m19.local';
process.env.SEED_ADMIN_PASSWORD = 'm19-senha-123';
process.env.SEED_COMPANY_NAME = 'M19Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, plId;

async function A(method, p, json) {
  const h = { authorization: `Bearer ${token}` };
  if (json !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}${p}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function pub(method, p, json) {
  const h = {};
  if (json !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}${p}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await pub('POST', '/api/auth/login', { email: 'admin@m19.local', password: 'm19-senha-123' })).body.token;
  plId = (await A('POST', '/api/playlists', { name: 'PL' })).body.playlist.id;
});
test.after(() => { if (server) server.close(); closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('device nasce com orientation 0; PATCH aceita 0/90/180/270 e rejeita o resto', async () => {
  const p = (await pub('POST', '/api/pair/new', { hardware_id: 'hw-o1' })).body;
  const id = p.deviceId;
  assert.equal((await A('GET', `/api/devices/${id}`)).body.device.orientation, 0);
  assert.equal((await A('PATCH', `/api/devices/${id}`, { orientation: 45 })).status, 400);
  assert.equal((await A('PATCH', `/api/devices/${id}`, { orientation: 90 })).status, 200);
  assert.equal((await A('GET', `/api/devices/${id}`)).body.device.orientation, 90);
});

test('manifest do device carrega deviceRotation', async () => {
  const p = (await pub('POST', '/api/pair/new', { hardware_id: 'hw-o2' })).body;
  await A('PATCH', `/api/devices/${p.deviceId}`, { orientation: 270 });
  await A('POST', `/api/devices/${p.deviceId}/assign`, { playlist_id: plId });
  const m = await fetch(`${baseUrl}/api/devices/${p.deviceId}/manifest?v=-1&p=-1`, {
    headers: { authorization: `Bearer ${p.token}` },
  }).then((r) => r.json());
  assert.equal(m.deviceRotation, 270);
});

test('activation/redeem grava a orientation escolhida', async () => {
  const a = (await pub('POST', '/api/activation/new', { hardware_id: 'hw-o3' })).body;
  const r = await A('POST', '/api/activation/redeem', { code: a.code, orientation: 90 });
  assert.equal(r.status, 201);
  assert.equal((await A('GET', `/api/devices/${r.body.device.id}`)).body.device.orientation, 90);
});

test('POST /orientation {rotate90} cicla 0->90->180->270->0 (device token)', async () => {
  const p = (await pub('POST', '/api/pair/new', { hardware_id: 'hw-o4' })).body;
  const rot = async () => (await fetch(`${baseUrl}/api/devices/${p.deviceId}/orientation`, {
    method: 'POST', headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rotate90: true }),
  }).then((r) => r.json())).orientation;
  assert.equal(await rot(), 90);
  assert.equal(await rot(), 180);
  assert.equal(await rot(), 270);
  assert.equal(await rot(), 0);
});
