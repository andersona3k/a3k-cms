'use strict';

const express = require('express');
const { getDb } = require('../db');
const { defaultCompanyId, companyCount } = require('../lib/company');
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

// Busca uma solicitacao de pareamento aberta pelo codigo (fluxo "Add player").
function openPairRequest(db, code) {
  if (!code) return null;
  return db
    .prepare(
      `SELECT * FROM pair_requests
        WHERE code = ? AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .get(String(code).trim().toUpperCase());
}

function consumePairRequest(db, requestId, deviceId) {
  db.prepare(
    `UPDATE pair_requests
        SET status = 'consumed', device_id = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(deviceId, requestId);
}

// POST /api/pair/new  { hardware_id?, player_type?, name?, code? }
// - com code valido: device nasce vinculado (nome/grupo/tipo da solicitacao).
// - sem code: device solto (comportamento do M1).
router.post('/pair/new', (req, res) => {
  const db = getDb();
  const { hardware_id: hardwareId, name, code } = req.body || {};

  let playerType = (req.body && req.body.player_type) || 'unknown';
  if (![...PLAYER_TYPES, 'unknown'].includes(playerType)) playerType = 'unknown';

  const request = openPairRequest(db, code);
  if (code && !request) {
    return res.status(400).json({ error: 'codigo de pareamento invalido ou expirado' });
  }
  // multiempresa: sem codigo nao da p/ saber a empresa alvo.
  if (!request && companyCount() > 1) {
    return res.status(400).json({ error: 'informe um codigo de pareamento (multiempresa)' });
  }

  const companyId = request ? request.company_id : defaultCompanyId();
  const boundName = request && request.name ? request.name : name || null;
  const boundGroup = request ? request.group_id : null;
  const boundType =
    request && request.player_type !== 'unknown' ? request.player_type : playerType;

  // re-pair pelo hardware_id
  if (hardwareId) {
    const existing = db.prepare('SELECT * FROM devices WHERE hardware_id = ?').get(String(hardwareId));
    if (existing) {
      const token = newToken();
      db.exec('BEGIN');
      try {
        db.prepare(
          `UPDATE devices
              SET token = ?, player_type = ?,
                  name = COALESCE(?, name),
                  group_id = COALESCE(?, group_id),
                  last_seen = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`
        ).run(
          token,
          boundType !== 'unknown' ? boundType : existing.player_type,
          request && request.name ? request.name : null,
          request ? request.group_id : null,
          existing.id
        );
        if (request) consumePairRequest(db, request.id, existing.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return res.json({
        deviceId: existing.id,
        serial: existing.serial,
        token,
        status: existing.status,
        repaired: true,
        claimed: !!request,
      });
    }
  }

  const serial = newSerial();
  const token = newToken();
  db.exec('BEGIN');
  let deviceId;
  try {
    const info = db
      .prepare(
        `INSERT INTO devices (company_id, group_id, serial, name, status, player_type, hardware_id, token, last_seen)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'))`
      )
      .run(companyId, boundGroup, serial, boundName, boundType, hardwareId || null, token);
    deviceId = Number(info.lastInsertRowid);
    if (request) consumePairRequest(db, request.id, deviceId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.status(201).json({
    deviceId,
    serial,
    token,
    status: 'active',
    claimed: !!request,
  });
});

// GET /api/devices/:id/manifest?v=N&p=PID  -> 304 so se a playlist e a versao baterem
router.get('/devices/:id/manifest', requireDevice, (req, res) => {
  const manifest = buildManifest(req.device);
  const currentPlaylistId = manifest.playlist ? manifest.playlist.id : 0;

  const clientV = req.query.v != null ? Number(req.query.v) : null;
  const clientP = req.query.p != null ? Number(req.query.p) : null;
  const samePlaylist = clientP == null || clientP === currentPlaylistId;

  if (clientV != null && clientV === manifest.version && samePlaylist) {
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
  const appliedNum = appliedV != null ? Number(appliedV) : null;
  db.prepare(
    `UPDATE devices
        SET last_seen = datetime('now'),
            status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
            capabilities = COALESCE(?, capabilities),
            last_version = COALESCE(?, last_version),
            last_version_at = CASE
              WHEN ? IS NOT NULL AND ? <> COALESCE(last_version, -1)
              THEN datetime('now') ELSE last_version_at END,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    caps != null ? JSON.stringify(caps) : null,
    appliedNum,
    appliedNum,
    appliedNum,
    req.device.id
  );

  const manifest = buildManifest(req.device);
  res.json({
    ok: true,
    currentVersion: manifest.version,
    playlistId: manifest.playlist ? manifest.playlist.id : 0,
  });
});

module.exports = router;
