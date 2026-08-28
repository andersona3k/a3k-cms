'use strict';

const express = require('express');
const { getDb } = require('../db');
const { verifyPassword } = require('./password');
const { signToken } = require('./jwt');
const { requireAuth } = require('./middleware');

const router = express.Router();

// POST /api/auth/login  { email, password } -> { token, user }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email e password sao obrigatorios' });
  }

  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, company_id, role_id, email, password_hash, name, active
         FROM users WHERE email = ?`
    )
    .get(String(email).toLowerCase());

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'credenciais invalidas' });
  }

  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

  const token = signToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      company_id: user.company_id,
      role_id: user.role_id,
    },
  });
});

// GET /api/auth/me -> usuario autenticado
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.auth });
});

module.exports = router;
