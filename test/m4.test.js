'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m4-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m4';
process.env.SEED_ADMIN_EMAIL = 'admin@m4.local';
process.env.SEED_ADMIN_PASSWORD = 'm4-senha-123';
process.env.SEED_COMPANY_NAME = 'M4Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
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

let plA, plB, groupId;

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m4.local', password: 'm4-senha-123' } })).body.token;
  plA = (await req('POST', '/api/playlists', { json: { name: 'PL-A' } })).body.playlist.id;
  plB = (await req('POST', '/api/playlists', { json: { name: 'PL-B' } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('device-groups: cria, rejeita duplicado, renomeia', async () => {
  const a = await req('POST', '/api/device-groups', { json: { name: 'Loja Centro' } });
  assert.equal(a.status, 201);
  groupId = a.body.group.id;
  assert.equal((await req('POST', '/api/device-groups', { json: { name: 'Loja Centro' } })).status, 409);
  const ren = await req('PATCH', `/api/device-groups/${groupId}`, { json: { name: 'Loja Centro 1' } });
  assert.equal(ren.body.group.name, 'Loja Centro 1');
});

let reqCode, reqId;

test('pair request: gera codigo + provisionamento do adapter', async () => {
  const r = await req('POST', '/api/pair/requests', {
    json: { name: 'TV Recepcao', group_id: groupId, player_type: 'android' },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.request.code, /^[A-Z2-9]{6}$/);
  assert.equal(r.body.request.status, 'pending');
  assert.equal(r.body.request.group.id, groupId);
  assert.equal(r.body.provisioning.type, 'android');
  assert.equal(r.body.provisioning.method, 'apk');
  reqCode = r.body.request.code;
  reqId = r.body.request.id;
});

test('pair request: group_id / player_type invalidos -> 400', async () => {
  assert.equal((await req('POST', '/api/pair/requests', { json: { group_id: 99999 } })).status, 400);
  assert.equal((await req('POST', '/api/pair/requests', { json: { player_type: 'plasma' } })).status, 400);
});

let devId, devToken;

test('pair/new com codigo: device nasce vinculado e consome a solicitacao', async () => {
  const r = await req('POST', '/api/pair/new', {
    auth: false,
    json: { code: reqCode.toLowerCase(), hardware_id: 'hw-tv-1' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.claimed, true);
  devId = r.body.deviceId;
  devToken = r.body.token;

  const dev = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(devId);
  assert.equal(dev.name, 'TV Recepcao');
  assert.equal(dev.group_id, groupId);
  assert.equal(dev.player_type, 'android');

  const pr = await req('GET', `/api/pair/requests/${reqId}`);
  assert.equal(pr.body.request.status, 'consumed');
  assert.equal(pr.body.request.device.id, devId);
});

test('pair/new com codigo ja consumido -> 400', async () => {
  const r = await req('POST', '/api/pair/new', { auth: false, json: { code: reqCode, hardware_id: 'hw-x' } });
  assert.equal(r.status, 400);
});

test('cancelar solicitacao invalida o codigo', async () => {
  const mk = await req('POST', '/api/pair/requests', { json: { name: 'Cancelar' } });
  const del = await req('DELETE', `/api/pair/requests/${mk.body.request.id}`);
  assert.equal(del.status, 200);
  const use = await req('POST', '/api/pair/new', { auth: false, json: { code: mk.body.request.code } });
  assert.equal(use.status, 400);
});

test('heranca de grupo: device sem assignment proprio toca a playlist do grupo', async () => {
  await req('POST', `/api/device-groups/${groupId}/assign`, { json: { playlist_id: plA } });

  const d = await req('GET', `/api/devices/${devId}`);
  assert.equal(d.body.device.effective_playlist.id, plA);
  assert.equal(d.body.device.effective_playlist.source, 'group');
  assert.equal(d.body.device.own_playlist, null);
  assert.equal(d.body.manifest.playlist.id, plA);
});

test('assignment proprio do device sobrepoe o do grupo', async () => {
  await req('POST', `/api/devices/${devId}/assign`, { json: { playlist_id: plB } });
  const d = await req('GET', `/api/devices/${devId}`);
  assert.equal(d.body.device.effective_playlist.id, plB);
  assert.equal(d.body.device.effective_playlist.source, 'device');

  await req('DELETE', `/api/devices/${devId}/assign`);
  const d2 = await req('GET', `/api/devices/${devId}`);
  assert.equal(d2.body.device.effective_playlist.id, plA);
  assert.equal(d2.body.device.effective_playlist.source, 'group');
});

test('manifest ?p= detecta troca de playlist mesmo com version igual', async () => {
  // device herda PL-A (v1, sem itens). 304 esperado com v e p corretos.
  const m1 = await req('GET', `/api/devices/${devId}/manifest?v=1&p=${plA}`, { deviceToken: devToken });
  assert.equal(m1.status, 304);

  // grupo passa a apontar p/ PL-B, tambem v1
  await req('POST', `/api/device-groups/${groupId}/assign`, { json: { playlist_id: plB } });

  // mesmo v=1, mas p aponta p/ a playlist antiga -> tem que devolver 200
  const m2 = await req('GET', `/api/devices/${devId}/manifest?v=1&p=${plA}`, { deviceToken: devToken });
  assert.equal(m2.status, 200);
  assert.equal(m2.body.playlist.id, plB);

  // agora com p correto -> 304
  const m3 = await req('GET', `/api/devices/${devId}/manifest?v=1&p=${plB}`, { deviceToken: devToken });
  assert.equal(m3.status, 304);

  // volta o grupo p/ PL-A
  await req('POST', `/api/device-groups/${groupId}/assign`, { json: { playlist_id: plA } });
});

test('mover device p/ fora do grupo remove a heranca', async () => {
  await req('PATCH', `/api/devices/${devId}`, { json: { group_id: null } });
  const d = await req('GET', `/api/devices/${devId}`);
  assert.equal(d.body.device.group_id, null);
  assert.equal(d.body.device.effective_playlist, null);
});

test('bulk: POST /device-groups/:id/devices move varios', async () => {
  // cria mais 2 devices soltos
  const d2 = (await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-2' } })).body.deviceId;
  const d3 = (await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-3' } })).body.deviceId;
  const r = await req('POST', `/api/device-groups/${groupId}/devices`, { json: { device_ids: [devId, d2, d3] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 3);
  const list = await req('GET', '/api/devices');
  const inGroup = list.body.devices.filter((x) => x.group_id === groupId).map((x) => x.id).sort();
  assert.deepEqual(inGroup, [devId, d2, d3].sort());

  // device_id invalido -> 400
  assert.equal((await req('POST', `/api/device-groups/${groupId}/devices`, { json: { device_ids: [999999] } })).status, 400);
});

test('deletar grupo desagrupa devices e remove o assignment do grupo', async () => {
  const del = await req('DELETE', `/api/device-groups/${groupId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ungrouped_devices, 3);

  const list = await req('GET', '/api/devices');
  assert.ok(list.body.devices.every((x) => x.group_id === null));
  assert.ok(list.body.devices.every((x) => x.effective_playlist === null));

  const groups = await req('GET', '/api/device-groups');
  assert.equal(groups.body.groups.length, 0);
});

test('endpoints de grupo exigem JWT', async () => {
  assert.equal((await req('GET', '/api/device-groups', { auth: false })).status, 401);
  assert.equal((await req('POST', '/api/pair/requests', { auth: false, json: {} })).status, 401);
});

test('DELETE /api/devices/:id remove o device e seu assignment', async () => {
  const d = (await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-del' } })).body.deviceId;
  const pl = (await req('POST', '/api/playlists', { json: { name: 'PL-dev-del' } })).body.playlist.id;
  await req('POST', `/api/devices/${d}/assign`, { json: { playlist_id: pl } });

  const del = await req('DELETE', `/api/devices/${d}`);
  assert.equal(del.status, 200);
  assert.equal((await req('GET', `/api/devices/${d}`)).status, 404);
  const gone = getDb().prepare(
    `SELECT COUNT(*) n FROM assignments WHERE target_type='device' AND target_id=?`
  ).get(d).n;
  assert.equal(gone, 0);
  assert.equal((await req('DELETE', `/api/devices/${d}`)).status, 404);
});
