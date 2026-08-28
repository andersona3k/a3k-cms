'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m3-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m3';
process.env.SEED_ADMIN_EMAIL = 'admin@m3.local';
process.env.SEED_ADMIN_PASSWORD = 'm3-senha-123';
process.env.SEED_COMPANY_NAME = 'M3Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function req(method, p, { auth = true, json } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function uploadPng(name) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), name);
  const res = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  return (await res.json()).asset;
}

let playlistId;
let itemIds = [];
let assetIds = [];

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m3.local', password: 'm3-senha-123' } })).body.token;

  // 3 assets distintos (nomes diferentes -> hashes iguais? mesmo conteudo => dedup!).
  // uso conteudos diferentes para evitar dedup.
  for (let i = 0; i < 3; i++) {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.concat([PNG, Buffer.from([i])])], { type: 'image/png' }), `p${i}.png`);
    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
    });
    assetIds.push((await res.json()).asset.id);
  }

  playlistId = (await req('POST', '/api/playlists', { json: { name: 'Ordenar' } })).body.playlist.id;
  for (const aid of assetIds) {
    const r = await req('POST', `/api/playlists/${playlistId}/items`, { json: { asset_id: aid, duration: 5 } });
    itemIds.push(r.body.item.id);
  }
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('setup: 3 itens na ordem de insercao', async () => {
  const r = await req('GET', `/api/playlists/${playlistId}`);
  assert.deepEqual(r.body.items.map((i) => i.id), itemIds);
  assert.equal(r.body.playlist.version, 4); // 1 criacao + 3 add
});

test('GET /api/playlists/:id/manifest tem o shape do manifest de device', async () => {
  const r = await req('GET', `/api/playlists/${playlistId}/manifest`);
  assert.equal(r.status, 200);
  assert.equal(r.body.playlist.name, 'Ordenar');
  assert.equal(r.body.version, 4);
  assert.equal(r.body.items.length, 3);
  const it = r.body.items[0];
  assert.ok(it.url && it.type === 'image' && it.duration === 5);
  assert.match(it.hash, /^sha256:/);
  assert.ok('bytes' in it);
});

test('PUT /order reordena e bumpa a version', async () => {
  const reversed = [...itemIds].reverse();
  const r = await req('PUT', `/api/playlists/${playlistId}/order`, { json: { item_ids: reversed } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i) => i.id), reversed);
  assert.deepEqual(r.body.items.map((i) => i.ordem), [0, 1, 2]);
  assert.equal(r.body.version, 5);

  // e o manifest reflete a nova ordem
  const m = await req('GET', `/api/playlists/${playlistId}/manifest`);
  assert.deepEqual(m.body.items.map((i) => i.id), reversed);
});

test('PUT /order rejeita conjunto que nao bate exatamente', async () => {
  const parcial = await req('PUT', `/api/playlists/${playlistId}/order`, { json: { item_ids: itemIds.slice(0, 2) } });
  assert.equal(parcial.status, 400);

  const extra = await req('PUT', `/api/playlists/${playlistId}/order`, { json: { item_ids: [...itemIds, 99999] } });
  assert.equal(extra.status, 400);

  const repetido = await req('PUT', `/api/playlists/${playlistId}/order`, { json: { item_ids: [itemIds[0], itemIds[0], itemIds[1]] } });
  assert.equal(repetido.status, 400);

  const semBody = await req('PUT', `/api/playlists/${playlistId}/order`, { json: {} });
  assert.equal(semBody.status, 400);
});

test('PUT /order nao aceita item de outra playlist', async () => {
  const other = (await req('POST', '/api/playlists', { json: { name: 'Outra' } })).body.playlist.id;
  const oi = (await req('POST', `/api/playlists/${other}/items`, { json: { asset_id: assetIds[0] } })).body.item.id;
  const r = await req('PUT', `/api/playlists/${playlistId}/order`, { json: { item_ids: [oi, itemIds[0], itemIds[1]] } });
  assert.equal(r.status, 400);
});

test('PATCH item altera duracao e bumpa version', async () => {
  const before = (await req('GET', `/api/playlists/${playlistId}`)).body.playlist.version;
  const r = await req('PATCH', `/api/playlists/${playlistId}/items/${itemIds[1]}`, { json: { duration: 12.5 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.find((i) => i.id === itemIds[1]).duration, 12.5);
  assert.equal(r.body.version, before + 1);
});

test('PATCH item: duracao <= 0 -> 400', async () => {
  assert.equal((await req('PATCH', `/api/playlists/${playlistId}/items/${itemIds[0]}`, { json: { duration: 0 } })).status, 400);
  assert.equal((await req('PATCH', `/api/playlists/${playlistId}/items/${itemIds[0]}`, { json: { duration: -3 } })).status, 400);
});

test('PATCH item: ordem manual', async () => {
  const r = await req('PATCH', `/api/playlists/${playlistId}/items/${itemIds[0]}`, { json: { ordem: 9 } });
  assert.equal(r.status, 200);
  // com ordem 9 o item vai pro fim
  assert.equal(r.body.items[r.body.items.length - 1].id, itemIds[0]);
});

test('PATCH item inexistente / playlist inexistente -> 404', async () => {
  assert.equal((await req('PATCH', `/api/playlists/${playlistId}/items/99999`, { json: { duration: 3 } })).status, 404);
  assert.equal((await req('PATCH', `/api/playlists/99999/items/${itemIds[0]}`, { json: { duration: 3 } })).status, 404);
  assert.equal((await req('PUT', `/api/playlists/99999/order`, { json: { item_ids: [] } })).status, 404);
  assert.equal((await req('GET', `/api/playlists/99999/manifest`)).status, 404);
});

test('SortableJS servido em /vendor/sortablejs/Sortable.min.js', async () => {
  const res = await fetch(`${baseUrl}/vendor/sortablejs/Sortable.min.js`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Sortable/);
});
