'use strict';

// Normalizacao de video: transforma qualquer upload num MP4 que roda em
// qualquer tela (WebView de tablet/mini PC, Chrome/Edge, Tizen, webOS):
// H.264 High@4.1, 8-bit yuv420p, <=1080p, 30fps, faststart, rotacao embutida.

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

const OK_PROFILES = ['baseline', 'constrained baseline', 'main', 'high'];
const OK_PIXFMT = ['yuv420p', 'yuvj420p'];

function rotationOf(vstream) {
  if (!vstream) return 0;
  const sd = Array.isArray(vstream.side_data_list) ? vstream.side_data_list : [];
  for (const d of sd) {
    if (d.rotation != null) return ((Number(d.rotation) % 360) + 360) % 360;
  }
  const tag = vstream.tags && (vstream.tags.rotate || vstream.tags.ROTATE);
  if (tag != null) return ((Number(tag) % 360) + 360) % 360;
  return 0;
}

// rawProbe = objeto do ffprobe (-show_format -show_streams). Retorna { normalize, reason }.
function needsNormalize(rawProbe) {
  if (!rawProbe || !Array.isArray(rawProbe.streams)) {
    return { normalize: true, reason: 'sem probe utilizavel' };
  }
  const v = rawProbe.streams.find((s) => s.codec_type === 'video');
  if (!v) return { normalize: false, reason: 'sem stream de video' };

  const codec = String(v.codec_name || '').toLowerCase();
  const profile = String(v.profile || '').toLowerCase();
  const pix = String(v.pix_fmt || '').toLowerCase();
  const w = Number(v.width || 0);
  const h = Number(v.height || 0);
  const rot = rotationOf(v);

  if (codec !== 'h264') return { normalize: true, reason: `codec ${codec || '?'}` };
  if (profile && !OK_PROFILES.includes(profile)) return { normalize: true, reason: `profile ${profile}` };
  if (pix && !OK_PIXFMT.includes(pix)) return { normalize: true, reason: `pix_fmt ${pix}` };
  if (w > 1920 || h > 1920) return { normalize: true, reason: `resolucao ${w}x${h}` };
  if (rot !== 0) return { normalize: true, reason: `rotacao ${rot}` };
  return { normalize: false, reason: 'ja conforme' };
}

// Transcodifica srcAbs -> outAbs (mp4). Lanca em falha.
async function normalizeVideo(srcAbs, outAbs) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', srcAbs,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-r', '30', '-g', '60',
    '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    outAbs,
  ];
  await execFileAsync(ffmpegPath(), args, { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  const st = fs.statSync(outAbs);
  if (!st.size) throw new Error('saida vazia');
}

module.exports = { needsNormalize, normalizeVideo, rotationOf, ffmpegPath: ffmpegPath() };
