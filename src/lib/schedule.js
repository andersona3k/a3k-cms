'use strict';

// Day-parting de um item de playlist.
//
//   schedule = null                      -> sempre no ar
//   schedule = {
//     days:  [1..7],        // ISO: 1=segunda .. 7=domingo. Ausente/vazio = todos.
//     start: "HH:MM",       // hora local. Ausente = 00:00.
//     end:   "HH:MM",       // hora local. Ausente = 24:00. start > end = janela vira a meia-noite.
//     from:  "YYYY-MM-DD",  // primeira data (inclusive), opcional
//     until: "YYYY-MM-DD"   // ultima data (inclusive), opcional
//   }
//
// Numa janela que vira a meia-noite (ex: 22:00-06:00), `days` se refere ao dia
// em que a janela COMECA.

const TIME_RE = /^(\d{1,2}):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toMinutes(hhmm) {
  const m = TIME_RE.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}
function fmt(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function localYmd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// JS getDay(): 0=domingo..6=sabado  ->  ISO: 1=segunda..7=domingo
function isoDay(d) { return ((d.getDay() + 6) % 7) + 1; }

// Valida/normaliza. Retorna { ok, value } (value pode ser null) ou { ok:false, error }.
function validateSchedule(input) {
  if (input === undefined || input === null) return { ok: true, value: null };
  let s = input;
  if (typeof s === 'string') {
    if (s.trim() === '') return { ok: true, value: null };
    try { s = JSON.parse(s); } catch { return { ok: false, error: 'schedule: JSON invalido' }; }
  }
  if (s === null) return { ok: true, value: null };
  if (typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, error: 'schedule deve ser um objeto ou null' };
  }

  const out = {};

  if (s.days != null) {
    if (!Array.isArray(s.days)) return { ok: false, error: 'days deve ser array' };
    const days = [...new Set(s.days.map(Number))].sort((a, b) => a - b);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { ok: false, error: 'days: use 1..7 (ISO, 1=segunda)' };
    }
    if (days.length > 0 && days.length < 7) out.days = days;
  }

  let startMin = 0;
  if (s.start != null && s.start !== '') {
    startMin = toMinutes(s.start);
    if (startMin == null) return { ok: false, error: 'start invalido (HH:MM)' };
  }
  let endMin = 24 * 60;
  if (s.end != null && s.end !== '') {
    endMin = toMinutes(s.end);
    if (endMin == null) return { ok: false, error: 'end invalido (HH:MM)' };
    if (endMin === 0) endMin = 24 * 60; // "00:00" como fim = fim do dia
  }
  if (startMin === endMin) {
    return { ok: false, error: 'start e end nao podem ser iguais' };
  }
  if (startMin !== 0) out.start = fmt(startMin);
  if (endMin !== 24 * 60) out.end = fmt(endMin);

  for (const k of ['from', 'until']) {
    if (s[k] != null && s[k] !== '') {
      if (!DATE_RE.test(String(s[k]))) return { ok: false, error: `${k} invalido (YYYY-MM-DD)` };
      out[k] = String(s[k]);
    }
  }
  if (out.from && out.until && out.from > out.until) {
    return { ok: false, error: 'from depois de until' };
  }

  return { ok: true, value: Object.keys(out).length ? out : null };
}

// true se o item deve estar no ar em `date` (default: agora, relogio local).
function isActive(schedule, date) {
  let s = schedule;
  if (s == null) return true;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return true; }
    if (s == null) return true;
  }

  const d = date || new Date();
  const ymd = localYmd(d);
  if (s.from && ymd < s.from) return false;
  if (s.until && ymd > s.until) return false;

  const startMin = s.start ? toMinutes(s.start) : 0;
  let endMin = s.end ? toMinutes(s.end) : 24 * 60;
  if (endMin === 0) endMin = 24 * 60;
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const days = Array.isArray(s.days) && s.days.length ? s.days : null;
  const today = isoDay(d);
  const yesterday = ((today + 5) % 7) + 1;

  if (startMin <= endMin) {
    const inWindow = nowMin >= startMin && nowMin < endMin;
    return inWindow && (!days || days.includes(today));
  }
  // janela que vira a meia-noite
  if (nowMin >= startMin) return !days || days.includes(today);
  if (nowMin < endMin) return !days || days.includes(yesterday);
  return false;
}

module.exports = { validateSchedule, isActive, toMinutes, isoDay };
