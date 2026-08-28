'use strict';

const { getDb } = require('../db');

// Resolve qual playlist um device deve tocar.
// M1: apenas assignment direto no device. Heranca de grupo entra no M4.
function resolvePlaylistId(db, device) {
  const direct = db
    .prepare(
      `SELECT playlist_id FROM assignments
        WHERE company_id = ? AND target_type = 'device' AND target_id = ?`
    )
    .get(device.company_id, device.id);
  if (direct) return direct.playlist_id;

  if (device.group_id) {
    const grp = db
      .prepare(
        `SELECT playlist_id FROM assignments
          WHERE company_id = ? AND target_type = 'group' AND target_id = ?`
      )
      .get(device.company_id, device.group_id);
    if (grp) return grp.playlist_id;
  }
  return null;
}

// Monta o manifest — IDENTICO para todos os tipos de player.
function buildManifest(device) {
  const db = getDb();
  const playlistId = resolvePlaylistId(db, device);

  if (!playlistId) {
    return {
      deviceId: device.id,
      serial: device.serial,
      playlist: null,
      version: 0,
      generatedAt: new Date().toISOString(),
      items: [],
    };
  }

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  const rows = db
    .prepare(
      `SELECT pi.id, pi.ordem, pi.duration,
              a.type, a.filename, a.url, a.hash, a.size_bytes, a.mime
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId);

  return {
    deviceId: device.id,
    serial: device.serial,
    playlist: { id: playlist.id, name: playlist.name },
    version: playlist.version,
    generatedAt: new Date().toISOString(),
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      url: r.url,
      filename: r.filename,
      mime: r.mime,
      duration: r.duration != null ? r.duration : 10,
      hash: r.hash ? `sha256:${r.hash}` : null,
      bytes: r.size_bytes,
    })),
  };
}

module.exports = { buildManifest, resolvePlaylistId };
