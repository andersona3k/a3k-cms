'use strict';

// Ativação iniciada pelo player (o link gera o código; o servidor valida).
//   PLAYER  (público):
//     POST /api/activation/new      -> cunha um código 'pending' p/ o hardware
//     GET  /api/activation/status   -> poll até virar 'redeemed' (devolve o token)
//   ADMIN   (JWT + pairing:manage):
//     GET  /api/activation          -> pendentes em voo (UX)
//     POST /api/activation/redeem   -> cria o device, amarra na playlist, single-use

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { requireAuth, writeGuard } = require('../auth/middleware');
const { newPairCode, newToken } = require('../lib/ids');
const { provisionDevice, normType } = require('../lib/provision');

const router = express.Router();
const TTL_MIN = 15;

function sweep(db) {
  db.prepare(
    `UPDATE activation_codes
        SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending' AND expires_at < datetime('now')`
  ).run();
}

// ---------------------------------------------------------------- PLAYER

// POST /api/activation/new  { hardware_id, player_type?, capabilities? }
router.post('/new', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const hardwareId = String(b.hardware_id || '').trim();
  if (!hardwareId) return res.status(400).json({ error: 'hardware_id obrigatorio' });

  sweep(db);

  // hardware já é um device ativo -> não precisa de código: emite um token novo.
  // (posse do hardware_id — um UUID gravado no localStorage do player — é a prova,
  //  mesmo modelo do re-pair de POST /api/pair/new.)
  const dev = db.prepare("SELECT id, serial, status FROM devices WHERE hardware_id = ?").get(hardwareId);
  if (dev && dev.status !== 'disabled') {
    const token = newToken();
    db.prepare("UPDATE devices SET token = ?, last_seen = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(token, dev.id);
    return res.json({ already_active: true, device: { id: dev.id, serial: dev.serial, token } });
  }

  // refresh do link não deve gerar N códigos: reaproveita o pending do hardware.
  const cur = db.prepare(
    "SELECT * FROM activation_codes WHERE hardware_id = ? AND status = 'pending'"
  ).get(hardwareId);
  if (cur) {
    return res.json({ code: cur.code, status: cur.status, expires_at: cur.expires_at, poll_secret: cur.poll_secret });
  }

  let code;
  for (let i = 0; i < 12; i++) {
    const c = newPairCode();
    if (!db.prepare('SELECT 1 FROM activation_codes WHERE code = ?').get(c)) { code = c; break; }
  }
  if (!code) return res.status(500).json({ error: 'nao consegui gerar codigo' });
  const pollSecret = crypto.randomBytes(16).toString('hex');

  db.prepare(
    `INSERT INTO activation_codes (code, hardware_id, player_type, capabilities, poll_secret, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+${TTL_MIN} minutes'))`
  ).run(
    code,
    hardwareId,
    normType(b.player_type),
    b.capabilities ? JSON.stringify(b.capabilities) : null,
    pollSecret
  );

  const row = db.prepare('SELECT * FROM activation_codes WHERE code = ?').get(code);
  res.status(201).json({ code: row.code, status: row.status, expires_at: row.expires_at, poll_secret: pollSecret });
});

// GET /api/activation/status?hardware_id=..&s=<poll_secret>
router.get('/status', (req, res) => {
  const db = getDb();
  sweep(db);
  const hardwareId = String(req.query.hardware_id || '').trim();
  const s = String(req.query.s || '');
  if (!hardwareId || !s) return res.status(400).json({ error: 'hardware_id e s obrigatorios' });

  const row = db.prepare(
    `SELECT * FROM activation_codes
      WHERE hardware_id = ? AND poll_secret = ?
      ORDER BY id DESC LIMIT 1`
  ).get(hardwareId, s);

  if (!row) {
    // o hardware pode ter virado device por outro caminho
    const dev = db.prepare("SELECT id, serial FROM devices WHERE hardware_id = ?").get(hardwareId);
    if (dev) return res.json({ status: 'redeemed', device: { id: dev.id, serial: dev.serial } });
    return res.status(404).json({ error: 'nenhuma ativacao para este hardware' });
  }

  if (row.status === 'redeemed' && row.device_id) {
    const dev = db.prepare('SELECT id, serial, token FROM devices WHERE id = ?').get(row.device_id);
    return res.json({ status: 'redeemed', device: dev, playlist_id: row.playlist_id || null });
  }
  return res.json({ status: row.status, expires_at: row.expires_at });
});

// ---------------------------------------------------------------- ADMIN
router.use(requireAuth, writeGuard('pairing:manage'));

// GET /api/activation  — códigos pendentes (para o painel mostrar quem está esperando)
router.get('/', (req, res) => {
  const db = getDb();
  sweep(db);
  const rows = db.prepare(
    `SELECT code, hardware_id, player_type, status, expires_at, created_at
       FROM activation_codes
      WHERE status = 'pending'
      ORDER BY id DESC LIMIT 50`
  ).all();
  res.json({ pending: rows });
});

// POST /api/activation/redeem  { code, playlist_id?, name?, group_id? }
router.post('/redeem', (req, res) => {
  const db = getDb();
  sweep(db);
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });

  const row = db.prepare('SELECT * FROM activation_codes WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ error: 'codigo nao encontrado' });
  if (row.status === 'redeemed') return res.status(409).json({ error: 'codigo ja usado' });
  if (row.status !== 'pending') return res.status(410).json({ error: 'codigo expirado — gere um novo no player' });

  let playlistId = null;
  if (b.playlist_id != null && b.playlist_id !== '') {
    playlistId = Number(b.playlist_id);
    const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND company_id = ?')
      .get(playlistId, req.auth.companyId);
    if (!pl) return res.status(400).json({ error: 'playlist_id invalido' });
  }
  let groupId = null;
  if (b.group_id) {
    groupId = Number(b.group_id);
    const g = db.prepare('SELECT id FROM device_groups WHERE id = ? AND company_id = ?')
      .get(groupId, req.auth.companyId);
    if (!g) return res.status(400).json({ error: 'group_id invalido' });
  }

  let device;
  db.exec('BEGIN');
  try {
    device = provisionDevice(db, {
      companyId: req.auth.companyId,
      hardwareId: row.hardware_id,
      playerType: row.player_type,
      name: (b.name || '').trim() || null,
      groupId,
    }).device;
    if (playlistId) {
      db.prepare(
        `INSERT INTO assignments (company_id, playlist_id, target_type, target_id)
         VALUES (?, ?, 'device', ?)
         ON CONFLICT(company_id, target_type, target_id)
         DO UPDATE SET playlist_id = excluded.playlist_id, updated_at = datetime('now')`
      ).run(req.auth.companyId, playlistId, device.id);
    }
    db.prepare(
      `UPDATE activation_codes
          SET status = 'redeemed', company_id = ?, device_id = ?, playlist_id = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(req.auth.companyId, device.id, playlistId, row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.status(201).json({
    device: { id: device.id, serial: device.serial, name: device.name },
    playlist_id: playlistId,
  });
});

module.exports = router;
