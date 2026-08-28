'use strict';

// Fase 3: parametros por item (orientacao herdada, suspender, duracao de video travada).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m9-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m9';
process.env.SEED_ADMIN_EMAIL = 'admin@m9.local';
process.env.SEED_ADMIN_PASSWORD = 'm9-senha-123';
process.env.SEED_COMPANY_NAME = 'M9Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, imgId, vidId, plId;

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
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m9.local', password: 'm9-senha-123' } })).body.token;

  // imagem
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC', 'base64');
  let fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  imgId = (await (await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd })).json()).asset.id;

  // video curto (h264) via ffmpeg-static
  const ff = require('ffmpeg-static');
  const src = path.join(TMP, 'v.mp4');
  execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { timeout: 60000 });
  fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(src)], { type: 'video/mp4' }), 'clip.mp4');
  vidId = (await (await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd })).json()).asset.id;

  plId = (await req('POST', '/api/playlists', { json: { name: 'PL', rotation: 90 } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('playlist aceita mirror; PATCH mirror bumpa version', async () => {
  const before = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;
  const r = await req('PATCH', `/api/playlists/${plId}`, { json: { rotation: 90, mirror: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.playlist.mirror, 1);
  assert.equal(r.body.playlist.version, before + 1);
  await req('PATCH', `/api/playlists/${plId}`, { json: { mirror: 0 } });
});

test('video: duracao e a do arquivo e nao pode ser editada', async () => {
  const add = await req('POST', `/api/playlists/${plId}/items`, { json: { asset_id: vidId, duration: 3 } });
  assert.equal(add.status, 201);
  const vItem = (await req('GET', `/api/playlists/${plId}`)).body.items.find((i) => i.asset_id === vidId);
  assert.ok(vItem.duration > 1.5 && vItem.duration < 2.5, 'duracao ~2s do arquivo, nao 3');
  assert.equal(vItem.duration_locked, true);

  const before = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;
  await req('PATCH', `/api/playlists/${plId}/items/${vItem.id}`, { json: { duration: 99 } });
  const after = (await req('GET', `/api/playlists/${plId}`)).body;
  assert.equal(after.items.find((i) => i.id === vItem.id).duration, vItem.duration, 'PATCH duration ignorado p/ video');
  assert.equal(after.playlist.version, before, 'sem mudanca -> sem bump');
});

test('item: orientacao herda por padrao; override e "herda" (null)', async () => {
  const add = await req('POST', `/api/playlists/${plId}/items`, { json: { asset_id: imgId } });
  const itemId = add.body.item.id;
  assert.equal(add.body.item.rotation, null);
  assert.equal(add.body.item.mirror, null);

  // override p/ 270 espelhado
  let r = await req('PATCH', `/api/playlists/${plId}/items/${itemId}`, { json: { rotation: 270, mirror: 1 } });
  assert.equal(r.status, 200);
  let it = r.body.items.find((i) => i.id === itemId);
  assert.equal(it.rotation, 270);
  assert.equal(it.mirror, 1);

  // volta p/ herda
  r = await req('PATCH', `/api/playlists/${plId}/items/${itemId}`, { json: { rotation: null, mirror: null } });
  it = r.body.items.find((i) => i.id === itemId);
  assert.equal(it.rotation, null);
  assert.equal(it.mirror, null);

  // rotation invalida
  assert.equal((await req('PATCH', `/api/playlists/${plId}/items/${itemId}`, { json: { rotation: 45 } })).status, 400);
});

test('manifest carrega orientacao da playlist e por item', async () => {
  const items = (await req('GET', `/api/playlists/${plId}`)).body.items;
  const imgItem = items.find((i) => i.asset_id === imgId);
  await req('PATCH', `/api/playlists/${plId}/items/${imgItem.id}`, { json: { rotation: 180, mirror: 0 } });

  const m = (await req('GET', `/api/playlists/${plId}/manifest`)).body;
  assert.equal(m.rotation, 90);
  assert.equal(m.mirror, 0);
  const mi = m.items.find((i) => i.id === imgItem.id);
  assert.equal(mi.rotation, 180);
  assert.equal(mi.mirror, 0);
  const mv = m.items.find((i) => i.type === 'video');
  assert.equal(mv.rotation, null); // herda
});

test('suspender: item some do manifest mas continua no detalhe', async () => {
  const items = (await req('GET', `/api/playlists/${plId}`)).body.items;
  const target = items[0];
  const v1 = (await req('GET', `/api/playlists/${plId}`)).body.playlist.version;

  const r = await req('PATCH', `/api/playlists/${plId}/items/${target.id}`, { json: { suspended: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.find((i) => i.id === target.id).suspended, true);
  assert.equal(r.body.version, v1 + 1, 'suspender bumpa version');

  // sumiu do manifest
  const m = (await req('GET', `/api/playlists/${plId}/manifest`)).body;
  assert.ok(m.items.every((i) => i.id !== target.id));
  // mas ainda aparece no detalhe do admin
  const det = (await req('GET', `/api/playlists/${plId}`)).body;
  assert.ok(det.items.some((i) => i.id === target.id && i.suspended === true));

  // retomar traz de volta
  await req('PATCH', `/api/playlists/${plId}/items/${target.id}`, { json: { suspended: false } });
  const m2 = (await req('GET', `/api/playlists/${plId}/manifest`)).body;
  assert.ok(m2.items.some((i) => i.id === target.id));
});

test('manifest de device tambem exclui suspensos', async () => {
  const pair = await req('POST', '/api/pair/new', { auth: false, json: { hardware_id: 'hw-m9' } });
  await req('POST', `/api/devices/${pair.body.deviceId}/assign`, { json: { playlist_id: plId } });
  const items = (await req('GET', `/api/playlists/${plId}`)).body.items;
  await req('PATCH', `/api/playlists/${plId}/items/${items[0].id}`, { json: { suspended: true } });

  const dm = await req('GET', `/api/devices/${pair.body.deviceId}/manifest?v=-1&p=-1`, { deviceToken: pair.body.token });
  assert.equal(dm.status, 200);
  assert.ok(dm.body.items.every((i) => i.id !== items[0].id));
  assert.equal(dm.body.mirror, 0);
});
