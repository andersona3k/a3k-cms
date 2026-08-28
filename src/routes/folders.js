'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

function scoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM folders WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

// ids de todos os descendentes de folderId (inclusive) — p/ prevenir ciclo no move.
function descendantIds(db, companyId, folderId) {
  const all = db
    .prepare('SELECT id, parent_id FROM folders WHERE company_id = ?')
    .all(companyId);
  const childrenOf = new Map();
  for (const f of all) {
    if (!childrenOf.has(f.parent_id)) childrenOf.set(f.parent_id, []);
    childrenOf.get(f.parent_id).push(f.id);
  }
  const out = new Set([folderId]);
  const stack = [folderId];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of childrenOf.get(cur) || []) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

// GET /api/folders  -> lista plana com contagem de assets diretos
router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM folders  s WHERE s.parent_id = f.id) AS subfolder_count,
              (SELECT COUNT(*) FROM assets   a WHERE a.folder_id = f.id) AS asset_count
         FROM folders f
        WHERE f.company_id = ?
        ORDER BY f.parent_id IS NOT NULL, f.parent_id, f.name`
    )
    .all(req.auth.companyId);
  res.json({ folders: rows });
});

// POST /api/folders  { name, parent_id? }
router.post('/', (req, res) => {
  const db = getDb();
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });

  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId && !scoped(db, parentId, req.auth.companyId)) {
    return res.status(400).json({ error: 'parent_id invalido' });
  }

  try {
    const info = db
      .prepare('INSERT INTO folders (company_id, parent_id, name) VALUES (?, ?, ?)')
      .run(req.auth.companyId, parentId, name);
    res.status(201).json({
      folder: db.prepare('SELECT * FROM folders WHERE id = ?').get(Number(info.lastInsertRowid)),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe pasta com esse nome aqui' });
    }
    throw err;
  }
});

// PATCH /api/folders/:id  { name?, parent_id? }   (renomear / mover)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const folder = scoped(db, req.params.id, req.auth.companyId);
  if (!folder) return res.status(404).json({ error: 'pasta nao encontrada' });

  const b = req.body || {};
  let name = folder.name;
  let parentId = folder.parent_id;

  if (b.name !== undefined) {
    name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'name vazio' });
  }
  if (b.parent_id !== undefined) {
    parentId = b.parent_id ? Number(b.parent_id) : null;
    if (parentId) {
      if (!scoped(db, parentId, req.auth.companyId)) {
        return res.status(400).json({ error: 'parent_id invalido' });
      }
      if (descendantIds(db, req.auth.companyId, folder.id).has(parentId)) {
        return res.status(400).json({ error: 'nao pode mover a pasta para dentro dela mesma' });
      }
    }
  }

  try {
    db.prepare(
      `UPDATE folders SET name = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(name, parentId, folder.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe pasta com esse nome no destino' });
    }
    throw err;
  }
  res.json({ folder: scoped(db, folder.id, req.auth.companyId) });
});

// DELETE /api/folders/:id[?force=true]
// Sem force: 409 se tiver subpastas ou assets. Com force: subpastas caem em
// cascata (FK), assets ficam sem pasta (folder_id -> NULL pela FK).
router.delete('/:id', (req, res) => {
  const db = getDb();
  const folder = scoped(db, req.params.id, req.auth.companyId);
  if (!folder) return res.status(404).json({ error: 'pasta nao encontrada' });

  const subs = db.prepare('SELECT COUNT(*) n FROM folders WHERE parent_id = ?').get(folder.id).n;
  const assets = db.prepare('SELECT COUNT(*) n FROM assets WHERE folder_id = ?').get(folder.id).n;
  const force = req.query.force === 'true' || req.query.force === '1';

  if ((subs > 0 || assets > 0) && !force) {
    return res.status(409).json({
      error: 'pasta nao vazia',
      subfolder_count: subs,
      asset_count: assets,
      hint: 'repita com ?force=true',
    });
  }

  db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  res.json({ ok: true, deleted_subfolders: subs, unfiled_assets: assets });
});

module.exports = router;
