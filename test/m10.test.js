'use strict';

// Fase 3: trilha de auditoria (activity_log) + carimbo last_version_at.
// Cobre GET /api/devices/:id/activity mesclando device + grupo, com actor_email.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m10-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m10';
process.env.SEED_ADMIN_EMAIL = 'admin@m10.local';
process.env.SEED_ADMIN_PASSWORD = 'm10-senha-123';
process.env.SEED_COMPANY_NAME = 'M10Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, plId, plId2, devId, devToken, grpId;

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

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m10.local', password: 'm10-senha-123' } })).body.token;

  plId = (await req('POST', '/api/playlists', { json: { name: 'PL-A' } })).body.playlist.id;
  plId2 = (await req('POST', '/api/playlists', { json: { name: 'PL-B' } })).body.playlist.id;
  grpId = (await req('POST', '/api/device-groups', { json: { name: 'Loja' } })).body.group.id;

  const pair = await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-m10' } });
  devId = pair.body.deviceId;
  devToken = pair.body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('atribuir playlist ao device gera entrada de auditoria com actor_email', async () => {
  await req('POST', `/api/devices/${devId}/assign`, { json: { playlist_id: plId } });
  const r = await req('GET', `/api/devices/${devId}/activity`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.activity));
  const top = r.body.activity[0];
  assert.equal(top.action, 'assign');
  assert.equal(top.target_type, 'device');
  assert.equal(top.actor_email, 'admin@m10.local');
  assert.match(top.detail, /PL-A/);
});

test('mover device p/ grupo e reatribuir playlist entram no historico (mais recente primeiro)', async () => {
  await req('PATCH', `/api/devices/${devId}`, { json: { group_id: grpId } });
  await req('POST', `/api/devices/${devId}/assign`, { json: { playlist_id: plId2 } });
  const acts = (await req('GET', `/api/devices/${devId}/activity`)).body.activity;
  assert.match(acts[0].detail, /PL-B/);          // reassign foi o ultimo
  assert.ok(acts.some((a) => a.action === 'group'));
});

test('activity do device mescla eventos do grupo dele', async () => {
  await req('POST', `/api/device-groups/${grpId}/assign`, { json: { playlist_id: plId } });
  const acts = (await req('GET', `/api/devices/${devId}/activity`)).body.activity;
  const grpEvt = acts.find((a) => a.target_type === 'group');
  assert.ok(grpEvt, 'evento do grupo aparece no historico do device');
  assert.match(grpEvt.detail, /Loja/);
});

test('limit corta em N (default 5)', async () => {
  for (let i = 0; i < 8; i++) {
    await req('PATCH', `/api/devices/${devId}`, { json: { name: `n${i}` } });
  }
  const def = (await req('GET', `/api/devices/${devId}/activity`)).body.activity;
  assert.equal(def.length, 5);
  const three = (await req('GET', `/api/devices/${devId}/activity?limit=3`)).body.activity;
  assert.equal(three.length, 3);
});

test('last_version_at e setado quando o heartbeat reporta versao nova', async () => {
  let dev = (await req('GET', `/api/devices/${devId}`)).body.device;
  assert.equal(dev.last_version_at, null);

  await req('POST', `/api/devices/${devId}/heartbeat`, { deviceToken: devToken, json: { playlist_version: 1 } });
  dev = (await req('GET', `/api/devices/${devId}`)).body.device;
  assert.equal(dev.last_version, 1);
  assert.ok(dev.last_version_at, 'carimbo preenchido na 1a versao aplicada');

  const firstStamp = dev.last_version_at;
  // mesmo valor -> nao remexe o carimbo
  await req('POST', `/api/devices/${devId}/heartbeat`, { deviceToken: devToken, json: { playlist_version: 1 } });
  dev = (await req('GET', `/api/devices/${devId}`)).body.device;
  assert.equal(dev.last_version_at, firstStamp);
});
