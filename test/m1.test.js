'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m1-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m1';
process.env.SEED_ADMIN_EMAIL = 'admin@m1.local';
process.env.SEED_ADMIN_PASSWORD = 'm1-senha-123';
process.env.SEED_COMPANY_NAME = 'M1Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, adminToken;

async function req(method, p, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: res };
}

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  const login = await req('POST', '/api/auth/login', { json: { email: 'admin@m1.local', password: 'm1-senha-123' } });
  adminToken = login.body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let assetId, playlistId, storedUrl, deviceId, deviceToken;

test('upload de asset grava arquivo e registra no banco', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('PNGDATA-conteudo-de-teste')], { type: 'image/png' }), 'promo.png');
  const r = await req('POST', '/api/assets', { token: adminToken, form: fd });
  assert.equal(r.status, 201);
  assert.equal(r.body.asset.type, 'image');
  assert.ok(r.body.asset.hash);
  assert.match(r.body.asset.url, /^\/assets\/[0-9a-f]{64}\.png$/);
  assetId = r.body.asset.id;
  storedUrl = r.body.asset.url;
});

test('upload do mesmo arquivo faz dedup por hash', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('PNGDATA-conteudo-de-teste')], { type: 'image/png' }), 'outro-nome.png');
  const r = await req('POST', '/api/assets', { token: adminToken, form: fd });
  assert.equal(r.status, 200);
  assert.equal(r.body.deduped, true);
  assert.equal(r.body.asset.id, assetId);
});

test('GET /assets/:file serve os bytes', async () => {
  const r = await fetch(`${baseUrl}${storedUrl}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'PNGDATA-conteudo-de-teste');
});

test('criar playlist e adicionar item incrementa version', async () => {
  const create = await req('POST', '/api/playlists', { token: adminToken, json: { name: 'Vitrine' } });
  assert.equal(create.status, 201);
  playlistId = create.body.playlist.id;
  assert.equal(create.body.playlist.version, 1);

  const add = await req('POST', `/api/playlists/${playlistId}/items`, {
    token: adminToken, json: { asset_id: assetId, duration: 7 },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.version, 2);
});

test('nome de playlist duplicado retorna 409', async () => {
  const r = await req('POST', '/api/playlists', { token: adminToken, json: { name: 'Vitrine' } });
  assert.equal(r.status, 409);
});

test('POST /api/pair/new registra device e devolve credenciais', async () => {
  const r = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-abc', player_type: 'android' } });
  assert.equal(r.status, 201);
  assert.match(r.body.serial, /^A3K-[A-Z2-9]{6}$/);
  assert.ok(r.body.token);
  deviceId = r.body.deviceId;
  deviceToken = r.body.token;
});

test('re-pair pelo mesmo hardware_id mantem serial e troca token', async () => {
  const r = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-abc', player_type: 'android' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.deviceId, deviceId);
  assert.equal(r.body.repaired, true);
  assert.notEqual(r.body.token, deviceToken);
  deviceToken = r.body.token;
});

test('manifest sem assignment: version 0 e sem itens', async () => {
  const r = await req('GET', `/api/devices/${deviceId}/manifest?v=-1`, { token: deviceToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 0);
  assert.equal(r.body.items.length, 0);
  assert.equal(r.body.playlist, null);
});

test('manifest exige token do device e valida o dono', async () => {
  assert.equal((await req('GET', `/api/devices/${deviceId}/manifest`)).status, 401);
  assert.equal((await req('GET', `/api/devices/${deviceId}/manifest`, { token: 'lixo' })).status, 401);
  // token valido, mas de outro id
  const other = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-xyz' } });
  assert.equal((await req('GET', `/api/devices/${deviceId}/manifest`, { token: other.body.token })).status, 403);
});

test('admin atribui playlist ao device e o manifest reflete', async () => {
  const assign = await req('POST', `/api/devices/${deviceId}/assign`, {
    token: adminToken, json: { playlist_id: playlistId },
  });
  assert.equal(assign.status, 200);

  const r = await req('GET', `/api/devices/${deviceId}/manifest?v=0`, { token: deviceToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.playlist.name, 'Vitrine');
  assert.equal(r.body.version, 2);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].type, 'image');
  assert.equal(r.body.items[0].duration, 7);
  assert.match(r.body.items[0].hash, /^sha256:/);
});

test('manifest com v == versao atual retorna 304', async () => {
  const r = await req('GET', `/api/devices/${deviceId}/manifest?v=2`, { token: deviceToken });
  assert.equal(r.status, 304);
});

test('adicionar item bumpa version e quebra o 304', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('video-bytes')], { type: 'video/mp4' }), 'clip.mp4');
  const up = await req('POST', '/api/assets', { token: adminToken, form: fd });
  await req('POST', `/api/playlists/${playlistId}/items`, {
    token: adminToken, json: { asset_id: up.body.asset.id },
  });
  const r = await req('GET', `/api/devices/${deviceId}/manifest?v=2`, { token: deviceToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 3);
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.items[1].type, 'video');
  assert.equal(r.body.items[1].duration, 10); // default
});

test('heartbeat atualiza last_seen e last_version', async () => {
  const r = await req('POST', `/api/devices/${deviceId}/heartbeat`, {
    token: deviceToken, json: { playlist_version: 3, capabilities: { reboot: true } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.currentVersion, 3);
  const dev = getDb().prepare('SELECT last_seen, last_version, capabilities FROM devices WHERE id = ?').get(deviceId);
  assert.ok(dev.last_seen);
  assert.equal(dev.last_version, 3);
  assert.equal(JSON.parse(dev.capabilities).reboot, true);
});

test('listagem admin de devices nao vaza o token', async () => {
  const r = await req('GET', '/api/devices', { token: adminToken });
  assert.equal(r.status, 200);
  const dev = r.body.devices.find((d) => d.id === deviceId);
  assert.equal(dev.token, undefined);
  assert.equal(dev.paired, true);
  assert.equal(dev.assigned_playlist_name, 'Vitrine');
});

test('endpoints admin exigem JWT', async () => {
  assert.equal((await req('GET', '/api/assets')).status, 401);
  assert.equal((await req('GET', '/api/playlists')).status, 401);
  assert.equal((await req('GET', '/api/devices')).status, 401);
});

test('health responde ok', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.service, 'a3k-cms');
});
