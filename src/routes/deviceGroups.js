'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, writeGuard } = require('../auth/middleware');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth, writeGuard('groups:write'));

function scoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM device_groups WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

function withMeta(db, companyId) {
  return db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count,
              a.playlist_id AS assigned_playlist_id,
              p.name        AS assigned_playlist_name,
              p.version     AS assigned_playlist_version
         FROM device_groups g
         LEFT JOIN assignments a
           ON a.company_id = g.company_id AND a.target_type = 'group' AND a.target_id = g.id
         LEFT JOIN playlists p ON p.id = a.playlist_id
        WHERE g.company_id = ?
        ORDER BY g.name`
    )
    .all(companyId);
}

// GET /api/device-groups
router.get('/', (req, res) => {
  res.json({ groups: withMeta(getDb(), req.auth.companyId) });
});

// POST /api/device-groups  { name }
router.post('/', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  const db = getDb();
  try {
    const info = db
      .prepare('INSERT INTO device_groups (company_id, name) VALUES (?, ?)')
      .run(req.auth.companyId, name);
    res.status(201).json({
      group: db.prepare('SELECT * FROM device_groups WHERE id = ?').get(Number(info.lastInsertRowid)),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe grupo com esse nome' });
    }
    throw err;
  }
});

// PATCH /api/device-groups/:id  { name }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const group = scoped(db, req.params.id, req.auth.companyId);
  if (!group) return res.status(404).json({ error: 'grupo nao encontrado' });
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name vazio' });
  try {
    db.prepare(`UPDATE device_groups SET name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, group.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe grupo com esse nome' });
    }
    throw err;
  }
  if (name !== group.name) {
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'group', targetId: group.id, action: 'rename',
      detail: `grupo "${group.name}" -> "${name}"`, actor: req.auth,
    });
  }
  res.json({ group: scoped(db, group.id, req.auth.companyId) });
});

// DELETE /api/device-groups/:id  — devices ficam sem grupo, assignment do grupo cai
router.delete('/:id', (req, res) => {
  const db = getDb();
  const group = scoped(db, req.params.id, req.auth.companyId);
  if (!group) return res.status(404).json({ error: 'grupo nao encontrado' });

  const n = db.prepare('SELECT COUNT(*) n FROM devices WHERE group_id = ?').get(group.id).n;
  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM assignments WHERE company_id = ? AND target_type = 'group' AND target_id = ?`
    ).run(req.auth.companyId, group.id);
    db.prepare('DELETE FROM device_groups WHERE id = ?').run(group.id); // devices.group_id -> NULL (FK)
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true, ungrouped_devices: n });
});

// POST /api/device-groups/:id/devices  { device_ids: [...] }  — move devices p/ o grupo
router.post('/:id/devices', (req, res) => {
  const db = getDb();
  const group = scoped(db, req.params.id, req.auth.companyId);
  if (!group) return res.status(404).json({ error: 'grupo nao encontrado' });

  const ids = Array.isArray(req.body && req.body.device_ids)
    ? req.body.device_ids.map(Number)
    : null;
  if (!ids || ids.some((n) => !Number.isInteger(n))) {
    return res.status(400).json({ error: 'device_ids[] obrigatorio' });
  }

  const placeholders = ids.map(() => '?').join(',') || 'NULL';
  const valid = db
    .prepare(`SELECT id FROM devices WHERE company_id = ? AND id IN (${placeholders})`)
    .all(req.auth.companyId, ...ids)
    .map((r) => r.id);
  if (valid.length !== new Set(ids).size) {
    return res.status(400).json({ error: 'algum device_id e invalido' });
  }

  db.exec('BEGIN');
  try {
    const upd = db.prepare(
      `UPDATE devices SET group_id = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
    );
    ids.forEach((id) => upd.run(group.id, id, req.auth.companyId));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  ids.forEach((id) => {
    logActivity(db, {
      companyId: req.auth.companyId, targetType: 'device', targetId: id, action: 'group',
      detail: `movido para o grupo "${group.name}"`, actor: req.auth,
    });
  });
  res.json({ ok: true, moved: valid.length });
});

// POST /api/device-groups/:id/assign  { playlist_id }
router.post('/:id/assign', (req, res) => {
  const db = getDb();
  const group = scoped(db, req.params.id, req.auth.companyId);
  if (!group) return res.status(404).json({ error: 'grupo nao encontrado' });

  const playlistId = Number(req.body && req.body.playlist_id);
  const playlist = db
    .prepare('SELECT id, name, version FROM playlists WHERE id = ? AND company_id = ?')
    .get(playlistId, req.auth.companyId);
  if (!playlist) return res.status(400).json({ error: 'playlist_id invalido' });

  db.prepare(
    `INSERT INTO assignments (company_id, playlist_id, target_type, target_id)
     VALUES (?, ?, 'group', ?)
     ON CONFLICT (company_id, target_type, target_id)
     DO UPDATE SET playlist_id = excluded.playlist_id, updated_at = datetime('now')`
  ).run(req.auth.companyId, playlistId, group.id);

  logActivity(db, {
    companyId: req.auth.companyId, targetType: 'group', targetId: group.id, action: 'assign',
    detail: `grupo "${group.name}": playlist -> "${playlist.name}" (v${playlist.version})`,
    actor: req.auth,
  });

  res.json({ ok: true });
});

// DELETE /api/device-groups/:id/assign
router.delete('/:id/assign', (req, res) => {
  const db = getDb();
  const group = scoped(db, req.params.id, req.auth.companyId);
  if (!group) return res.status(404).json({ error: 'grupo nao encontrado' });
  db.prepare(
    `DELETE FROM assignments WHERE company_id = ? AND target_type = 'group' AND target_id = ?`
  ).run(req.auth.companyId, group.id);
  logActivity(db, {
    companyId: req.auth.companyId, targetType: 'group', targetId: group.id, action: 'assign',
    detail: `grupo "${group.name}": playlist removida`, actor: req.auth,
  });
  res.json({ ok: true });
});

module.exports = router;
