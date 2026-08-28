'use strict';

const express = require('express');
const { getDb } = require('../db');
const { defaultCompanyId } = require('../lib/company');
const { newSerial, newToken } = require('../lib/ids');
const { buildManifest } = require('../lib/manifest');
const { PLAYER_TYPES } = require('../adapters');

const router = express.Router();

// Auth de device: Bearer <token>, e o :id da rota tem que bater com o dono do token.
function requireDevice(req, res, next) {
  const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'token do device ausente' });
  const device = getDb().prepare('SELECT * FROM devices WHERE token = ?').get(m[1]);
  if (!device) return res.status(401).json({ error: 'token invalido' });
  if (String(device.id) !== String(req.params.id)) {
    return res.status(403).json({ error: 'token nao pertence a este device' });
  }
  req.device = device;
  next();
}

// POST /api/pair/new  { hardware_id?, player_type?, name? }
// Registra o device (ou reaproveita pelo hardware_id) e devolve credenciais.
router.post('/pair/new', (req, res) => {
  const db = getDb();
  const companyId = defaultCompanyId();
  const { hardware_id: hardwareId, name } = req.body || {};
  let playerType = (req.body && req.body.player_type) || 'unknown';
  if (!PLAYER_TYPES.includes(playerType)) playerType = 'unknown';

  if (hardwareId) {
    const existing = db
      .prepare('SELECT * FROM devices WHERE hardware_id = ?')
      .get(String(hardwareId));
    if (existing) {
      // re-pair: gera token novo, mantem serial/assignment.
      const token = newToken();
      db.prepare(
        `UPDATE devices SET token = ?, player_type = ?, last_seen = datetime('now'),
                            updated_at = datetime('now') WHERE id = ?`
      ).run(token, playerType !== 'unknown' ? playerType : existing.player_type, existing.id);
      return res.json({
        deviceId: existing.id,
        serial: existing.serial,
        token,
        status: existing.status,
        repaired: true,
      });
    }
  }

  const serial = newSerial();
  const token = newToken();
  const info = db
    .prepare(
      `INSERT INTO devices (company_id, serial, name, status, player_type, hardware_id, token, last_seen)
       VALUES (?, ?, ?, 'active', ?, ?, ?, datetime('now'))`
    )
    .run(companyId, serial, name || null, playerType, hardwareId || null, token);

  res.status(201).json({
    deviceId: Number(info.lastInsertRowid),
    serial,
    token,
    status: 'active',
  });
});

// GET /api/devices/:id/manifest?v=N   -> 304 se v == versao atual
router.get('/devices/:id/manifest', requireDevice, (req, res) => {
  const manifest = buildManifest(req.device);
  const clientV = req.query.v != null ? Number(req.query.v) : null;
  if (clientV != null && clientV === manifest.version) {
    return res.status(304).end();
  }
  res.set('Cache-Control', 'no-store');
  res.json(manifest);
});

// POST /api/devices/:id/heartbeat  { capabilities?, playlist_version? }
router.post('/devices/:id/heartbeat', requireDevice, (req, res) => {
  const db = getDb();
  const caps = req.body && req.body.capabilities;
  const appliedV = req.body && req.body.playlist_version;
  db.prepare(
    `UPDATE devices
        SET last_seen = datetime('now'),
            status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
            capabilities = COALESCE(?, capabilities),
            last_version = COALESCE(?, last_version),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    caps != null ? JSON.stringify(caps) : null,
    appliedV != null ? Number(appliedV) : null,
    req.device.id
  );

  const manifest = buildManifest(req.device);
  res.json({ ok: true, currentVersion: manifest.version });
});

module.exports = router;
