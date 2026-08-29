'use strict';

// Gestão remota do device: comandos, capturas de tela, log de comunicação.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m18-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m18';
process.env.SEED_ADMIN_EMAIL = 'admin@m18.local';
process.env.SEED_ADMIN_PASSWORD = 'm18-senha-123';
process.env.SEED_COMPANY_NAME = 'M18Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, devId, devToken, plId;

async function A(method, p, json) {
  const h = { authorization: `Bearer ${token}` };
  if (json !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}${p}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function D(method, p, json, tok) {
  const h = { authorization: `Bearer ${tok || devToken}` };
  if (json !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}${p}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  token = (await (await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@m18.local', password: 'm18-senha-123' }),
  })).json()).token;
  plId = (await A('POST', '/api/playlists', { name: 'PL' })).body.playlist.id;
  const pair = await (await fetch(`${baseUrl}/api/pair/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hardware_id: 'hw-m18' }),
  })).json();
  devId = pair.deviceId; devToken = pair.token;
});

test.after(() => { if (server) server.close(); closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('screenshot_interval: default 30, aceita 1/5/10/30/60, rejeita o resto', async () => {
  const dev = (await A('GET', `/api/devices/${devId}`)).body.device;
  assert.equal(dev.screenshot_interval, 30);
  assert.equal((await A('PATCH', `/api/devices/${devId}`, { screenshot_interval: 7 })).status, 400);
  assert.equal((await A('PATCH', `/api/devices/${devId}`, { screenshot_interval: 5 })).status, 200);
  assert.equal((await A('GET', `/api/devices/${devId}`)).body.device.screenshot_interval, 5);
});

test('comando pending viaja no heartbeat; ack fecha', async () => {
  const c = (await A('POST', `/api/devices/${devId}/commands`, { type: 'restart' })).body.command;
  assert.equal(c.status, 'pending');

  const hb = (await D('POST', `/api/devices/${devId}/heartbeat`, {})).body;
  assert.ok(hb.commands.some((x) => x.id === c.id && x.type === 'restart'));
  assert.equal(hb.screenshot_interval, 5);

  await D('POST', `/api/devices/${devId}/commands/${c.id}/ack`, { status: 'ok', result: 'reiniciado' });
  const list = (await A('GET', `/api/devices/${devId}/commands`)).body.commands;
  const done = list.find((x) => x.id === c.id);
  assert.equal(done.status, 'ok');
  assert.equal(done.result, 'reiniciado');

  // não aparece mais no heartbeat
  const hb2 = (await D('POST', `/api/devices/${devId}/heartbeat`, {})).body;
  assert.ok(!hb2.commands.some((x) => x.id === c.id));
});

test('unassign_playlist resolve na hora (server-side)', async () => {
  await A('POST', `/api/devices/${devId}/assign`, { playlist_id: plId });
  assert.ok((await A('GET', `/api/devices/${devId}`)).body.device.assigned_playlist_id);

  const c = (await A('POST', `/api/devices/${devId}/commands`, { type: 'unassign_playlist' })).body.command;
  assert.equal(c.status, 'ok');
  assert.equal((await A('GET', `/api/devices/${devId}`)).body.device.assigned_playlist_id, null);
});

test('comando type inválido -> 400', async () => {
  assert.equal((await A('POST', `/api/devices/${devId}/commands`, { type: 'formatar_hd' })).status, 400);
});

test('screenshot upload -> aparece em /screenshots e é servido', async () => {
  const jpg = Buffer.from('ffd8ffe000104a46494600', 'hex'); // header jpeg
  const fd = new FormData();
  fd.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'shot.jpg');
  const r = await fetch(`${baseUrl}/api/devices/${devId}/screenshots?source=manual`, {
    method: 'POST', headers: { authorization: `Bearer ${devToken}` }, body: fd,
  });
  assert.equal(r.status, 201);
  const up = await r.json();
  assert.match(up.url, /^\/screenshots\/dev\d+-\d+\.jpg$/);

  const list = (await A('GET', `/api/devices/${devId}/screenshots`)).body.screenshots;
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'manual');

  const served = await fetch(`${baseUrl}${up.url}`);
  assert.equal(served.status, 200);
});

test('comm-log: 4 tentativas por ciclo, listadas em /comm-log', async () => {
  const at = new Date().toISOString();
  const r = await D('POST', `/api/devices/${devId}/comm-log`, {
    at,
    attempts: [
      { n: 1, ok: true, ms: 40, detail: 'HTTP 200' },
      { n: 2, ok: true, ms: 55 },
      { n: 3, ok: false, ms: 8000, detail: 'timeout' },
      { n: 4, ok: true, ms: 60 },
    ],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.logged, 4);

  const log = (await A('GET', `/api/devices/${devId}/comm-log?days=30`)).body.comm_log;
  assert.equal(log.length, 4);
  assert.equal(log.filter((x) => x.at === at).length, 4);
  assert.equal(log.filter((x) => x.ok).length, 3);
});

test('comm-check responde com a versão', async () => {
  const r = await D('GET', `/api/devices/${devId}/comm-check`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, 'number');
});
