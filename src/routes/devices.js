'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, writeGuard } = require('../auth/middleware');
const { PLAYER_TYPES } = require('../adapters');
const { buildManifest } = require('../lib/manifest');
const { logActivity, recentForDevice } = require('../lib/activity');
const { CMD_TYPES, SHOT_INTERVALS } = require('../lib/deviceMgmt');

function groupName(db, id) {
  if (!id) return null;
  const r = db.prepare('SELECT name FROM device_groups WHERE id = ?').get(id);
  return r ? r.name : ('#' + id);
}

const router = express.Router();
router.use(requireAuth, writeGuard('devices:write'));

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
  const newGroup = b.group_id !== undefined ? (b.group_id || null) : undefined;
  if (newGroup !== undefined) { sets.push('group_id = ?'); vals.push(newGroup); }
  if (b.screenshot_interval !== undefined) {
    const v = Number(b.screenshot_interval);
    if (!SHOT_INTERVALS.includes(v)) return res.status(400).json({ error: 'screenshot_interval invalido (1/5/10/30/60)' });
    sets.push('screenshot_interval = ?'); vals.push(v);
  }
  if (b.comm_interval !== undefined) {
    const v = Math.max(1, Math.min(1440, Number(b.comm_interval) || 60));
    sets.push('comm_interval = ?'); vals.push(v);
  }

  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
  sets.push(`updated_at = datetime('now')`);
  vals.push(device.id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  const label = device.name || device.serial;
  if (newGroup !== undefined && Number(newGroup) !== Number(device.group_id || 0)) {
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'group',
      detail: `${label}: grupo ${groupName(db, device.group_id) || '—'} -> ${groupName(db, newGroup) || '—'}`,
      actor: req.auth,
    });
  }
  if (b.name !== undefined && b.name !== device.name) {
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'rename',
      detail: `renomeado "${device.name || '—'}" -> "${b.name || '—'}"`, actor: req.auth,
    });
  }
  if (b.status !== undefined && b.status !== device.status) {
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'status',
      detail: `${label}: status ${device.status} -> ${b.status}`, actor: req.auth,
    });
  }
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

  logActivity(db, {
    companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'assign',
    detail: `${device.name || device.serial}: playlist propria -> "${playlist.name}" (v${playlist.version})`,
    actor: req.auth,
  });

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
  logActivity(db, {
    companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'assign',
    detail: `${device.name || device.serial}: playlist propria removida (volta a herdar do grupo)`,
    actor: req.auth,
  });
  res.json({ ok: true });
});

// GET /api/devices/:id/activity?limit=5  — historico do device + do grupo dele
router.get('/:id/activity', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  res.json({
    activity: recentForDevice(db, {
      companyId: req.auth.companyId,
      deviceId: device.id,
      groupId: device.group_id || null,
      limit: req.query.limit,
    }),
  });
});

// ---- gestão remota (comandos / capturas / log de comunicação) ----

// POST /api/devices/:id/commands  { type, params? }
router.post('/:id/commands', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  const type = String((req.body && req.body.type) || '');
  if (!CMD_TYPES.includes(type)) return res.status(400).json({ error: 'type invalido' });
  const params = req.body && req.body.params ? JSON.stringify(req.body.params) : null;
  const actor = req.auth.email || null;

  // unassign_playlist resolve na hora (server-side); os demais viram fila p/ o player
  if (type === 'unassign_playlist') {
    db.prepare(
      `DELETE FROM assignments WHERE company_id = ? AND target_type = 'device' AND target_id = ?`
    ).run(req.auth.companyId, device.id);
    const info = db.prepare(
      `INSERT INTO device_commands (company_id, device_id, type, params, status, result, created_by, done_at)
       VALUES (?, ?, 'unassign_playlist', NULL, 'ok', 'playlist desvinculada', ?, datetime('now'))`
    ).run(req.auth.companyId, device.id, actor);
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'command',
      detail: `${device.name || device.serial}: remover playlist`, actor: req.auth,
    });
    return res.status(201).json({ command: db.prepare('SELECT * FROM device_commands WHERE id = ?').get(Number(info.lastInsertRowid)) });
  }

  const info = db.prepare(
    `INSERT INTO device_commands (company_id, device_id, type, params, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.auth.companyId, device.id, type, params, actor);
  logActivity(db, {
    companyId: req.auth.companyId, targetType: 'device', targetId: device.id, action: 'command',
    detail: `${device.name || device.serial}: ${type}`, actor: req.auth,
  });
  res.status(201).json({ command: db.prepare('SELECT * FROM device_commands WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

// GET /api/devices/:id/commands?limit=50
router.get('/:id/commands', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({
    commands: db.prepare(
      `SELECT id, type, status, result, created_by, created_at, done_at
         FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT ?`
    ).all(device.id, limit),
  });
});

// GET /api/devices/:id/screenshots  — últimos 7 dias
router.get('/:id/screenshots', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  res.json({
    screenshots: db.prepare(
      `SELECT id, url, bytes, source, taken_at FROM device_screenshots
        WHERE device_id = ? AND taken_at >= datetime('now', '-7 days')
        ORDER BY id DESC LIMIT 400`
    ).all(device.id),
  });
});

// GET /api/devices/:id/comm-log?days=30
router.get('/:id/comm-log', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 30));
  const rows = db.prepare(
    `SELECT at, attempt, ok, ms, detail FROM device_comm_log
      WHERE device_id = ? AND at >= datetime('now', ?)
      ORDER BY id DESC LIMIT 2000`
  ).all(device.id, `-${days} days`);
  res.json({ comm_log: rows });
});

// DELETE /api/devices/:id  — remove o device (e seu assignment proprio).
// O player fisico, no proximo poll, toma 401 e pareia de novo (novo registro).
router.delete('/:id', (req, res) => {
  const db = getDb();
  const device = scoped(db, req.params.id, req.auth.companyId);
  if (!device) return res.status(404).json({ error: 'device nao encontrado' });
  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM assignments WHERE company_id = ? AND target_type = 'device' AND target_id = ?`
    ).run(req.auth.companyId, device.id);
    db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

module.exports = router;
