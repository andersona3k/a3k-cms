'use strict';

// Extracao de metadados de midia.
//  - imagem  -> sharp(...).metadata()
//  - video   -> ffprobe (-show_format -show_streams), le o stream de video
//  - audio   -> ffprobe, le o stream de audio
//  - outros  -> skipped
//
// Nunca lanca: em falha devolve { status: 'error', error } e o upload segue.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function resolveFfprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    return require('@ffprobe-installer/ffprobe').path;
  } catch {
    return 'ffprobe'; // tenta o PATH do sistema
  }
}
const FFPROBE = resolveFfprobePath();

// "30000/1001" | "25/1" | "0/0" -> number | null
function parseFrameRate(str) {
  if (!str || typeof str !== 'string' || !str.includes('/')) return null;
  const [num, den] = str.split('/').map(Number);
  if (!den || !isFinite(num) || !isFinite(den)) return null;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Normaliza a saida crua do ffprobe (objeto ja parseado) num shape comum.
function normalizeFfprobe(probe, kind) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const fmt = probe.format || {};
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const main = kind === 'audio' ? a : v || a;

  const out = {
    width: v ? toInt(v.width) : null,
    height: v ? toInt(v.height) : null,
    duration: toNum(fmt.duration) || (main ? toNum(main.duration) : null),
    fps: v ? parseFrameRate(v.avg_frame_rate) || parseFrameRate(v.r_frame_rate) : null,
    bitrate: toInt(fmt.bit_rate) || (main ? toInt(main.bit_rate) : null),
    codec: main ? main.codec_name || null : null,
    format: fmt.format_name || null,
  };
  return out;
}

async function probeWithFfprobe(filePath, kind) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  const { stdout } = await execFileAsync(FFPROBE, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  });
  const raw = JSON.parse(stdout);
  return { fields: normalizeFfprobe(raw, kind), raw };
}

async function probeImage(filePath) {
  const sharp = require('sharp');
  const m = await sharp(filePath, { failOn: 'none' }).metadata();
  return {
    fields: {
      width: m.width || null,
      height: m.height || null,
      duration: null,
      fps: null,
      bitrate: null,
      codec: null,
      format: m.format || null,
    },
    raw: m,
  };
}

// type: 'image' | 'video' | 'audio' | 'html' | 'other'
async function probeAsset(filePath, type) {
  if (type !== 'image' && type !== 'video' && type !== 'audio') {
    return { status: 'skipped', fields: {}, raw: null, error: null };
  }
  try {
    const { fields, raw } =
      type === 'image'
        ? await probeImage(filePath)
        : await probeWithFfprobe(filePath, type);
    return { status: 'ok', fields, raw, error: null };
  } catch (err) {
    return { status: 'error', fields: {}, raw: null, error: String(err.message || err) };
  }
}

module.exports = { probeAsset, normalizeFfprobe, parseFrameRate, FFPROBE_PATH: FFPROBE };
