'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-m6-'));
process.env.DB_PATH = path.join(TMP, 'cms.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JWT_SECRET = 'test-secret-m6';
process.env.SEED_ADMIN_EMAIL = 'admin@m6.local';
process.env.SEED_ADMIN_PASSWORD = 'm6-senha-123';
process.env.SEED_COMPANY_NAME = 'M6Co';

const { runMigrations } = require('../src/db/migrate');
const { getDb, closeDb } = require('../src/db');
const { seed } = require('../scripts/seed');
const { createApp } = require('../src/app');
const { validateSchedule, isActive } = require('../src/lib/schedule');

// ---------- unit: isActive / validateSchedule ----------

const MON_NOON = new Date(2026, 8, 7, 12, 0);   // 2026-09-07 e uma segunda-feira
const MON_2000 = new Date(2026, 8, 7, 20, 0);
const TUE_NOON = new Date(2026, 8, 8, 12, 0);
const MON_2300 = new Date(2026, 8, 7, 23, 0);
const TUE_0300 = new Date(2026, 8, 8, 3, 0);

test('schedule null -> sempre ativo', () => {
  assert.equal(isActive(null, MON_NOON), true);
});

test('janela de horas simples', () => {
  const s = { start: '09:00', end: '18:00' };
  assert.equal(isActive(s, MON_NOON), true);
  assert.equal(isActive(s, MON_2000), false);
});

test('filtro por dia da semana (ISO 1=seg)', () => {
  const s = { days: [1], start: '00:00', end: '24:00' };
  assert.equal(isActive(s, MON_NOON), true);
  assert.equal(isActive(s, TUE_NOON), false);
});

test('janela que vira a meia-noite (22:00-06:00)', () => {
  const s = { start: '22:00', end: '06:00' };
  assert.equal(isActive(s, MON_2300), true);   // noite de segunda
  assert.equal(isActive(s, TUE_0300), true);   // madrugada de terca (janela comecou seg)
  assert.equal(isActive(s, MON_NOON), false);
});

test('janela virada com dia: days refere-se ao dia em que comeca', () => {
  const s = { days: [1], start: '22:00', end: '06:00' }; // comeca na segunda
  assert.equal(isActive(s, MON_2300), true);
  assert.equal(isActive(s, TUE_0300), true);                        // ainda "janela de segunda"
  assert.equal(isActive(s, new Date(2026, 8, 8, 23, 0)), false);    // terca 23h nao e janela de segunda
  assert.equal(isActive(s, new Date(2026, 8, 9, 3, 0)), false);     // quarta 3h: janela seria de terca
});

test('intervalo de datas from/until', () => {
  assert.equal(isActive({ from: '2026-09-01', until: '2026-09-10' }, MON_NOON), true);
  assert.equal(isActive({ from: '2026-09-08' }, MON_NOON), false);
  assert.equal(isActive({ until: '2026-09-06' }, MON_NOON), false);
});

test('validateSchedule: normaliza e rejeita', () => {
  assert.equal(validateSchedule(null).value, null);
  assert.equal(validateSchedule({ days: [1, 2, 3, 4, 5, 6, 7] }).value, null); // todos = sem filtro
  assert.deepEqual(validateSchedule({ start: '00:00', end: '24:00' }).value, null); // janela cheia
  assert.deepEqual(validateSchedule({ start: '8:05', end: '9:00' }).value, { start: '08:05', end: '09:00' });
  assert.equal(validateSchedule({ start: '25:00' }).ok, false);
  assert.equal(validateSchedule({ days: [0] }).ok, false);
  assert.equal(validateSchedule({ days: [8] }).ok, false);
  assert.equal(validateSchedule({ from: '2026-02-02', until: '2026-01-01' }).ok, false);
  assert.equal(validateSchedule({ start: '10:00', end: '10:00' }).ok, false);
  assert.equal(validateSchedule('nao-json').ok, false);
});

// ---------- API ----------

let server, baseUrl, token, playlistId, assetId, itemId;

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
  token = (await (async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@m6.local', password: 'm6-senha-123' }),
    });
    return (await res.json()).token;
  })());

  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('img')], { type: 'image/png' }), 'a.png');
  const up = await fetch(`${baseUrl}/api/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  assetId = (await up.json()).asset.id;
  playlistId = (await req('POST', '/api/playlists', { json: { name: 'Grade' } })).body.playlist.id;
});

test.after(() => {
  if (server) server.close();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('POST item com schedule guarda e devolve normalizado', async () => {
  const r = await req('POST', `/api/playlists/${playlistId}/items`, {
    json: { asset_id: assetId, schedule: { days: [1, 2, 3, 4, 5], start: '8:00', end: '18:00' } },
  });
  assert.equal(r.status, 201);
  itemId = r.body.item.id;
  const got = await req('GET', `/api/playlists/${playlistId}`);
  const it = got.body.items.find((x) => x.id === itemId);
  assert.deepEqual(it.schedule, { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' });
  assert.equal(typeof it.active_now, 'boolean');
});

test('POST item com schedule invalido -> 400', async () => {
  const r = await req('POST', `/api/playlists/${playlistId}/items`, {
    json: { asset_id: assetId, schedule: { start: '99:99' } },
  });
  assert.equal(r.status, 400);
});

test('PATCH schedule bumpa version; null limpa', async () => {
  const before = (await req('GET', `/api/playlists/${playlistId}`)).body.playlist.version;
  const r = await req('PATCH', `/api/playlists/${playlistId}/items/${itemId}`, { json: { schedule: { days: [6, 7] } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, before + 1);
  assert.deepEqual(r.body.items.find((x) => x.id === itemId).schedule, { days: [6, 7] });

  const cleared = await req('PATCH', `/api/playlists/${playlistId}/items/${itemId}`, { json: { schedule: null } });
  assert.equal(cleared.body.items.find((x) => x.id === itemId).schedule, null);
});

test('manifest de DEVICE carrega schedule e NAO filtra', async () => {
  // item que nunca esta ativo agora (intervalo de datas no passado)
  await req('PATCH', `/api/playlists/${playlistId}/items/${itemId}`, {
    json: { schedule: { from: '2000-01-01', until: '2000-01-02' } },
  });
  // pareia um device e atribui a playlist
  const pair = await fetch(`${baseUrl}/api/pair/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hardware_id: 'hw-m6' }),
  });
  const { deviceId, token: dtok } = await pair.json();
  await req('POST', `/api/devices/${deviceId}/assign`, { json: { playlist_id: playlistId } });

  const man = await fetch(`${baseUrl}/api/devices/${deviceId}/manifest?v=-1&p=-1`, { headers: { authorization: `Bearer ${dtok}` } });
  const body = await man.json();
  const it = body.items.find((x) => x.id === itemId);
  assert.ok(it, 'device manifest deve conter o item mesmo fora do horario');
  assert.deepEqual(it.schedule, { from: '2000-01-01', until: '2000-01-02' });
});

test('preview manifest com ?active_at filtra pelo day-parting', async () => {
  await req('PATCH', `/api/playlists/${playlistId}/items/${itemId}`, {
    json: { schedule: { start: '09:00', end: '17:00' } },
  });
  const inWindow = await req('GET', `/api/playlists/${playlistId}/manifest?active_at=2026-09-07T12:00:00`);
  assert.ok(inWindow.body.items.some((x) => x.id === itemId));

  const outWindow = await req('GET', `/api/playlists/${playlistId}/manifest?active_at=2026-09-07T20:00:00`);
  assert.ok(outWindow.body.items.every((x) => x.id !== itemId));

  // sem active_at nao filtra
  const all = await req('GET', `/api/playlists/${playlistId}/manifest`);
  assert.ok(all.body.items.some((x) => x.id === itemId));

  assert.equal((await req('GET', `/api/playlists/${playlistId}/manifest?active_at=xyz`)).status, 400);
});

test('PUT items aceita schedule por item', async () => {
  const r = await req('PUT', `/api/playlists/${playlistId}/items`, {
    json: { items: [
      { asset_id: assetId, duration: 5, schedule: { days: [1] } },
      { asset_id: assetId, duration: 5 },
    ] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items[0].schedule, { days: [1] });
  assert.equal(r.body.items[1].schedule, null);
});
