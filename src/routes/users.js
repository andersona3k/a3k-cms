'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requirePermission } = require('../auth/middleware');
const { hashPassword } = require('../auth/password');

const router = express.Router();
router.use(requireAuth, requirePermission('users:manage'));

function scoped(db, id, companyId) {
  return db
    .prepare(
      `SELECT u.id, u.company_id, u.role_id, u.email, u.name, u.active, u.is_superadmin,
              u.last_login, u.created_at, r.name AS role_name
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ? AND u.company_id = ?`
    )
    .get(Number(id), companyId);
}

// GET /api/users
router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.company_id, u.role_id, u.email, u.name, u.active, u.is_superadmin,
              u.last_login, u.created_at, r.name AS role_name
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = ? ORDER BY u.id`
    )
    .all(req.auth.companyId);
  res.json({ users: rows.map((u) => ({ ...u, is_superadmin: !!u.is_superadmin })) });
});

// POST /api/users  { email, password, name?, role_id? }
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const email = String(b.email || '').toLowerCase().trim();
  if (!email || !b.password) return res.status(400).json({ error: 'email e password obrigatorios' });
  if (String(b.password).length < 6) return res.status(400).json({ error: 'senha muito curta (min 6)' });

  let roleId = null;
  if (b.role_id) {
    roleId = Number(b.role_id);
    const r = db.prepare('SELECT id FROM roles WHERE id = ? AND company_id = ?').get(roleId, req.auth.companyId);
    if (!r) return res.status(400).json({ error: 'role_id invalido' });
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO users (company_id, role_id, email, password_hash, name, active)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(req.auth.companyId, roleId, email, hashPassword(String(b.password)), b.name || null);
    res.status(201).json({ user: scoped(db, Number(info.lastInsertRowid), req.auth.companyId) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'email ja existe nesta empresa' });
    }
    throw err;
  }
});

// PATCH /api/users/:id  { name?, active?, role_id? }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const user = scoped(db, req.params.id, req.auth.companyId);
  if (!user) return res.status(404).json({ error: 'usuario nao encontrado' });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(b.name); }
  if (b.active !== undefined) {
    if (user.id === req.auth.userId && !b.active) {
      return res.status(400).json({ error: 'nao pode desativar a si mesmo' });
    }
    sets.push('active = ?'); vals.push(b.active ? 1 : 0);
  }
  if (b.role_id !== undefined) {
    let roleId = b.role_id ? Number(b.role_id) : null;
    if (roleId) {
      const r = db.prepare('SELECT id FROM roles WHERE id = ? AND company_id = ?').get(roleId, req.auth.companyId);
      if (!r) return res.status(400).json({ error: 'role_id invalido' });
    }
    sets.push('role_id = ?'); vals.push(roleId);
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });

  sets.push(`updated_at = datetime('now')`);
  vals.push(user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ user: scoped(db, user.id, req.auth.companyId) });
});

// POST /api/users/:id/password  { password }
router.post('/:id/password', (req, res) => {
  const db = getDb();
  const user = scoped(db, req.params.id, req.auth.companyId);
  if (!user) return res.status(404).json({ error: 'usuario nao encontrado' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'senha muito curta (min 6)' });
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(pw), user.id);
  res.json({ ok: true });
});

module.exports = router;
