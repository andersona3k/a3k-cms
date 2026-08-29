'use strict';

// Modulos que uma empresa pode ter liberados.
//   digital     -> CMS de digital signage (biblioteca / playlists / dispositivos) — o que existe hoje
//   logistica   -> (a construir)
//   experience  -> (a construir)
const MODULES = ['digital', 'logistica', 'experience'];

// normaliza uma lista de modulos (string JSON ou array) -> array valido e unico.
// vazio/invalido -> ['digital'] (todo cliente tem digital por padrao).
function normalizeModules(input) {
  let arr = input;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = null; }
  }
  if (!Array.isArray(arr)) arr = [];
  const out = MODULES.filter((m) => arr.includes(m));
  return out.length ? out : ['digital'];
}

module.exports = { MODULES, normalizeModules };
