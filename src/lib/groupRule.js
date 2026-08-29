'use strict';

// Regra de "Reprodução" de um item de playlist. Dois lados mutuamente exclusivos:
//   SIM  (allow) -> SO quem está aqui exibe este item
//   NÃO  (deny)  -> quem está aqui NÃO exibe este item (mas toca o resto da playlist)
// Cada lado carrega grupos e/ou players (devices) individuais.
//
//   null                                              -> todos exibem (sem filtro)
//   { allow: { groups: [ids], devices: [ids] },
//     deny:  { groups: [ids], devices: [ids] } }
//
// Aceita também o formato antigo { mode: 'allow'|'deny', groups: [...] }.

function ints(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

function normSide(side) {
  const s = side && typeof side === 'object' && !Array.isArray(side) ? side : {};
  return { groups: ints(s.groups), devices: ints(s.devices) };
}

function sideEmpty(s) {
  return !s.groups.length && !s.devices.length;
}

// Devolve { allow, deny } normalizado, null (sem regra) ou undefined (inválido).
function coerce(input) {
  let s = input;
  if (s === undefined || s === null || s === '') return null;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return undefined; }
  }
  if (s === null) return null;
  if (typeof s !== 'object' || Array.isArray(s)) return undefined;

  let allow;
  let deny;
  if (s.allow !== undefined || s.deny !== undefined) {
    allow = normSide(s.allow);
    deny = normSide(s.deny);
  } else if (s.mode === 'allow' || s.mode === 'deny') {
    const g = ints(s.groups);
    allow = { groups: s.mode === 'allow' ? g : [], devices: [] };
    deny = { groups: s.mode === 'deny' ? g : [], devices: [] };
  } else {
    return undefined;
  }

  // exclusividade: um id nos dois lados -> o NÃO vence
  allow.groups = allow.groups.filter((id) => deny.groups.indexOf(id) < 0);
  allow.devices = allow.devices.filter((id) => deny.devices.indexOf(id) < 0);

  if (sideEmpty(allow) && sideEmpty(deny)) return null;
  return { allow, deny };
}

function validateGroupRule(input) {
  const v = coerce(input);
  if (v === undefined) return { ok: false, error: 'group_rule invalido' };
  return { ok: true, value: v };
}

// O item deve entrar no manifest deste device?
// `ctx` = { groupId, deviceId } (ambos podem ser null). Aceita um número solto
// (groupId) por retrocompatibilidade.
function groupRuleAllows(rule, ctx) {
  const v = coerce(rule);
  if (!v) return true; // null / inválido -> não filtra

  let groupId = null;
  let deviceId = null;
  if (ctx !== null && typeof ctx === 'object') {
    groupId = ctx.groupId != null ? Number(ctx.groupId) : null;
    deviceId = ctx.deviceId != null ? Number(ctx.deviceId) : null;
  } else if (ctx != null) {
    groupId = Number(ctx);
  }

  const inSide = (side) =>
    (deviceId != null && side.devices.indexOf(deviceId) >= 0) ||
    (groupId != null && side.groups.indexOf(groupId) >= 0);

  if (inSide(v.deny)) return false;
  if (!sideEmpty(v.allow)) return inSide(v.allow);
  return true;
}

module.exports = { validateGroupRule, groupRuleAllows };
