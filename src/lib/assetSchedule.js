'use strict';

// Condicionais de um asset (bloco "Condicionais" do visualizador).
// Shape:
//   null  -> sem condicao
//   {
//     from:  "YYYY-MM-DDTHH:MM",  // validade inicio (data+hora), opcional
//     until: "YYYY-MM-DDTHH:MM",  // validade fim (data+hora), opcional
//     days:  [1..7],              // ISO 1=segunda..7=domingo; vazio/ausente = todos
//     start: "HH:MM",             // horario diario inicio (24h), opcional
//     end:   "HH:MM"              // horario diario fim (24h), opcional
//   }
//
// Diferente de src/lib/schedule.js (day-parting de playlist_item): aqui `from`/
// `until` carregam hora. Por enquanto e so armazenado/exibido, nao filtra o player.

const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateAssetSchedule(input) {
  if (input === undefined || input === null) return { ok: true, value: null };
  let s = input;
  if (typeof s === 'string') {
    if (s.trim() === '') return { ok: true, value: null };
    try { s = JSON.parse(s); } catch { return { ok: false, error: 'condicionais: JSON invalido' }; }
  }
  if (s === null) return { ok: true, value: null };
  if (typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, error: 'condicionais devem ser objeto ou null' };
  }

  const out = {};

  for (const k of ['from', 'until']) {
    if (s[k] != null && s[k] !== '') {
      const v = String(s[k]).slice(0, 16); // corta segundos se vierem
      if (!DT_RE.test(v)) return { ok: false, error: `${k}: use data e hora (YYYY-MM-DDTHH:MM)` };
      out[k] = v;
    }
  }
  if (out.from && out.until && out.from > out.until) {
    return { ok: false, error: 'validade: inicio depois do fim' };
  }

  if (s.days != null) {
    if (!Array.isArray(s.days)) return { ok: false, error: 'days deve ser array' };
    const days = [...new Set(s.days.map(Number))].sort((a, b) => a - b);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { ok: false, error: 'days: use 1..7 (ISO, 1=segunda)' };
    }
    if (days.length > 0 && days.length < 7) out.days = days;
  }

  for (const k of ['start', 'end']) {
    if (s[k] != null && s[k] !== '') {
      const v = String(s[k]);
      if (!TIME_RE.test(v)) return { ok: false, error: `${k}: use HH:MM em 24h` };
      out[k] = v;
    }
  }
  if (out.start && out.end && out.start === out.end) {
    return { ok: false, error: 'horario: inicio e fim iguais' };
  }

  return { ok: true, value: Object.keys(out).length ? out : null };
}

module.exports = { validateAssetSchedule };
