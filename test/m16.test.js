'use strict';

// Ativação iniciada pelo player: o link gera o código, o admin resgata na playlist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m16-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m16';
process.env.SEED_ADMIN_EMAIL = 'admin@m16.local';
process.env.SEED_ADMIN_PASSWORD = 'm16-senha-123';
process.env.SEED_COMPANY_NAME = 'M16Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb, getDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl, token, plId;

async function req(method, p, { json, bearer } = {}) {
  const headers = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  else if (bearer !== null) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
// chamadas públicas do player: sem header de auth
async function pub(method, p, json) {
  const headers = {};
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
  token = (await pub('POST', '/api/auth/login', { email: 'admin@m16.local', password: 'm16-senha-123' })).body.token;
  plId = (await req('POST', '/api/playlists', { json: { name: 'PL' } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('activation/new cunha um código pending; refresh reaproveita a mesma linha', async () => {
  const a = await pub('POST', '/api/activation/new', { hardware_id: 'hw-1', player_type: 'windows' });
  assert.equal(a.status, 201);
  assert.match(a.body.code, /^[A-Z2-9]{6}$/);
  assert.equal(a.body.status, 'pending');
  assert.ok(a.body.poll_secret);

  const b = await pub('POST', '/api/activation/new', { hardware_id: 'hw-1' });
  assert.equal(b.status, 200);
  assert.equal(b.body.code, a.body.code, 'refresh do link não gera código novo');

  const c = await pub('POST', '/api/activation/new', { hardware_id: 'hw-2' });
  assert.notEqual(c.body.code, a.body.code);
});

test('status exige poll_secret e vira redeemed depois do resgate', async () => {
  const a = (await pub('POST', '/api/activation/new', { hardware_id: 'hw-3' })).body;

  assert.equal((await pub('GET', '/api/activation/status?hardware_id=hw-3')).status, 400);
  assert.equal((await pub('GET', `/api/activation/status?hardware_id=hw-3&s=errado`)).status, 404);

  let st = await pub('GET', `/api/activation/status?hardware_id=hw-3&s=${a.poll_secret}`);
  assert.equal(st.body.status, 'pending');

  const r = await req('POST', '/api/activation/redeem', { json: { code: a.code, playlist_id: plId } });
  assert.equal(r.status, 201);
  assert.ok(r.body.device.serial);
  assert.equal(r.body.playlist_id, plId);

  st = await pub('GET', `/api/activation/status?hardware_id=hw-3&s=${a.poll_secret}`);
  assert.equal(st.body.status, 'redeemed');
  assert.ok(st.body.device.token, 'devolve o token do device p/ o player');
  assert.equal(st.body.device.id, r.body.device.id);
});

test('redeem: cria device na empresa do admin + assignment na playlist; é single-use', async () => {
  const a = (await pub('POST', '/api/activation/new', { hardware_id: 'hw-4' })).body;
  const r = await req('POST', '/api/activation/redeem', { json: { code: a.code, playlist_id: plId } });
  const devId = r.body.device.id;

  const dev = (await req('GET', `/api/devices/${devId}`)).body.device;
  assert.equal(dev.company_id, 1);
  assert.equal(dev.assigned_playlist_id, plId);

  // 2º resgate do mesmo código -> 409
  const r2 = await req('POST', '/api/activation/redeem', { json: { code: a.code, playlist_id: plId } });
  assert.equal(r2.status, 409);

  // o token entregue pelo /status realmente serve p/ o manifest
  const st = (await pub('GET', `/api/activation/status?hardware_id=hw-4&s=${a.poll_secret}`)).body;
  const man = await pub('GET', `/api/devices/${devId}/manifest?v=-1&p=-1`, undefined);
  // sem token: 401
  assert.equal(man.status, 401);
  const ok = await fetch(`${baseUrl}/api/devices/${devId}/manifest?v=-1&p=-1`, {
    headers: { authorization: `Bearer ${st.device.token}` },
  });
  assert.equal(ok.status, 200);
});

test('redeem de código inexistente/expirado', async () => {
  assert.equal((await req('POST', '/api/activation/redeem', { json: { code: 'ZZZZZZ' } })).status, 404);

  const a = (await pub('POST', '/api/activation/new', { hardware_id: 'hw-5' })).body;
  getDb().prepare("UPDATE activation_codes SET expires_at = datetime('now','-1 minute') WHERE code = ?").run(a.code);
  const r = await req('POST', '/api/activation/redeem', { json: { code: a.code, playlist_id: plId } });
  assert.equal(r.status, 410);
});

test('hardware que já é device ativo não pede código', async () => {
  const a = (await pub('POST', '/api/activation/new', { hardware_id: 'hw-6' })).body;
  await req('POST', '/api/activation/redeem', { json: { code: a.code } });

  const again = await pub('POST', '/api/activation/new', { hardware_id: 'hw-6' });
  assert.equal(again.body.already_active, true);
  assert.ok(again.body.device_id);
});
