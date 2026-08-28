'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Banco isolado para o teste — precisa ser setado antes de exigir os modulos.
const TMP_DB = path.join(os.tmpdir(), `cms-m0-test-${process.pid}.sqlite`);
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = 'test-secret';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'senha-teste-123';
process.env.SEED_COMPANY_NAME = 'TesteCo';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');

let server;
let baseUrl;

test.before(async () => {
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + s)) fs.rmSync(TMP_DB + s);
  }
  runMigrations({ silent: true });
  seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + s)) fs.rmSync(TMP_DB + s);
  }
});

test('migrations criam todas as tabelas da fundacao', () => {
  const db = getDb();
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  for (const t of [
    'companies', 'roles', 'users',
    'folders', 'assets',
    'playlists', 'playlist_items',
    'device_groups', 'devices', 'assignments',
    '_migrations',
  ]) {
    assert.ok(rows.includes(t), `tabela ausente: ${t}`);
  }
});

test('toda tabela de dados tem company_id (exceto join tables e _migrations)', () => {
  const db = getDb();
  const scoped = ['companies', 'roles', 'users', 'folders', 'assets', 'playlists',
    'device_groups', 'devices', 'assignments'];
  for (const t of scoped) {
    if (t === 'companies') continue;
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols.includes('company_id'), `${t} sem company_id`);
  }
});

test('migrate roda de novo sem erro (idempotente)', () => {
  const r = runMigrations({ silent: true });
  assert.deepEqual(r.applied, []);
});

test('seed criou empresa, role admin e usuario admin', () => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE name = ?').get('TesteCo');
  assert.ok(company);
  const role = db.prepare('SELECT * FROM roles WHERE company_id = ? AND name = ?')
    .get(company.id, 'admin');
  assert.ok(role);
  assert.equal(JSON.parse(role.permissions)['*'], true);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@test.local');
  assert.ok(user);
  assert.equal(user.role_id, role.id);
  assert.notEqual(user.password_hash, 'senha-teste-123');
});

test('seed e idempotente', () => {
  seed();
  const db = getDb();
  const n = db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get('admin@test.local').c;
  assert.equal(n, 1);
});

test('GET /api/health responde ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'a3k-cms');
});

test('login com credenciais corretas devolve token', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'senha-teste-123' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token);
  assert.equal(body.user.email, 'admin@test.local');
});

test('login com senha errada retorna 401', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'errada' }),
  });
  assert.equal(res.status, 401);
});

test('GET /api/auth/me exige token e devolve o usuario', async () => {
  const noAuth = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(noAuth.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'senha-teste-123' }),
  });
  const { token } = await login.json();

  const me = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.email, 'admin@test.local');
  assert.equal(body.user.permissions['*'], true);
});

test('GET /api/adapters lista os 4 stubs de player', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'senha-teste-123' }),
  });
  const { token } = await login.json();

  const res = await fetch(`${baseUrl}/api/adapters`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.player_types.sort(), ['android', 'tizen', 'webos', 'windows']);
  assert.equal(body.adapters.length, 4);
});

test('FK ligada: inserir asset com company_id inexistente falha', () => {
  const db = getDb();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO assets (company_id, type, filename, url) VALUES (99999, 'image', 'x.png', '/x.png')`
    ).run();
  });
});

test('assignment: alvo unico por (company, target_type, target_id)', () => {
  const db = getDb();
  const c = db.prepare('SELECT id FROM companies WHERE name = ?').get('TesteCo').id;
  const p = db.prepare('INSERT INTO playlists (company_id, name) VALUES (?, ?)')
    .run(c, `pl-${Date.now()}`).lastInsertRowid;
  db.prepare(
    `INSERT INTO assignments (company_id, playlist_id, target_type, target_id) VALUES (?, ?, 'device', 1)`
  ).run(c, p);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO assignments (company_id, playlist_id, target_type, target_id) VALUES (?, ?, 'device', 1)`
    ).run(c, p);
  });
});
