'use strict';

const { verifyToken } = require('./jwt');
const { getDb } = require('../db');
const { normalizePermissions, grants } = require('../lib/permissions');

// Extrai o Bearer token, valida, e carrega o usuario + role em req.auth.
// Superadmin pode atuar em outra empresa via header X-Company-Id (ou ?company_id).
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
      `SELECT u.id, u.company_id, u.role_id, u.email, u.name, u.active, u.is_superadmin,
              r.name AS role_name, r.permissions AS role_permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?`
    )
    .get(claims.sub);

  if (!user || !user.active) {
    return res.status(401).json({ error: 'usuario inativo ou inexistente' });
  }

  const isSuperadmin = !!user.is_superadmin;
  const permissions = normalizePermissions(user.role_permissions);

  // contexto de empresa: por padrao a do usuario; superadmin pode trocar.
  let companyId = user.company_id;
  if (isSuperadmin) {
    const override = req.get('x-company-id') || req.query.company_id;
    if (override != null && override !== '') {
      const c = db.prepare('SELECT id FROM companies WHERE id = ?').get(Number(override));
      if (!c) return res.status(400).json({ error: 'X-Company-Id invalido' });
      companyId = c.id;
    }
  }

  req.auth = {
    userId: user.id,
    companyId,
    homeCompanyId: user.company_id,
    roleId: user.role_id,
    roleName: user.role_name,
    email: user.email,
    name: user.name,
    isSuperadmin,
    permissions,
  };
  next();
}

// Exige uma permissao nomeada (superadmin e curinga * passam sempre).
function requirePermission(perm) {
  return function (req, res, next) {
    if (req.auth && (req.auth.isSuperadmin || grants(req.auth.permissions, perm))) {
      return next();
    }
    return res.status(403).json({ error: `sem permissao: ${perm}` });
  };
}

// Libera GET/HEAD; qualquer mutacao exige a permissao dada.
function writeGuard(perm) {
  return function (req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    return requirePermission(perm)(req, res, next);
  };
}

// Rota so para superadmin (gestao de empresas).
function requireSuperadmin(req, res, next) {
  if (req.auth && req.auth.isSuperadmin) return next();
  return res.status(403).json({ error: 'exige superadmin' });
}

module.exports = { requireAuth, requirePermission, writeGuard, requireSuperadmin };
