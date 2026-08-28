'use strict';

const { getDb } = require('../db');
const { isActive } = require('./schedule');

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

// Itens de uma playlist no formato do manifest (mesmo shape p/ device e preview).
// `activeAt` (Date) opcional: filtra pelo day-parting naquele instante.
function playlistManifestItems(db, playlistId, activeAt) {
  const rows = db
    .prepare(
      `SELECT pi.id, pi.ordem, pi.duration, pi.schedule,
              a.type, a.filename, a.url, a.hash, a.size_bytes, a.mime
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId);

  let items = rows.map((r) => {
    let schedule = null;
    if (r.schedule) {
      try { schedule = JSON.parse(r.schedule); } catch { schedule = null; }
    }
    return {
      id: r.id,
      type: r.type,
      url: r.url,
      filename: r.filename,
      mime: r.mime,
      duration: r.duration != null ? r.duration : 10,
      hash: r.hash ? `sha256:${r.hash}` : null,
      bytes: r.size_bytes,
      schedule,
    };
  });

  if (activeAt instanceof Date) {
    items = items.filter((it) => isActive(it.schedule, activeAt));
  }
  return items;
}

// Manifest de uma playlist isolada (usado pelo preview do admin).
function buildPlaylistManifest(playlist, activeAt) {
  const db = getDb();
  return {
    playlist: { id: playlist.id, name: playlist.name },
    version: playlist.version,
    generatedAt: new Date().toISOString(),
    items: playlistManifestItems(db, playlist.id, activeAt),
  };
}

// Monta o manifest do device — IDENTICO para todos os tipos de player.
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
  return {
    deviceId: device.id,
    serial: device.serial,
    ...buildPlaylistManifest(playlist),
  };
}

module.exports = {
  buildManifest,
  buildPlaylistManifest,
  playlistManifestItems,
  resolvePlaylistId,
};
