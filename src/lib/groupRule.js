'use strict';

// Regra de grupo de um item de playlist (bloco "Reprodução").
//   null                              -> todos os grupos exibem
//   { mode: 'allow', groups: [ids] }  -> SO esses grupos exibem
//   { mode: 'deny',  groups: [ids] }  -> esses grupos pulam; os demais exibem

function validateGroupRule(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  let s = input;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return { ok: false, error: 'group_rule: JSON invalido' }; }
  }
  if (s === null) return { ok: true, value: null };
  if (typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, error: 'group_rule deve ser objeto ou null' };
  }
  const mode = s.mode === 'deny' ? 'deny' : s.mode === 'allow' ? 'allow' : null;
  if (!mode) return { ok: false, error: 'group_rule.mode deve ser "allow" ou "deny"' };
  const groups = [...new Set((Array.isArray(s.groups) ? s.groups : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (!groups.length) return { ok: true, value: null }; // sem grupos = sem regra
  return { ok: true, value: { mode, groups } };
}

// O item deve entrar no manifest de um device cujo grupo e `groupId` (pode ser null)?
function groupRuleAllows(rule, groupId) {
  let r = rule;
  if (r == null) return true;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return true; } }
  if (!r || !r.mode || !Array.isArray(r.groups) || !r.groups.length) return true;
  const inList = groupId != null && r.groups.indexOf(Number(groupId)) >= 0;
  return r.mode === 'allow' ? inList : !inList;
}

module.exports = { validateGroupRule, groupRuleAllows };
