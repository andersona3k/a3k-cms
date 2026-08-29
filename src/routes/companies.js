'use strict';

// Gestao de empresas — somente superadmin (operador da plataforma).

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireSuperadmin } = require('../auth/middleware');
const { hashPassword } = require('../auth/password');
const { MODULES, normalizeModules } = require('../lib/modules');
const { upload } = require('../lib/media');
const config = require('../config');

const router = express.Router();
router.use(requireAuth, requireSuperadmin);

function shape(c) {
  return { ...c, modules: normalizeModules(c.modules) };
}

function meta(db) {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS user_count,
              (SELECT COUNT(*) FROM devices d WHERE d.company_id = c.id) AS device_count
         FROM companies c ORDER BY c.id`
    )
    .all()
    .map(shape);
}

// GET /api/companies
router.get('/', (req, res) => {
  res.json({ companies: meta(getDb()), all_modules: MODULES });
});

// POST /api/companies  { name, modules?: [...], admin?: { email, password, name? } }
router.post('/', (req, res) => {
  const db = getDb();
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  const admin = req.body && req.body.admin;
  const modules = normalizeModules(req.body && req.body.modules);

  db.exec('BEGIN');
  try {
    const cInfo = db
      .prepare('INSERT INTO companies (name, modules) VALUES (?, ?)')
      .run(name, JSON.stringify(modules));
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
      company: shape(db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId)),
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
  res.json({ company: shape(c) });
});

// PATCH /api/companies/:id  { name?, modules? }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'empresa nao encontrada' });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'name vazio' });
    sets.push('name = ?'); vals.push(name);
  }
  if (b.modules !== undefined) {
    sets.push('modules = ?'); vals.push(JSON.stringify(normalizeModules(b.modules)));
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
  sets.push(`updated_at = datetime('now')`);
  vals.push(c.id);
  db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ company: shape(db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id)) });
});

// POST /api/companies/:id/logo   (multipart: "file")
router.post('/:id/logo', upload.single('file'), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!c) { if (req.file) fs.rmSync(req.file.path, { force: true }); return res.status(404).json({ error: 'empresa nao encontrada' }); }
  if (!req.file) return res.status(400).json({ error: 'campo "file" ausente' });
  if (!String(req.file.mimetype || '').startsWith('image/')) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'a logo precisa ser uma imagem' });
  }

  const ext = (path.extname(req.file.originalname || '') || '.png').toLowerCase();
  // apaga qualquer logo anterior desta empresa (extensao pode mudar)
  for (const f of fs.readdirSync(config.mediaDir)) {
    if (f.startsWith(`logo-c${c.id}.`)) fs.rmSync(path.join(config.mediaDir, f), { force: true });
  }
  const stored = `logo-c${c.id}${ext}`;
  fs.renameSync(req.file.path, path.join(config.mediaDir, stored));
  const url = `/assets/${stored}`;
  db.prepare(`UPDATE companies SET logo_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, c.id);
  res.json({ company: shape(db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id)) });
});

// DELETE /api/companies/:id/logo
router.delete('/:id/logo', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'empresa nao encontrada' });
  for (const f of fs.readdirSync(config.mediaDir)) {
    if (f.startsWith(`logo-c${c.id}.`)) fs.rmSync(path.join(config.mediaDir, f), { force: true });
  }
  db.prepare(`UPDATE companies SET logo_url = NULL, updated_at = datetime('now') WHERE id = ?`).run(c.id);
  res.json({ company: shape(db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id)) });
});

module.exports = router;
