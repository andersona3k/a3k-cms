'use strict';

// Fase 3: miniatura (poster) de video no upload -> assets.thumb_url servido em /assets/*.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m11-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m11';
process.env.SEED_ADMIN_EMAIL = 'admin@m11.local';
process.env.SEED_ADMIN_PASSWORD = 'm11-senha-123';
process.env.SEED_COMPANY_NAME = 'M11Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token;

async function req(method, p, { json } = {}) {
  const headers = { authorization: `Bearer ${token}` };
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
  token = (await req('POST', '/api/auth/login', { json: { email: 'admin@m11.local', password: 'm11-senha-123' } })).body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('upload de video gera thumb_url e a miniatura e servivel', async () => {
  const ff = require('ffmpeg-static');
  const src = path.join(TMP, 'clip.mp4');
  execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { timeout: 60000 });

  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(src)], { type: 'video/mp4' }), 'clip.mp4');
  const up = await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const asset = (await up.json()).asset;

  assert.equal(asset.type, 'video');
  assert.ok(asset.thumb_url && asset.thumb_url.startsWith('/assets/'), 'thumb_url preenchido');
  assert.match(asset.thumb_url, /\.thumb\.jpg$/);

  const img = await fetch(`${baseUrl}${asset.thumb_url}`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type') || '', /image\/jpe?g/);
  const buf = Buffer.from(await img.arrayBuffer());
  assert.ok(buf.length > 500, 'miniatura tem conteudo');
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8); // magic JPEG
});

test('imagem nao ganha thumb_url (usa o proprio arquivo)', async () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'p.png');
  const up = await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const asset = (await up.json()).asset;
  assert.equal(asset.type, 'image');
  assert.equal(asset.thumb_url ?? null, null);
});
