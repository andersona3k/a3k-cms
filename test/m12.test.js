'use strict';

// Visualizador de asset: created_by, playlists vinculadas, e "Condicionais"
// (assets.schedule com validade data+hora / dias / horario 24h) + history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m12-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m12';
process.env.SEED_ADMIN_EMAIL = 'admin@m12.local';
process.env.SEED_ADMIN_PASSWORD = 'm12-senha-123';
process.env.SEED_COMPANY_NAME = 'M12Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { validateAssetSchedule } = require('../src/lib/assetSchedule');

let server, baseUrl, token, imgId, plId;

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
  token = (await req('POST', '/api/auth/login', { json: { email: 'admin@m12.local', password: 'm12-senha-123' } })).body.token;

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  imgId = (await (await fetch(`${baseUrl}/api/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  })).json()).asset.id;

  plId = (await req('POST', '/api/playlists', { json: { name: 'Vitrine' } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('upload grava created_by (e-mail de quem enviou)', async () => {
  const d = await req('GET', `/api/assets/${imgId}`);
  assert.equal(d.body.asset.created_by, 'admin@m12.local');
  assert.deepEqual(d.body.playlists, []);
});

test('GET /:id informa as playlists vinculadas', async () => {
  await req('POST', `/api/playlists/${plId}/items`, { json: { asset_id: imgId, duration: 5 } });
  const d = await req('GET', `/api/assets/${imgId}`);
  assert.equal(d.body.playlists.length, 1);
  assert.equal(d.body.playlists[0].name, 'Vitrine');
});

test('PATCH schedule valida e grava; history registra usuario + mudanca', async () => {
  const ok = await req('PATCH', `/api/assets/${imgId}`, {
    json: { schedule: { from: '2026-09-01T09:00', until: '2026-12-31T18:00', days: [1, 2, 3, 4, 5], start: '09:00', end: '15:00' } },
  });
  assert.equal(ok.status, 200);
  const sc = JSON.parse(ok.body.asset.schedule);
  assert.equal(sc.from, '2026-09-01T09:00');
  assert.equal(sc.end, '15:00');
  assert.deepEqual(sc.days, [1, 2, 3, 4, 5]);

  const hist = JSON.parse(ok.body.asset.history);
  assert.ok(hist.length >= 1);
  assert.equal(hist[hist.length - 1].user, 'admin@m12.local');
  assert.match(hist[hist.length - 1].change, /condicionais/);

  // limpar
  const cleared = await req('PATCH', `/api/assets/${imgId}`, { json: { schedule: null } });
  assert.equal(cleared.body.asset.schedule, null);
});

test('PATCH schedule rejeita hora fora de 24h e validade invertida', async () => {
  assert.equal((await req('PATCH', `/api/assets/${imgId}`, { json: { schedule: { start: '25:00' } } })).status, 400);
  assert.equal((await req('PATCH', `/api/assets/${imgId}`, { json: { schedule: { start: '9:00' } } })).status, 400); // sem zero a esquerda
  assert.equal((await req('PATCH', `/api/assets/${imgId}`, {
    json: { schedule: { from: '2026-12-01T10:00', until: '2026-01-01T10:00' } },
  })).status, 400);
});

test('validateAssetSchedule normaliza (dias todos -> ausente, vazio -> null)', () => {
  assert.deepEqual(validateAssetSchedule({ days: [1, 2, 3, 4, 5, 6, 7] }).value, null);
  assert.deepEqual(validateAssetSchedule({}).value, null);
  assert.deepEqual(validateAssetSchedule(null).value, null);
  assert.equal(validateAssetSchedule({ start: '09:00', end: '15:00' }).value.start, '09:00');
});
