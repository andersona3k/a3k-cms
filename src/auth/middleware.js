'use strict';

const { verifyToken } = require('./jwt');
const { getDb } = require('../db');

// Extrai o Bearer token, valida, e carrega o usuario + role em req.auth.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'token ausente' });
  }

  let claims;
  try {
    claims = verifyToken(match[1]);
  } catch {
    return res.status(401).json({ error: 'token invalido ou expirado' });
  }

  const db = getDb();
  const user = db
    .prepare(
      `SELECT u.id, u.company_id, u.role_id, u.email, u.name, u.active,
              r.name AS role_name, r.permissions AS role_permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?`
    )
    .get(claims.sub);

  if (!user || !user.active) {
    return res.status(401).json({ error: 'usuario inativo ou inexistente' });
  }

  let permissions = {};
  try {
    permissions = JSON.parse(user.role_permissions || '{}');
  } catch {
    permissions = {};
  }

  req.auth = {
    userId: user.id,
    companyId: user.company_id,
    roleId: user.role_id,
    roleName: user.role_name,
    email: user.email,
    name: user.name,
    permissions,
  };
  next();
}

// Enforcement minimo do M0: admin = permissions {"*": true} ou permissao nomeada.
function requirePermission(perm) {
  return function (req, res, next) {
    const p = req.auth && req.auth.permissions;
    if (p && (p['*'] === true || p[perm] === true || (Array.isArray(p) && p.includes(perm)))) {
      return next();
    }
    return res.status(403).json({ error: `sem permissao: ${perm}` });
  };
}

module.exports = { requireAuth, requirePermission };
