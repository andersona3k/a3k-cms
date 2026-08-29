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
              pi.rotation, pi.mirror, pi.suspended,
              a.type, a.filename, a.url, a.hash, a.size_bytes, a.width, a.height, a.format
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId)
    .map((r) => {
      let schedule = null;
      if (r.schedule) { try { schedule = JSON.parse(r.schedule); } catch { schedule = null; } }
      return {
        ...r,
        schedule,
        suspended: !!r.suspended,
        duration_locked: r.type === 'video',
        active_now: !r.suspended && isActive(schedule, now),
      };
    });
}

const ROTATIONS = [0, 90, 180, 270];

function parseRotation(v, { nullable } = {}) {
  if (v === undefined) return { skip: true };
  if (v === null || v === '') return nullable ? { value: null } : { error: 'rotation obrigatoria' };
  const n = Number(v);
  if (!ROTATIONS.includes(n)) return { error: 'rotation deve ser 0, 90, 180 ou 270' };
  return { value: n };
}
function parseBool01(v, { nullable } = {}) {
  if (v === undefined) return { skip: true };
  if (v === null) return nullable ? { value: null } : { value: 0 };
  return { value: v ? 1 : 0 };
}

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
  const folderId = req.body && req.body.folder_id ? Number(req.body.folder_id) : null;
  if (folderId) {
    const f = db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND company_id = ?')
      .get(folderId, req.auth.companyId);
    if (!f) return res.status(400).json({ error: 'folder_id invalido' });
  }
  try {
    const info = db
      .prepare('INSERT INTO playlists (company_id, name, rotation, folder_id, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(req.auth.companyId, name, rotation, folderId, req.auth.email || null);
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

// status de gestao da playlist: 'vencida' | 'em_uso' | 'planejada'
function playlistStatus(p, todayYmd) {
  if (p.valid_until && p.valid_until < todayYmd) return 'vencida';
  if (p.assigned) return 'em_uso';
  return 'planejada';
}

// tipo de conteudo a partir dos itens: 'video' | 'imagem' | 'mix' | null
function contentType(db, playlistId) {
  const rows = db
    .prepare(
      `SELECT a.type, COUNT(*) n
         FROM playlist_items pi JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ? GROUP BY a.type`
    )
    .all(playlistId);
  if (!rows.length) return null;
  if (rows.length > 1) return 'mix';
  const t = rows[0].type;
  return t === 'image' ? 'imagem' : t === 'video' ? 'video' : t;
}

// GET /api/playlists[?include_archived=true]
router.get('/', (req, res) => {
  const db = getDb();
  const includeArchived = req.query.include_archived === 'true' || req.query.include_archived === '1';
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS item_count,
              (SELECT COALESCE(SUM(duration), 0) FROM playlist_items
                 WHERE playlist_id = p.id AND suspended = 0) AS total_duration,
              EXISTS (SELECT 1 FROM assignments a
                       WHERE a.company_id = p.company_id AND a.playlist_id = p.id) AS assigned
         FROM playlists p
        WHERE p.company_id = ? ${includeArchived ? '' : 'AND p.archived = 0'}
        ORDER BY p.id DESC`
    )
    .all(req.auth.companyId);
  const today = new Date().toISOString().slice(0, 10);
  const playlists = rows.map((p) => ({
    ...p,
    assigned: !!p.assigned,
    suspended: !!p.suspended,
    archived: !!p.archived,
    content_type: contentType(db, p.id),
    status: playlistStatus(p, today),
  }));
  res.json({ playlists });
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

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// PATCH /api/playlists/:id  { name?, rotation?, mirror?, folder_id?, valid_from?, valid_until?, suspended?, archived? }
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
  const rot = parseRotation(b.rotation);
  if (rot.error) return res.status(400).json({ error: rot.error });
  const mir = parseBool01(b.mirror);

  const sets = [];
  const vals = [];
  let bumps = false; // mudou algo que o player ve?

  if (!rot.skip && rot.value !== playlist.rotation) { sets.push('rotation = ?'); vals.push(rot.value); bumps = true; }
  if (!mir.skip && mir.value !== playlist.mirror) { sets.push('mirror = ?'); vals.push(mir.value); bumps = true; }

  if (b.folder_id !== undefined) {
    const fid = b.folder_id === null || b.folder_id === '' ? null : Number(b.folder_id);
    if (fid !== null) {
      const f = db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND company_id = ?')
        .get(fid, req.auth.companyId);
      if (!f) return res.status(400).json({ error: 'folder_id invalido' });
    }
    sets.push('folder_id = ?'); vals.push(fid);
  }
  for (const k of ['valid_from', 'valid_until']) {
    if (b[k] !== undefined) {
      const v = b[k] === null || b[k] === '' ? null : String(b[k]).slice(0, 10);
      if (v !== null && !YMD_RE.test(v)) return res.status(400).json({ error: `${k}: use YYYY-MM-DD` });
      sets.push(`${k} = ?`); vals.push(v);
    }
  }
  const vf = b.valid_from !== undefined ? (b.valid_from || null) : playlist.valid_from;
  const vu = b.valid_until !== undefined ? (b.valid_until || null) : playlist.valid_until;
  if (vf && vu && String(vf).slice(0, 10) > String(vu).slice(0, 10)) {
    return res.status(400).json({ error: 'vigencia: inicio depois do fim' });
  }
  if (b.suspended !== undefined) {
    const s = b.suspended ? 1 : 0;
    if (s !== playlist.suspended) { sets.push('suspended = ?'); vals.push(s); bumps = true; }
  }
  if (b.archived !== undefined) {
    sets.push('archived = ?'); vals.push(b.archived ? 1 : 0);
  }

  if (sets.length) {
    if (bumps) sets.push('version = version + 1');
    sets.push(`updated_at = datetime('now')`);
    vals.push(playlist.id);
    db.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
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

// POST /api/playlists/:id/duplicate  -> copia nome+" (copia)", pasta, orientacao,
// vigencia e todos os itens. NAO copia assignments. version reinicia.
router.post('/:id/duplicate', (req, res) => {
  const db = getDb();
  const src = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!src) return res.status(404).json({ error: 'playlist nao encontrada' });

  // acha um nome livre: "X (copia)", "X (copia 2)", ...
  const base = `${src.name} (copia)`;
  let name = base;
  for (let i = 2; ; i++) {
    const clash = db
      .prepare('SELECT 1 FROM playlists WHERE company_id = ? AND name = ?')
      .get(req.auth.companyId, name);
    if (!clash) break;
    name = `${base} ${i}`;
  }

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO playlists (company_id, name, rotation, mirror, folder_id, created_by, valid_from, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.auth.companyId, name, src.rotation, src.mirror, src.folder_id,
        req.auth.email || null, src.valid_from, src.valid_until
      );
    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration, schedule, rotation, mirror, suspended)
       SELECT ?, asset_id, ordem, duration, schedule, rotation, mirror, suspended
         FROM playlist_items WHERE playlist_id = ?`
    ).run(newId, src.id);
    db.exec('COMMIT');
    res.status(201).json({ playlist: db.prepare('SELECT * FROM playlists WHERE id = ?').get(newId) });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// POST /api/playlists/:id/items  { asset_id, duration?, ordem?, schedule?, rotation?, mirror?, suspended? }
// Video: a duracao e SEMPRE a do arquivo (ignora `duration` do body).
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

  const b = req.body || {};
  const sched = validateSchedule(b.schedule);
  if (!sched.ok) return res.status(400).json({ error: sched.error });
  const rot = parseRotation(b.rotation, { nullable: true });
  if (rot.error) return res.status(400).json({ error: rot.error });
  const mir = parseBool01(b.mirror, { nullable: true });

  let ordem = b.ordem;
  if (ordem === undefined || ordem === null) {
    const max = db
      .prepare('SELECT COALESCE(MAX(ordem), -1) AS m FROM playlist_items WHERE playlist_id = ?')
      .get(playlist.id).m;
    ordem = max + 1;
  }
  const duration =
    asset.type === 'video'
      ? (asset.duration || 10)
      : (b.duration != null ? Number(b.duration) : (asset.duration || 10));

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration, schedule, rotation, mirror, suspended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        playlist.id, assetId, ordem, duration,
        sched.value ? JSON.stringify(sched.value) : null,
        rot.skip ? null : rot.value,
        mir.skip ? null : mir.value,
        b.suspended ? 1 : 0
      );
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

// PATCH /api/playlists/:id/items/:itemId
//   { duration?, ordem?, schedule?, rotation?, mirror?, suspended? }
// schedule/rotation/mirror: null limpa (rotation/mirror -> herda da playlist).
// Video: `duration` e ignorada (a duracao e a do arquivo).
router.patch('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const item = db
    .prepare(
      `SELECT pi.*, a.type AS asset_type FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.id = ? AND pi.playlist_id = ?`
    )
    .get(Number(req.params.itemId), playlist.id);
  if (!item) return res.status(404).json({ error: 'item nao encontrado' });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.duration !== undefined && item.asset_type !== 'video') {
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
  {
    const rot = parseRotation(b.rotation, { nullable: true });
    if (rot.error) return res.status(400).json({ error: rot.error });
    if (!rot.skip) { sets.push('rotation = ?'); vals.push(rot.value); }
    const mir = parseBool01(b.mirror, { nullable: true });
    if (!mir.skip) { sets.push('mirror = ?'); vals.push(mir.value); }
  }
  if (b.suspended !== undefined) {
    sets.push('suspended = ?'); vals.push(b.suspended ? 1 : 0);
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
  const assetRows = db
    .prepare(`SELECT id, type, duration FROM assets WHERE company_id = ? AND id IN (${placeholders})`)
    .all(req.auth.companyId, ...assetIds);
  if (assetRows.length !== new Set(assetIds).size) {
    return res.status(400).json({ error: 'algum asset_id e invalido' });
  }
  const assetById = new Map(assetRows.map((a) => [a.id, a]));

  const prepared = [];
  for (const it of items) {
    const s = validateSchedule(it.schedule);
    if (!s.ok) return res.status(400).json({ error: s.error });
    const rot = parseRotation(it.rotation, { nullable: true });
    if (rot.error) return res.status(400).json({ error: rot.error });
    const mir = parseBool01(it.mirror, { nullable: true });
    const a = assetById.get(Number(it.asset_id));
    const duration =
      a.type === 'video' ? (a.duration || 10) : (it.duration != null ? Number(it.duration) : 10);
    prepared.push({
      schedule: s.value ? JSON.stringify(s.value) : null,
      rotation: rot.skip ? null : rot.value,
      mirror: mir.skip ? null : mir.value,
      suspended: it.suspended ? 1 : 0,
      duration,
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlist.id);
    const ins = db.prepare(
      `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration, schedule, rotation, mirror, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    items.forEach((it, idx) => {
      const p = prepared[idx];
      ins.run(playlist.id, Number(it.asset_id), idx, p.duration, p.schedule, p.rotation, p.mirror, p.suspended);
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
