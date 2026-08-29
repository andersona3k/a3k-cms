'use strict';

// Editor de playlist: condicional herdada da biblioteca + personalizada por item,
// e regra de grupo por item (bloco "Reproducao") no manifest do device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m15-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m15';
process.env.SEED_ADMIN_EMAIL = 'admin@m15.local';
process.env.SEED_ADMIN_PASSWORD = 'm15-senha-123';
process.env.SEED_COMPANY_NAME = 'M15Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { groupRuleAllows, validateGroupRule } = require('../src/lib/groupRule');
const { isActive } = require('../src/lib/schedule');

let server, baseUrl, token, imgId, plId;

async function req(method, p, { json, deviceToken } = {}) {
  const headers = {};
  if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
  else headers.authorization = `Bearer ${token}`;
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
  token = (await req('POST', '/api/auth/login', { json: { email: 'admin@m15.local', password: 'm15-senha-123' } })).body.token;

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC', 'base64');
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'x.png');
  imgId = (await (await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd })).json()).asset.id;
  plId = (await req('POST', '/api/playlists', { json: { name: 'PL' } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('validateGroupRule + groupRuleAllows', () => {
  assert.deepEqual(validateGroupRule(null).value, null);
  assert.deepEqual(validateGroupRule({ mode: 'allow', groups: [] }).value, null);
  assert.equal(validateGroupRule({ mode: 'x', groups: [1] }).ok, false);
  assert.deepEqual(validateGroupRule({ mode: 'allow', groups: [3, 1, 1] }).value, { mode: 'allow', groups: [1, 3] });

  assert.equal(groupRuleAllows(null, 5), true);
  assert.equal(groupRuleAllows({ mode: 'allow', groups: [2] }, 2), true);
  assert.equal(groupRuleAllows({ mode: 'allow', groups: [2] }, 3), false);
  assert.equal(groupRuleAllows({ mode: 'allow', groups: [2] }, null), false);
  assert.equal(groupRuleAllows({ mode: 'deny', groups: [2] }, 2), false);
  assert.equal(groupRuleAllows({ mode: 'deny', groups: [2] }, 3), true);
});

test('isActive aceita from/until com data+hora', () => {
  const s = { from: '2026-01-01T10:00', until: '2026-01-01T12:00' };
  assert.equal(isActive(s, new Date('2026-01-01T11:00')), true);
  assert.equal(isActive(s, new Date('2026-01-01T09:59')), false);
  assert.equal(isActive(s, new Date('2026-01-01T12:30')), false);
  // data pura continua funcionando
  assert.equal(isActive({ from: '2026-01-01', until: '2026-01-02' }, new Date('2026-01-01T23:00')), true);
});

test('item herda a condicional do arquivo; personalizada sobrepoe', async () => {
  // condicional na biblioteca (asset)
  await req('PATCH', `/api/assets/${imgId}`, { json: { schedule: { days: [1, 2, 3], start: '08:00', end: '18:00' } } });
  const add = await req('POST', `/api/playlists/${plId}/items`, { json: { asset_id: imgId, duration: 5 } });
  const itemId = add.body.item.id;

  // itemsOf mostra as duas
  let full = await req('GET', `/api/playlists/${plId}`);
  let it = full.body.items.find((x) => x.id === itemId);
  assert.deepEqual(it.asset_schedule, { days: [1, 2, 3], start: '08:00', end: '18:00' });
  assert.equal(it.schedule, null);

  // no manifest o item herda a schedule do arquivo
  let m = await req('GET', `/api/playlists/${plId}/manifest`);
  assert.deepEqual(m.body.items.find((x) => x.id === itemId).schedule, { days: [1, 2, 3], start: '08:00', end: '18:00' });

  // personalizada sobrepoe
  await req('PATCH', `/api/playlists/${plId}/items/${itemId}`, { json: { schedule: { start: '20:00', end: '22:00' } } });
  m = await req('GET', `/api/playlists/${plId}/manifest`);
  assert.deepEqual(m.body.items.find((x) => x.id === itemId).schedule, { start: '20:00', end: '22:00' });

  // limpar volta a herdar
  await req('PATCH', `/api/playlists/${plId}/items/${itemId}`, { json: { schedule: null } });
  m = await req('GET', `/api/playlists/${plId}/manifest`);
  assert.deepEqual(m.body.items.find((x) => x.id === itemId).schedule, { days: [1, 2, 3], start: '08:00', end: '18:00' });
});

test('group_rule filtra o manifest do device pelo grupo', async () => {
  const gA = (await req('POST', '/api/device-groups', { json: { name: 'GrupoA' } })).body.group.id;
  const gB = (await req('POST', '/api/device-groups', { json: { name: 'GrupoB' } })).body.group.id;

  const pl2 = (await req('POST', '/api/playlists', { json: { name: 'PL2' } })).body.playlist.id;
  const i1 = (await req('POST', `/api/playlists/${pl2}/items`, { json: { asset_id: imgId, duration: 3 } })).body.item.id;
  const i2 = (await req('POST', `/api/playlists/${pl2}/items`, { json: { asset_id: imgId, duration: 3 } })).body.item.id;
  const i3 = (await req('POST', `/api/playlists/${pl2}/items`, { json: { asset_id: imgId, duration: 3 } })).body.item.id;
  // i1: só GrupoA;  i2: todos menos GrupoA;  i3: sem regra
  await req('PATCH', `/api/playlists/${pl2}/items/${i1}`, { json: { group_rule: { mode: 'allow', groups: [gA] } } });
  await req('PATCH', `/api/playlists/${pl2}/items/${i2}`, { json: { group_rule: { mode: 'deny', groups: [gA] } } });

  // device no GrupoA
  const dA = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-A' } });
  await req('PATCH', `/api/devices/${dA.body.deviceId}`, { json: { group_id: gA } });
  await req('POST', `/api/device-groups/${gA}/assign`, { json: { playlist_id: pl2 } });
  let mA = await req('GET', `/api/devices/${dA.body.deviceId}/manifest?v=-1&p=-1`, { deviceToken: dA.body.token });
  const idsA = mA.body.items.map((x) => x.id);
  assert.deepEqual(idsA, [i1, i3]); // i2 (deny GrupoA) fora

  // device no GrupoB
  const dB = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-B' } });
  await req('PATCH', `/api/devices/${dB.body.deviceId}`, { json: { group_id: gB } });
  await req('POST', `/api/device-groups/${gB}/assign`, { json: { playlist_id: pl2 } });
  const mB = await req('GET', `/api/devices/${dB.body.deviceId}/manifest?v=-1&p=-1`, { deviceToken: dB.body.token });
  assert.deepEqual(mB.body.items.map((x) => x.id), [i2, i3]); // i1 (allow só GrupoA) fora

  // preview do admin (sem grupo) mostra os 3
  const prev = await req('GET', `/api/playlists/${pl2}/manifest`);
  assert.equal(prev.body.items.length, 3);
});
