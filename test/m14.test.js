'use strict';

// Empresa: modulos (digital/logistica/experience) + logo + /api/auth/me.company

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m14-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m14';
process.env.SEED_ADMIN_EMAIL = 'admin@m14.local';
process.env.SEED_ADMIN_PASSWORD = 'm14-senha-123';
process.env.SEED_COMPANY_NAME = 'M14Co';

const { runMigrations } = require('../src/db/migrate');
const { closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { normalizeModules } = require('../src/lib/modules');

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
  token = (await req('POST', '/api/auth/login', { json: { email: 'admin@m14.local', password: 'm14-senha-123' } })).body.token;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('normalizeModules: default digital, filtra invalidos', () => {
  assert.deepEqual(normalizeModules(null), ['digital']);
  assert.deepEqual(normalizeModules([]), ['digital']);
  assert.deepEqual(normalizeModules(['xyz']), ['digital']);
  assert.deepEqual(normalizeModules(['experience', 'digital', 'nope']), ['digital', 'experience']);
  assert.deepEqual(normalizeModules('["logistica"]'), ['logistica']);
});

test('empresa seed tem modules ["digital"]; /me devolve company', async () => {
  const me = await req('GET', '/api/auth/me');
  assert.ok(me.body.user.company, 'me traz a empresa');
  assert.deepEqual(me.body.user.company.modules, ['digital']);
  assert.equal(me.body.user.company.logo_url, null);
});

test('POST company com modules; PATCH troca modules', async () => {
  const c = (await req('POST', '/api/companies', {
    json: { name: 'Cliente Mods', modules: ['digital', 'logistica'] },
  })).body.company;
  assert.deepEqual(c.modules, ['digital', 'logistica']);

  const p = await req('PATCH', `/api/companies/${c.id}`, { json: { modules: ['experience'] } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.company.modules, ['experience']);

  // vazio -> normaliza p/ digital
  const p2 = await req('PATCH', `/api/companies/${c.id}`, { json: { modules: [] } });
  assert.deepEqual(p2.body.company.modules, ['digital']);
});

test('upload de logo grava logo_url servivel; DELETE limpa', async () => {
  const c = (await req('POST', '/api/companies', { json: { name: 'Cliente Logo' } })).body.company;
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABS3WWCAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAG6xBAGXY0kUAAAAAElFTkSuQmCC',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  const up = await fetch(`${baseUrl}/api/companies/${c.id}/logo`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  const upBody = await up.json();
  assert.equal(up.status, 200);
  assert.equal(upBody.company.logo_url, `/assets/logo-c${c.id}.png`);

  const img = await fetch(`${baseUrl}${upBody.company.logo_url}`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type') || '', /image\/png/);

  // rejeita nao-imagem
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt');
  const bad = await fetch(`${baseUrl}/api/companies/${c.id}/logo`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd2,
  });
  assert.equal(bad.status, 400);

  const del = await req('DELETE', `/api/companies/${c.id}/logo`);
  assert.equal(del.body.company.logo_url, null);
});
