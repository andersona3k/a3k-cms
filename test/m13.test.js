'use strict';

// Aba Playlists: pastas (playlist_folders) + metadados (folder_id, created_by,
// vigencia, suspended, archived), tipo/duracao/status calculados, suspensa -> manifest vazio.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m13-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m13';
process.env.SEED_ADMIN_EMAIL = 'admin@m13.local';
process.env.SEED_ADMIN_PASSWORD = 'm13-senha-123';
process.env.SEED_COMPANY_NAME = 'M13Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, imgId, vidId;

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
async function upload(buf, type, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  return (await r.json()).asset.id;
}

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { json: { email: 'admin@m13.local', password: 'm13-senha-123' } })).body.token;

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC', 'base64');
  imgId = await upload(PNG, 'image/png', 'a.png');
  const ff = require('ffmpeg-static');
  const src = path.join(TMP, 'v.mp4');
  execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { timeout: 60000 });
  vidId = await upload(fs.readFileSync(src), 'video/mp4', 'v.mp4');
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('playlist-folders: CRUD + 409 se nao vazia', async () => {
  const a = await req('POST', '/api/playlist-folders', { json: { name: 'Campanhas' } });
  assert.equal(a.status, 201);
  const sub = await req('POST', '/api/playlist-folders', { json: { name: 'Loja', parent_id: a.body.folder.id } });
  assert.equal(sub.status, 201);

  const list = await req('GET', '/api/playlist-folders');
  assert.equal(list.body.folders.length, 2);

  const del = await req('DELETE', `/api/playlist-folders/${a.body.folder.id}`);
  assert.equal(del.status, 409); // tem subpasta
  const force = await req('DELETE', `/api/playlist-folders/${a.body.folder.id}?force=true`);
  assert.equal(force.status, 200);
  // subpasta caiu junto
  assert.equal((await req('GET', '/api/playlist-folders')).body.folders.length, 0);
});

test('playlist-folders: a raiz "Projeto" nao pode ser apagada', async () => {
  const proj = (await req('POST', '/api/playlist-folders', { json: { name: 'Projeto' } })).body.folder;
  assert.equal((await req('DELETE', `/api/playlist-folders/${proj.id}`)).status, 400);
  assert.equal((await req('DELETE', `/api/playlist-folders/${proj.id}?force=true`)).status, 400);
  // renomear e criar dentro dela continuam OK
  assert.equal((await req('PATCH', `/api/playlist-folders/${proj.id}`, { json: { name: 'Projeto A' } })).status, 200);
  await req('PATCH', `/api/playlist-folders/${proj.id}`, { json: { name: 'Projeto' } });
  assert.equal((await req('POST', '/api/playlist-folders', { json: { name: 'Sub', parent_id: proj.id } })).status, 201);
  // agora nao e mais raiz "Projeto"? ainda e; force ainda barra
  await req('DELETE', `/api/playlist-folders/${proj.id}?force=true`);
  assert.ok((await req('GET', '/api/playlist-folders')).body.folders.some((f) => f.name === 'Projeto'));
});

test('duplicar playlist copia itens/pasta/orientacao, nao os assignments', async () => {
  const fold = (await req('POST', '/api/playlist-folders', { json: { name: 'Dup' } })).body.folder.id;
  const pl = (await req('POST', '/api/playlists', { json: { name: 'Original', folder_id: fold, rotation: 90 } })).body.playlist;
  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: imgId, duration: 6 } });
  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: vidId } });
  const pair = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-dup' } });
  await req('POST', `/api/devices/${pair.body.deviceId}/assign`, { json: { playlist_id: pl.id } });

  const d = await req('POST', `/api/playlists/${pl.id}/duplicate`);
  assert.equal(d.status, 201);
  const copy = d.body.playlist;
  assert.equal(copy.name, 'Original (copia)');
  assert.equal(copy.folder_id, fold);
  assert.equal(copy.rotation, 90);
  assert.notEqual(copy.id, pl.id);

  const full = await req('GET', `/api/playlists/${copy.id}`);
  assert.equal(full.body.items.length, 2);
  // a copia NAO herda o assignment -> status planejada, nao em_uso
  const row = (await req('GET', '/api/playlists')).body.playlists.find((x) => x.id === copy.id);
  assert.equal(row.assigned, false);

  // 2a duplicata -> "(copia) 2"
  const d2 = await req('POST', `/api/playlists/${pl.id}/duplicate`);
  assert.equal(d2.body.playlist.name, 'Original (copia) 2');
});

test('POST playlist: folder_id + created_by; GET calcula tipo/duracao/status', async () => {
  const fold = (await req('POST', '/api/playlist-folders', { json: { name: 'P1' } })).body.folder.id;
  const pl = (await req('POST', '/api/playlists', { json: { name: 'Mix1', folder_id: fold } })).body.playlist;
  assert.equal(pl.folder_id, fold);
  assert.equal(pl.created_by, 'admin@m13.local');

  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: imgId, duration: 7 } });
  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: vidId } });

  const row = (await req('GET', '/api/playlists')).body.playlists.find((x) => x.id === pl.id);
  assert.equal(row.content_type, 'mix');            // imagem + video
  assert.ok(row.total_duration >= 8 && row.total_duration <= 12, 'soma ~7 + ~2s do video');
  assert.equal(row.status, 'planejada');            // sem assignment, sem vigencia
  assert.equal(row.assigned, false);

  // so imagem -> 'imagem'
  const pl2 = (await req('POST', '/api/playlists', { json: { name: 'ImgOnly' } })).body.playlist;
  await req('POST', `/api/playlists/${pl2.id}/items`, { json: { asset_id: imgId, duration: 5 } });
  assert.equal((await req('GET', '/api/playlists')).body.playlists.find((x) => x.id === pl2.id).content_type, 'imagem');
});

test('PATCH: vigencia valida datas; status "vencida"; "planejada"/"em_uso"', async () => {
  const pl = (await req('POST', '/api/playlists', { json: { name: 'Vig' } })).body.playlist;

  assert.equal((await req('PATCH', `/api/playlists/${pl.id}`, { json: { valid_from: '2026/01/01' } })).status, 400);
  assert.equal((await req('PATCH', `/api/playlists/${pl.id}`, { json: { valid_from: '2026-06-01', valid_until: '2026-01-01' } })).status, 400);

  await req('PATCH', `/api/playlists/${pl.id}`, { json: { valid_until: '2000-01-01' } });
  assert.equal((await req('GET', '/api/playlists')).body.playlists.find((x) => x.id === pl.id).status, 'vencida');

  await req('PATCH', `/api/playlists/${pl.id}`, { json: { valid_until: null } });
  // atribui a um device -> em_uso
  const pair = await req('POST', '/api/pair/new', { json: { hardware_id: 'hw-m13' } });
  await req('POST', `/api/devices/${pair.body.deviceId}/assign`, { json: { playlist_id: pl.id } });
  const row = (await req('GET', '/api/playlists')).body.playlists.find((x) => x.id === pl.id);
  assert.equal(row.assigned, true);
  assert.equal(row.status, 'em_uso');
});

test('suspended: some da lista? nao — mas manifest fica vazio e bumpa version', async () => {
  const pl = (await req('POST', '/api/playlists', { json: { name: 'Susp' } })).body.playlist;
  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: imgId, duration: 5 } });
  const v0 = (await req('GET', `/api/playlists/${pl.id}`)).body.playlist.version;

  const r = await req('PATCH', `/api/playlists/${pl.id}`, { json: { suspended: true } });
  assert.equal(r.body.playlist.suspended, 1);
  assert.equal(r.body.playlist.version, v0 + 1);

  const m = (await req('GET', `/api/playlists/${pl.id}/manifest`)).body;
  assert.equal(m.suspended, 1);
  assert.equal(m.items.length, 0);

  await req('PATCH', `/api/playlists/${pl.id}`, { json: { suspended: false } });
  assert.equal((await req('GET', `/api/playlists/${pl.id}/manifest`)).body.items.length, 1);
});

test('archived: sai da listagem, volta com include_archived', async () => {
  const pl = (await req('POST', '/api/playlists', { json: { name: 'Arq' } })).body.playlist;
  await req('PATCH', `/api/playlists/${pl.id}`, { json: { archived: true } });

  assert.ok(!(await req('GET', '/api/playlists')).body.playlists.some((x) => x.id === pl.id));
  assert.ok((await req('GET', '/api/playlists?include_archived=true')).body.playlists.some((x) => x.id === pl.id));
});
