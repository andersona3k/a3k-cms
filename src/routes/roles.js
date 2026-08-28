'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requirePermission } = require('../auth/middleware');
const { PERMISSIONS, validatePermissions, normalizePermissions } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth, requirePermission('roles:manage'));

function scoped(db, id, companyId) {
  return db.prepare('SELECT * FROM roles WHERE id = ? AND company_id = ?').get(Number(id), companyId);
}
function shape(r) {
  return { ...r, permissions: normalizePermissions(r.permissions) };
}

// GET /api/roles  (+ vocabulario de permissoes)
router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
         FROM roles r WHERE r.company_id = ? ORDER BY r.id`
    )
    .all(req.auth.companyId);
  res.json({ roles: rows.map(shape), available_permissions: PERMISSIONS });
});

// POST /api/roles  { name, permissions }
router.post('/', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  const v = validatePermissions(req.body && req.body.permissions);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const db = getDb();
  try {
    const info = db
      .prepare('INSERT INTO roles (company_id, name, permissions) VALUES (?, ?, ?)')
      .run(req.auth.companyId, name, JSON.stringify(v.value));
    res.status(201).json({ role: shape(scoped(db, Number(info.lastInsertRowid), req.auth.companyId)) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe papel com esse nome' });
    }
    throw err;
  }
});

// PATCH /api/roles/:id  { name?, permissions? }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const role = scoped(db, req.params.id, req.auth.companyId);
  if (!role) return res.status(404).json({ error: 'papel nao encontrado' });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n) return res.status(400).json({ error: 'name vazio' });
    sets.push('name = ?'); vals.push(n);
  }
  if (b.permissions !== undefined) {
    const v = validatePermissions(b.permissions);
    if (!v.ok) return res.status(400).json({ error: v.error });
    sets.push('permissions = ?'); vals.push(JSON.stringify(v.value));
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });

  sets.push(`updated_at = datetime('now')`);
  vals.push(role.id);
  try {
    db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe papel com esse nome' });
    }
    throw err;
  }
  res.json({ role: shape(scoped(db, role.id, req.auth.companyId)) });
});

// DELETE /api/roles/:id  (bloqueia se estiver em uso)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const role = scoped(db, req.params.id, req.auth.companyId);
  if (!role) return res.status(404).json({ error: 'papel nao encontrado' });
  const inUse = db.prepare('SELECT COUNT(*) n FROM users WHERE role_id = ?').get(role.id).n;
  if (inUse > 0) {
    return res.status(409).json({ error: 'papel em uso', users: inUse });
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  res.json({ ok: true });
});

module.exports = router;
