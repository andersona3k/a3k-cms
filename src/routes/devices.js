'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');
const { PLAYER_TYPES } = require('../adapters');
const { buildManifest } = require('../lib/manifest');

const router = express.Router();
router.use(requireAuth);

function scoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM devices WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

// nao vaza o token do device na listagem admin
function publicDevice(d) {
  if (!d) return d;
  const { token, ...rest } = d;
  return { ...rest, paired: !!token };
}

// device + playlist efetiva (propria ou herdada do grupo)
function deviceWithResolution(db, d) {
  const own = db
    .prepare(
      `SELECT p.id, p.name, p.version FROM assignments a JOIN playlists p ON p.id = a.playlist_id
        WHERE a.company_id = ? AND a.target_type = 'device' AND a.target_id = ?`
    )
    .get(d.company_id, d.id);
  const grp = d.group_id
    ? db
        .prepare(
          `SELECT p.id, p.name, p.version FROM assignments a JOIN playlists p ON p.id = a.playlist_id
            WHERE a.company_id = ? AND a.target_type = 'group' AND a.target_id = ?`
        )
        .get(d.company_id, d.group_id)
    : null;
  const groupName = d.group_id
    ? (db.prepare('SELECT name FROM device_groups WHERE id = ?').get(d.group_id) || {}).name
    : null;

  const eff = own
    ? { ...own, source: 'device' }
    : grp
      ? { ...grp, source: 'group' }
      : null;

  return {
    ...publicDevice(d),
    group_name: groupName || null,
    own_playlist: own || null,
    effective_playlist: eff,
    // compat M1: reflete o assignment PROPRIO do device
    assigned_playlist_id: own ? own.id : null,
    assigned_playlist_name: own ? own.name : null,
    assigned_playlist_version: own ? own.version : null,
  };
}

// GET /api/devices
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM devices WHERE company_id = ? ORDER BY id DESC')
    .all(req.auth.companyId);
  res.json({ devices: rows.map((d) => deviceWithResolution(db, d)) });
});

// GET /api/devices/:id  (inclui o manifest que o device receberia)
router.get('/:id', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  res.json({ device: deviceWithResolution(db, device), manifest: buildManifest(device) });
});

// PATCH /api/devices/:id  { name?, status?, player_type?, group_id? }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });

  const sets = [];
  const vals = [];
  const b = req.body || {};
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(b.name); }
  if (b.status !== undefined) {
    if (!['pending', 'active', 'disabled'].includes(b.status)) {
      return res.status(400).json({ error: 'status invalido' });
    }
    sets.push('status = ?'); vals.push(b.status);
  }
  if (b.player_type !== undefined) {
    if (![...PLAYER_TYPES, 'unknown'].includes(b.player_type)) {
      return res.status(400).json({ error: 'player_type invalido' });
    }
    sets.push('player_type = ?'); vals.push(b.player_type);
  }
  if (b.group_id !== undefined) { sets.push('group_id = ?'); vals.push(b.group_id || null); }

  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
  sets.push(`updated_at = datetime('now')`);
  vals.push(device.id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ device: publicDevice(scoped(db, device.id, req.auth.companyId)) });
});

// POST /api/devices/:id/assign  { playlist_id }
router.post('/:id/assign', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });

  const playlistId = Number(req.body && req.body.playlist_id);
  const playlist = db
    .prepare('SELECT * FROM playlists WHERE id = ? AND company_id = ?')
    .get(playlistId, req.auth.companyId);
  if (!playlist) return res.status(400).json({ error: 'playlist_id invalido' });

  db.prepare(
    `INSERT INTO assignments (company_id, playlist_id, target_type, target_id)
     VALUES (?, ?, 'device', ?)
     ON CONFLICT (company_id, target_type, target_id)
     DO UPDATE SET playlist_id = excluded.playlist_id, updated_at = datetime('now')`
  ).run(req.auth.companyId, playlistId, device.id);

  res.json({ ok: true, manifest: buildManifest(device) });
});

// DELETE /api/devices/:id/assign
router.delete('/:id/assign', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  db.prepare(
    `DELETE FROM assignments WHERE company_id = ? AND target_type = 'device' AND target_id = ?`
  ).run(req.auth.companyId, device.id);
  res.json({ ok: true });
});

module.exports = router;
