'use strict';

// Fase 3: normalizacao de video no upload (transcode p/ H.264 8-bit <=1080p).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m8-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m8';
process.env.SEED_ADMIN_EMAIL = 'admin@m8.local';
process.env.SEED_ADMIN_PASSWORD = 'm8-senha-123';
process.env.SEED_COMPANY_NAME = 'M8Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { needsNormalize } = require('../src/lib/transcode');

// ---------- unit: needsNormalize ----------

test('needsNormalize: h264 conforme -> nao', () => {
  const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080 }] };
  assert.equal(needsNormalize(raw).normalize, false);
});

test('needsNormalize: HEVC -> sim', () => {
  const raw = { streams: [{ codec_type: 'video', codec_name: 'hevc', profile: 'Main', pix_fmt: 'yuv420p', width: 1280, height: 720 }] };
  assert.equal(needsNormalize(raw).normalize, true);
});

test('needsNormalize: h264 10-bit -> sim', () => {
  const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High 10', pix_fmt: 'yuv420p10le', width: 1920, height: 1080 }] };
  assert.equal(needsNormalize(raw).normalize, true);
});

test('needsNormalize: 4K -> sim', () => {
  const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 3840, height: 2160 }] };
  assert.equal(needsNormalize(raw).normalize, true);
});

test('needsNormalize: rotacao 90 (side_data) -> sim', () => {
  const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1080, height: 1920, side_data_list: [{ rotation: -90 }] }] };
  assert.equal(needsNormalize(raw).normalize, true);
});

test('needsNormalize: sem stream de video -> nao', () => {
  assert.equal(needsNormalize({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }).normalize, false);
});

// ---------- integracao: upload de HEVC vira H.264 ----------

let server, baseUrl, token, ffmpeg;

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@m8.local', password: 'm8-senha-123' }),
  });
  token = (await login.json()).token;
  ffmpeg = require('ffmpeg-static');
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('upload de HEVC e transcodificado para H.264 mp4', async (t) => {
  const src = path.join(TMP, 'src-hevc.mp4');
  try {
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', src,
    ], { timeout: 60000 });
  } catch (e) {
    t.skip('ffmpeg/libx265 indisponivel: ' + e.message);
    return;
  }

  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(src)], { type: 'video/mp4' }), 'celular.mp4');
  const res = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  assert.equal(res.status, 201);
  const a = (await res.json()).asset;

  assert.equal(a.type, 'video');
  assert.equal(a.probe_status, 'ok', a.probe_error || '');
  assert.equal(a.codec, 'h264', 'deveria ter sido transcodificado p/ h264');
  assert.equal(a.mime, 'video/mp4');
  assert.match(a.url, /^\/assets\/[0-9a-f]{64}\.mp4$/);

  // o metadata novo nao pede mais normalizacao
  const meta = JSON.parse(a.metadata);
  assert.equal(needsNormalize(meta).normalize, false);

  // arquivo servivel
  const dl = await fetch(`${baseUrl}${a.url}`);
  assert.equal(dl.status, 200);
});

test('upload de MP4 H.264 conforme NAO troca de arquivo', async (t) => {
  const src = path.join(TMP, 'src-h264.mp4');
  try {
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', src,
    ], { timeout: 60000 });
  } catch (e) {
    t.skip('ffmpeg indisponivel');
    return;
  }
  const before = fs.readFileSync(src);
  const fd = new FormData();
  fd.append('file', new Blob([before], { type: 'video/mp4' }), 'ok.mp4');
  const res = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  const a = (await res.json()).asset;
  assert.equal(a.codec, 'h264');
  // arquivo servido = tamanho identico ao enviado (sem re-encode)
  const dl = await fetch(`${baseUrl}${a.url}`);
  const got = Buffer.from(await dl.arrayBuffer());
  assert.equal(got.length, before.length);
});
