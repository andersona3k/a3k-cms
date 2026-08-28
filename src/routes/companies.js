'use strict';

// Gestao de empresas — somente superadmin (operador da plataforma).

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireSuperadmin } = require('../auth/middleware');
const { hashPassword } = require('../auth/password');

const router = express.Router();
router.use(requireAuth, requireSuperadmin);

function meta(db) {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS user_count,
              (SELECT COUNT(*) FROM devices d WHERE d.company_id = c.id) AS device_count
         FROM companies c ORDER BY c.id`
    )
    .all();
}

// GET /api/companies
router.get('/', (req, res) => {
  res.json({ companies: meta(getDb()) });
});

// POST /api/companies  { name, admin?: { email, password, name? } }
router.post('/', (req, res) => {
  const db = getDb();
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  const admin = req.body && req.body.admin;

  db.exec('BEGIN');
  try {
    const cInfo = db.prepare('INSERT INTO companies (name) VALUES (?)').run(name);
    const companyId = Number(cInfo.lastInsertRowid);

    const rInfo = db
      .prepare(`INSERT INTO roles (company_id, name, permissions) VALUES (?, 'admin', '{"*":true}')`)
      .run(companyId);
    const adminRoleId = Number(rInfo.lastInsertRowid);

    let adminUser = null;
    if (admin && admin.email && admin.password) {
      const uInfo = db
        .prepare(
          `INSERT INTO users (company_id, role_id, email, password_hash, name, active)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run(companyId, adminRoleId, String(admin.email).toLowerCase(), hashPassword(admin.password), admin.name || null);
      adminUser = { id: Number(uInfo.lastInsertRowid), email: String(admin.email).toLowerCase() };
    }

    db.exec('COMMIT');
    res.status(201).json({
      company: db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId),
      admin_role_id: adminRoleId,
      admin_user: adminUser,
    });
  } catch (err) {
    db.exec('ROLLBACK');
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'email de admin ja existe' });
    }
    throw err;
  }
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const c = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'empresa nao encontrada' });
  res.json({ company: c });
});

// PATCH /api/companies/:id  { name }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'empresa nao encontrada' });
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name vazio' });
  db.prepare(`UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, c.id);
  res.json({ company: db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id) });
});

module.exports = router;
