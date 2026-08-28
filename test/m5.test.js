'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m5-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m5';
process.env.SEED_ADMIN_EMAIL = 'root@m5.local';
process.env.SEED_ADMIN_PASSWORD = 'm5-root-123';
process.env.SEED_COMPANY_NAME = 'Empresa A';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server, baseUrl;

async function call(method, p, { token, json, companyId } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (companyId) headers['x-company-id'] = String(companyId);
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { json: { email, password } });
  return r.body && r.body.token;
}

let rootTok;        // superadmin (Empresa A)
let bAdminTok;      // admin da Empresa B (nao superadmin)
let opTok;          // usuario com role limitada na Empresa B
let companyBId;
let aPlaylistId, bPlaylistId;
let opRoleId;

test.before(async () => {
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
  rootTok = await login('root@m5.local', 'm5-root-123');
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('seed admin e superadmin', async () => {
  const me = await call('GET', '/api/auth/me', { token: rootTok });
  assert.equal(me.body.user.isSuperadmin, true);
});

test('superadmin cria empresa B com admin proprio', async () => {
  const r = await call('POST', '/api/companies', {
    token: rootTok,
    json: { name: 'Empresa B', admin: { email: 'b-admin@m5.local', password: 'b-admin-123', name: 'Admin B' } },
  });
  assert.equal(r.status, 201);
  companyBId = r.body.company.id;
  assert.ok(r.body.admin_user && r.body.admin_user.email === 'b-admin@m5.local');

  bAdminTok = await login('b-admin@m5.local', 'b-admin-123');
  assert.ok(bAdminTok);
});

test('admin de empresa (nao superadmin) nao acessa /api/companies', async () => {
  const r = await call('GET', '/api/companies', { token: bAdminTok });
  assert.equal(r.status, 403);
});

test('isolamento: empresa B nao ve/edita playlist da empresa A', async () => {
  aPlaylistId = (await call('POST', '/api/playlists', { token: rootTok, json: { name: 'A-secreta' } })).body.playlist.id;
  bPlaylistId = (await call('POST', '/api/playlists', { token: bAdminTok, json: { name: 'B-grade' } })).body.playlist.id;

  const bList = await call('GET', '/api/playlists', { token: bAdminTok });
  assert.ok(bList.body.playlists.every((p) => p.name !== 'A-secreta'));

  assert.equal((await call('GET', `/api/playlists/${aPlaylistId}`, { token: bAdminTok })).status, 404);
  assert.equal((await call('PATCH', `/api/playlists/${aPlaylistId}`, { token: bAdminTok, json: { name: 'hack' } })).status, 404);

  // e a empresa A nao ve a playlist da B
  const aList = await call('GET', '/api/playlists', { token: rootTok });
  assert.ok(aList.body.playlists.every((p) => p.name !== 'B-grade'));
});

test('superadmin troca de contexto com X-Company-Id', async () => {
  const asB = await call('GET', '/api/playlists', { token: rootTok, companyId: companyBId });
  assert.ok(asB.body.playlists.some((p) => p.name === 'B-grade'));
  assert.ok(asB.body.playlists.every((p) => p.name !== 'A-secreta'));

  const bad = await call('GET', '/api/playlists', { token: rootTok, companyId: 99999 });
  assert.equal(bad.status, 400);
});

test('roles: cria papel limitado, valida vocabulario', async () => {
  const bad = await call('POST', '/api/roles', { token: bAdminTok, json: { name: 'x', permissions: { 'nao:existe': true } } });
  assert.equal(bad.status, 400);

  const r = await call('POST', '/api/roles', {
    token: bAdminTok, json: { name: 'operador', permissions: { 'playlists:write': true } },
  });
  assert.equal(r.status, 201);
  opRoleId = r.body.role.id;
  assert.equal(r.body.role.permissions['playlists:write'], true);
});

test('users: cria usuario com role limitada', async () => {
  const r = await call('POST', '/api/users', {
    token: bAdminTok, json: { email: 'op@m5.local', password: 'op-123456', name: 'Operador', role_id: opRoleId },
  });
  assert.equal(r.status, 201);
  opTok = await login('op@m5.local', 'op-123456');
  assert.ok(opTok);
});

test('enforcement: usuario limitado escreve playlist mas nao pasta/role/user', async () => {
  assert.equal((await call('POST', '/api/playlists', { token: opTok, json: { name: 'op-fez' } })).status, 201);
  assert.equal((await call('GET', '/api/playlists', { token: opTok })).status, 200); // leitura livre
  assert.equal((await call('POST', '/api/folders', { token: opTok, json: { name: 'nope' } })).status, 403);
  assert.equal((await call('POST', '/api/roles', { token: opTok, json: { name: 'r2', permissions: {} } })).status, 403);
  assert.equal((await call('GET', '/api/users', { token: opTok })).status, 403);
  assert.equal((await call('POST', '/api/pair/requests', { token: opTok, json: {} })).status, 403);
});

test('usuario limitado da empresa B nao alcanca dados da empresa A', async () => {
  assert.equal((await call('GET', `/api/playlists/${aPlaylistId}`, { token: opTok })).status, 404);
});

test('users: nao pode desativar a si mesmo; role em uso nao apaga', async () => {
  const meB = await call('GET', '/api/users', { token: bAdminTok });
  const selfId = meB.body.users.find((u) => u.email === 'b-admin@m5.local').id;
  assert.equal((await call('PATCH', `/api/users/${selfId}`, { token: bAdminTok, json: { active: false } })).status, 400);

  const del = await call('DELETE', `/api/roles/${opRoleId}`, { token: bAdminTok });
  assert.equal(del.status, 409);
});

test('desativar usuario derruba o acesso', async () => {
  const list = await call('GET', '/api/users', { token: bAdminTok });
  const opId = list.body.users.find((u) => u.email === 'op@m5.local').id;
  await call('PATCH', `/api/users/${opId}`, { token: bAdminTok, json: { active: false } });
  assert.equal((await call('GET', '/api/playlists', { token: opTok })).status, 401);
  assert.equal(await login('op@m5.local', 'op-123456'), undefined);
});

test('pareamento sem codigo e recusado com multiempresa', async () => {
  const r = await call('POST', '/api/pair/new', { json: { hardware_id: 'hw-multi' } });
  assert.equal(r.status, 400);
});

test('pareamento com codigo vincula o device a empresa do codigo', async () => {
  const pr = await call('POST', '/api/pair/requests', { token: bAdminTok, json: { name: 'TV B', player_type: 'android' } });
  assert.equal(pr.status, 201);
  const paired = await call('POST', '/api/pair/new', { json: { code: pr.body.request.code, hardware_id: 'hw-b-1' } });
  assert.equal(paired.status, 201);
  assert.equal(paired.body.claimed, true);

  const dev = getDb().prepare('SELECT company_id, name FROM devices WHERE id = ?').get(paired.body.deviceId);
  assert.equal(dev.company_id, companyBId);
  assert.equal(dev.name, 'TV B');

  // aparece na lista da empresa B, nao na da A
  const bDevs = await call('GET', '/api/devices', { token: bAdminTok });
  assert.ok(bDevs.body.devices.some((d) => d.id === paired.body.deviceId));
  const aDevs = await call('GET', '/api/devices', { token: rootTok });
  assert.ok(aDevs.body.devices.every((d) => d.id !== paired.body.deviceId));
});
