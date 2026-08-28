'use strict';

// Vocabulario de permissoes. Um role guarda `permissions` como JSON:
//   { "*": true }                      -> tudo
//   { "playlists:write": true, ... }   -> lista explicita
// Leitura (GET) exige apenas estar autenticado; as chaves abaixo protegem
// mutacoes (writeGuard) e areas administrativas.

const PERMISSIONS = [
  'assets:write',
  'folders:write',
  'playlists:write',
  'devices:write',
  'groups:write',
  'pairing:manage',
  'users:manage',
  'roles:manage',
];

// Normaliza qualquer forma aceita para um objeto { chave: true }.
function normalizePermissions(input) {
  if (input == null) return {};
  let val = input;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch { return {}; }
  }
  if (Array.isArray(val)) {
    const out = {};
    for (const k of val) out[String(k)] = true;
    return out;
  }
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) if (v) out[k] = true;
    return out;
  }
  return {};
}

// true se `perms` concede `perm` (ou o curinga *).
function grants(perms, perm) {
  const p = normalizePermissions(perms);
  return p['*'] === true || p[perm] === true;
}

// valida as chaves de um permissions vindo da API de roles.
function validatePermissions(input) {
  const p = normalizePermissions(input);
  if (p['*']) return { ok: true, value: { '*': true } };
  const bad = Object.keys(p).filter((k) => !PERMISSIONS.includes(k));
  if (bad.length) return { ok: false, error: `permissoes desconhecidas: ${bad.join(', ')}` };
  return { ok: true, value: p };
}

module.exports = { PERMISSIONS, normalizePermissions, grants, validatePermissions };
