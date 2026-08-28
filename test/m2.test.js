'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m2-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m2';
process.env.SEED_ADMIN_EMAIL = 'admin@m2.local';
process.env.SEED_ADMIN_PASSWORD = 'm2-senha-123';
process.env.SEED_COMPANY_NAME = 'M2Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { normalizeFfprobe, parseFrameRate } = require('../src/lib/probe');

let server, baseUrl, token;

// PNG 2x3 valido
const PNG_2x3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC',
  'base64'
);

// WAV mono 8000Hz 16-bit, ~0.05s
function makeWav(seconds = 0.05, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((i / rate) * 2 * Math.PI * 440)), 44 + i * 2);
  }
  return buf;
}

async function req(method, p, { auth = true, json, form } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function uploadFile(buf, name, mime, folderId) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  if (folderId != null) fd.append('folder_id', String(folderId));
  return req('POST', '/api/assets', { form: fd });
}

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await req('POST', '/api/auth/login', { auth: false, json: { email: 'admin@m2.local', password: 'm2-senha-123' } })).body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- probe unit (sem binario) ----------

test('parseFrameRate lida com racional e zero', () => {
  assert.equal(parseFrameRate('30000/1001'), 29.97);
  assert.equal(parseFrameRate('25/1'), 25);
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(parseFrameRate(''), null);
});

test('normalizeFfprobe extrai campos do stream de video', () => {
  const raw = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', bit_rate: '4500000' },
      { codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' },
    ],
    format: { format_name: 'mov,mp4,m4a', duration: '12.34', bit_rate: '4700000' },
  };
  const f = normalizeFfprobe(raw, 'video');
  assert.equal(f.width, 1920);
  assert.equal(f.height, 1080);
  assert.equal(f.fps, 30);
  assert.equal(f.codec, 'h264');
  assert.equal(f.duration, 12.34);
  assert.equal(f.bitrate, 4700000);
  assert.equal(f.format, 'mov,mp4,m4a');
});

// ---------- pastas ----------

let rootFolder, subFolder;

test('cria pasta e subpasta', async () => {
  const a = await req('POST', '/api/folders', { json: { name: 'Campanhas' } });
  assert.equal(a.status, 201);
  rootFolder = a.body.folder.id;
  const b = await req('POST', '/api/folders', { json: { name: 'Verao', parent_id: rootFolder } });
  assert.equal(b.status, 201);
  assert.equal(b.body.folder.parent_id, rootFolder);
  subFolder = b.body.folder.id;
});

test('nome de pasta duplicado no mesmo pai -> 409', async () => {
  const r = await req('POST', '/api/folders', { json: { name: 'Verao', parent_id: rootFolder } });
  assert.equal(r.status, 409);
});

test('mover pasta para dentro de si mesma -> 400', async () => {
  const r = await req('PATCH', `/api/folders/${rootFolder}`, { json: { parent_id: subFolder } });
  assert.equal(r.status, 400);
});

test('renomear pasta', async () => {
  const r = await req('PATCH', `/api/folders/${subFolder}`, { json: { name: 'Verao 2026' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.folder.name, 'Verao 2026');
});

// ---------- upload + metadados ----------

let pngAsset, wavAsset;

test('upload de PNG preenche width/height/format via sharp', async () => {
  const r = await uploadFile(PNG_2x3, 'foto.png', 'image/png', subFolder);
  assert.equal(r.status, 201);
  const a = r.body.asset;
  assert.equal(a.type, 'image');
  assert.equal(a.folder_id, subFolder);
  assert.equal(a.probe_status, 'ok');
  assert.equal(a.width, 2);
  assert.equal(a.height, 3);
  assert.equal(a.format, 'png');
  assert.equal(a.duration, null);
  assert.ok(a.metadata && JSON.parse(a.metadata).format === 'png');
  pngAsset = a.id;
});

test('upload de WAV extrai duracao/codec via ffprobe', async () => {
  const r = await uploadFile(makeWav(0.05), 'som.wav', 'audio/wav');
  assert.equal(r.status, 201);
  const a = r.body.asset;
  assert.equal(a.type, 'audio');
  assert.equal(a.probe_status, 'ok', a.probe_error || '');
  assert.ok(a.duration > 0.03 && a.duration < 0.09, `duration inesperada: ${a.duration}`);
  assert.equal(a.codec, 'pcm_s16le');
  assert.match(a.format || '', /wav/);
  wavAsset = a.id;
});

test('arquivo corrompido: asset criado com probe_status error', async () => {
  const r = await uploadFile(Buffer.from('nao sou um png de verdade'), 'quebrado.png', 'image/png');
  assert.equal(r.status, 201);
  assert.equal(r.body.asset.probe_status, 'error');
  assert.ok(r.body.asset.probe_error);
});

test('tipo sem probe (other) fica skipped', async () => {
  const r = await uploadFile(Buffer.from('%PDF-1.4 ...'), 'doc.pdf', 'application/pdf');
  assert.equal(r.status, 201);
  assert.equal(r.body.asset.type, 'other');
  assert.equal(r.body.asset.probe_status, 'skipped');
});

// ---------- filtro por pasta / mover / reprobe / delete ----------

test('GET /api/assets?folder_id filtra', async () => {
  const inSub = await req('GET', `/api/assets?folder_id=${subFolder}`);
  assert.equal(inSub.body.assets.length, 1);
  assert.equal(inSub.body.assets[0].id, pngAsset);

  const unfiled = await req('GET', '/api/assets?folder_id=unfiled');
  assert.ok(unfiled.body.assets.every((a) => a.folder_id === null));
  assert.ok(unfiled.body.assets.some((a) => a.id === wavAsset));
});

test('PATCH move asset e renomeia', async () => {
  const r = await req('PATCH', `/api/assets/${wavAsset}`, { json: { folder_id: rootFolder, filename: 'jingle.wav' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.asset.folder_id, rootFolder);
  assert.equal(r.body.asset.filename, 'jingle.wav');
});

test('PATCH com folder_id invalido -> 400', async () => {
  const r = await req('PATCH', `/api/assets/${wavAsset}`, { json: { folder_id: 99999 } });
  assert.equal(r.status, 400);
});

test('reprobe reprocessa os metadados', async () => {
  getDb().prepare('UPDATE assets SET width = NULL, probe_status = ? WHERE id = ?').run('pending', pngAsset);
  const r = await req('POST', `/api/assets/${pngAsset}/reprobe`);
  assert.equal(r.status, 200);
  assert.equal(r.body.asset.width, 2);
  assert.equal(r.body.asset.probe_status, 'ok');
});

test('deletar pasta nao vazia -> 409, com ?force apaga', async () => {
  const blocked = await req('DELETE', `/api/folders/${rootFolder}`);
  assert.equal(blocked.status, 409);
  assert.ok(blocked.body.subfolder_count >= 1);

  const forced = await req('DELETE', `/api/folders/${rootFolder}?force=true`);
  assert.equal(forced.status, 200);
  // subpasta caiu em cascata; assets ficaram sem pasta
  assert.equal((await req('GET', `/api/folders`)).body.folders.length, 0);
  const png = await req('GET', `/api/assets/${pngAsset}`);
  assert.equal(png.body.asset.folder_id, null);
});

test('deletar asset em playlist -> 409, ?force apaga e bumpa version', async () => {
  const pl = (await req('POST', '/api/playlists', { json: { name: 'PL-del' } })).body.playlist;
  await req('POST', `/api/playlists/${pl.id}/items`, { json: { asset_id: pngAsset } });
  const v1 = (await req('GET', `/api/playlists/${pl.id}`)).body.playlist.version;

  const blocked = await req('DELETE', `/api/assets/${pngAsset}`);
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.playlists, [pl.id]);

  const forced = await req('DELETE', `/api/assets/${pngAsset}?force=true`);
  assert.equal(forced.status, 200);
  const v2 = (await req('GET', `/api/playlists/${pl.id}`)).body.playlist.version;
  assert.equal(v2, v1 + 1);
  assert.equal((await req('GET', `/api/assets/${pngAsset}`)).status, 404);
});

test('arquivo e removido do disco quando nenhum asset referencia o hash', async () => {
  const up = await uploadFile(makeWav(0.06), 'temp.wav', 'audio/wav');
  const url = up.body.asset.url;
  const abs = path.join(process.env.MEDIA_DIR, url.replace('/assets/', ''));
  assert.ok(fs.existsSync(abs));
  await req('DELETE', `/api/assets/${up.body.asset.id}`);
  assert.ok(!fs.existsSync(abs));
});
