'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, writeGuard } = require('../auth/middleware');
const { buildPlaylistManifest } = require('../lib/manifest');
const { validateSchedule, isActive } = require('../lib/schedule');

const router = express.Router();
router.use(requireAuth, writeGuard('playlists:write'));

function getPlaylistScoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM playlists WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

// Qualquer mudanca no conteudo incrementa version -> dispara re-sync no player.
function bumpVersion(db, playlistId) {
  db.prepare(
    `UPDATE playlists SET version = version + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(playlistId);
}

function itemsOf(db, playlistId) {
  const now = new Date();
  return db
    .prepare(
      `SELECT pi.id, pi.asset_id, pi.ordem, pi.duration, pi.schedule,
              a.type, a.filename, a.url, a.hash, a.size_bytes
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId)
    .map((r) => {
      let schedule = null;
      if (r.schedule) { try { schedule = JSON.parse(r.schedule); } catch { schedule = null; } }
      return { ...r, schedule, active_now: isActive(schedule, now) };
    });
}

const ROTATIONS = [0, 90, 180, 270];

// POST /api/playlists  { name, rotation? }
router.post('/', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  let rotation = 0;
  if (req.body && req.body.rotation !== undefined) {
    rotation = Number(req.body.rotation);
    if (!ROTATIONS.includes(rotation)) return res.status(400).json({ error: 'rotation deve ser 0, 90, 180 ou 270' });
  }
  const db = getDb();
  try {
    const info = db
      .prepare('INSERT INTO playlists (company_id, name, rotation) VALUES (?, ?, ?)')
      .run(req.auth.companyId, name, rotation);
    const playlist = db
      .prepare('SELECT * FROM playlists WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    res.status(201).json({ playlist });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe playlist com esse nome' });
    }
    throw err;
  }
});

// GET /api/playlists
router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS item_count
         FROM playlists p WHERE p.company_id = ? ORDER BY p.id DESC`
    )
    .all(req.auth.companyId);
  res.json({ playlists: rows });
});

// GET /api/playlists/:id  (com itens)
router.get('/:id', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });
  res.json({ playlist, items: itemsOf(db, playlist.id) });
});

// GET /api/playlists/:id/manifest[?active_at=<ISO>]
// preview: mesmo shape do manifest de device; com active_at filtra o day-parting.
router.get('/:id/manifest', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  let activeAt;
  if (req.query.active_at != null) {
    const d = req.query.active_at === 'now' ? new Date() : new Date(req.query.active_at);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'active_at invalido (ISO ou "now")' });
    activeAt = d;
  }
  res.json(buildPlaylistManifest(playlist, activeAt));
});

// PATCH /api/playlists/:id  { name?, rotation? }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const b = req.body || {};
  const name = (b.name || '').trim();
  if (name) {
    db.prepare(`UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, playlist.id);
  }
  if (b.rotation !== undefined) {
    const rotation = Number(b.rotation);
    if (!ROTATIONS.includes(rotation)) {
      return res.status(400).json({ error: 'rotation deve ser 0, 90, 180 ou 270' });
    }
    if (rotation !== playlist.rotation) {
      // rotacao muda a renderizacao -> forca re-sync no player
      db.prepare(
        `UPDATE playlists SET rotation = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`
      ).run(rotation, playlist.id);
    }
  }
  res.json({ playlist: getPlaylistScoped(db, playlist.id, req.auth.companyId) });
});

// DELETE /api/playlists/:id[?force=true]
// itens e assignments caem por FK CASCADE. 409 se estiver atribuida a algum alvo.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const targets = db
    .prepare(`SELECT target_type, target_id FROM assignments WHERE company_id = ? AND playlist_id = ?`)
    .all(req.auth.companyId, playlist.id);
  if (targets.length > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: 'playlist atribuida a device(s)/grupo(s)',
      targets,
      hint: 'repita com ?force=true',
    });
  }

  db.prepare('DELETE FROM playlists WHERE id = ?').run(playlist.id);
  res.json({ ok: true, removed_assignments: targets.length });
});

// POST /api/playlists/:id/items  { asset_id, duration?, ordem?, schedule? }
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const assetId = Number(req.body && req.body.asset_id);
  if (!assetId) return res.status(400).json({ error: 'asset_id obrigatorio' });
  const asset = db
    .prepare('SELECT * FROM assets WHERE id = ? AND company_id = ?')
    .get(assetId, req.auth.companyId);
  if (!asset) return res.status(400).json({ error: 'asset_id invalido' });

  const sched = validateSchedule(req.body ? req.body.schedule : undefined);
  if (!sched.ok) return res.status(400).json({ error: sched.error });

  let ordem = req.body.ordem;
  if (ordem === undefined || ordem === null) {
    const max = db
      .prepare('SELECT COALESCE(MAX(ordem), -1) AS m FROM playlist_items WHERE playlist_id = ?')
      .get(playlist.id).m;
    ordem = max + 1;
  }
  const duration =
    req.body.duration != null ? Number(req.body.duration) : asset.duration || 10;

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration, schedule)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(playlist.id, assetId, ordem, duration, sched.value ? JSON.stringify(sched.value) : null);
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.status(201).json({
      item: db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(Number(info.lastInsertRowid)),
      version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version,
    });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// PATCH /api/playlists/:id/items/:itemId  { duration?, ordem?, schedule? }
// schedule: objeto p/ definir, null p/ limpar (sempre no ar).
router.patch('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const item = db
    .prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(Number(req.params.itemId), playlist.id);
  if (!item) return res.status(404).json({ error: 'item nao encontrado' });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.duration !== undefined) {
    const d = Number(b.duration);
    if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'duration invalida' });
    sets.push('duration = ?'); vals.push(d);
  }
  if (b.ordem !== undefined) {
    const o = Number(b.ordem);
    if (!Number.isInteger(o) || o < 0) return res.status(400).json({ error: 'ordem invalida' });
    sets.push('ordem = ?'); vals.push(o);
  }
  if (b.schedule !== undefined) {
    const s = validateSchedule(b.schedule);
    if (!s.ok) return res.status(400).json({ error: s.error });
    sets.push('schedule = ?'); vals.push(s.value ? JSON.stringify(s.value) : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });

  db.exec('BEGIN');
  try {
    sets.push(`updated_at = datetime('now')`);
    vals.push(item.id);
    db.prepare(`UPDATE playlist_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({
    items: itemsOf(db, playlist.id),
    version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version,
  });
});

// PUT /api/playlists/:id/order  { item_ids: [...] }  (reordena os itens existentes)
router.put('/:id/order', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const ids = Array.isArray(req.body && req.body.item_ids)
    ? req.body.item_ids.map(Number)
    : null;
  if (!ids) return res.status(400).json({ error: 'item_ids[] obrigatorio' });
  if (ids.some((n) => !Number.isInteger(n))) {
    return res.status(400).json({ error: 'item_ids invalidos' });
  }

  const current = db
    .prepare('SELECT id FROM playlist_items WHERE playlist_id = ?')
    .all(playlist.id)
    .map((r) => r.id);

  const set = new Set(ids);
  if (set.size !== ids.length) {
    return res.status(400).json({ error: 'item_ids com repeticao' });
  }
  if (
    ids.length !== current.length ||
    current.some((id) => !set.has(id))
  ) {
    return res.status(400).json({
      error: 'item_ids precisa conter exatamente os itens atuais da playlist',
      current,
    });
  }

  db.exec('BEGIN');
  try {
    const upd = db.prepare(
      `UPDATE playlist_items SET ordem = ?, updated_at = datetime('now') WHERE id = ? AND playlist_id = ?`
    );
    ids.forEach((id, idx) => upd.run(idx, id, playlist.id));
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({
    items: itemsOf(db, playlist.id),
    version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version,
  });
});

// DELETE /api/playlists/:id/items/:itemId
router.delete('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  db.exec('BEGIN');
  try {
    const info = db
      .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
      .run(Number(req.params.itemId), playlist.id);
    if (info.changes === 0) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'item nao encontrado' });
    }
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.json({ ok: true, version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// PUT /api/playlists/:id/items  { items: [{ asset_id, duration }] }  (substitui tudo)
router.put('/:id/items', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items[] obrigatorio' });

  const assetIds = items.map((i) => Number(i.asset_id));
  const placeholders = assetIds.map(() => '?').join(',') || 'NULL';
  const found = db
    .prepare(`SELECT id FROM assets WHERE company_id = ? AND id IN (${placeholders})`)
    .all(req.auth.companyId, ...assetIds)
    .map((r) => r.id);
  if (found.length !== new Set(assetIds).size) {
    return res.status(400).json({ error: 'algum asset_id e invalido' });
  }

  const schedules = [];
  for (const it of items) {
    const s = validateSchedule(it.schedule);
    if (!s.ok) return res.status(400).json({ error: s.error });
    schedules.push(s.value ? JSON.stringify(s.value) : null);
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlist.id);
    const ins = db.prepare(
      `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration, schedule) VALUES (?, ?, ?, ?, ?)`
    );
    items.forEach((it, idx) => {
      ins.run(playlist.id, Number(it.asset_id), idx, it.duration != null ? Number(it.duration) : 10, schedules[idx]);
    });
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.json({ items: itemsOf(db, playlist.id), version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

module.exports = router;
