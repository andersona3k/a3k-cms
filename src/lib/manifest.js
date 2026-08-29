'use strict';

const { getDb } = require('../db');
const { isActive } = require('./schedule');
const { groupRuleAllows } = require('./groupRule');

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
// `target` ({groupId,deviceId}) opcional: quando passado, aplica a regra de
// "Reprodução" (Sim/Não) do item — preview do admin passa undefined (mostra tudo).
function playlistManifestItems(db, playlistId, activeAt, target) {
  // itens suspensos nunca entram no manifest.
  const rows = db
    .prepare(
      `SELECT pi.id, pi.ordem, pi.duration, pi.schedule, pi.rotation, pi.mirror, pi.group_rule,
              a.type, a.filename, a.url, a.hash, a.size_bytes, a.mime, a.schedule AS asset_schedule
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ? AND pi.suspended = 0
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId);

  let items = rows.map((r) => {
    // condicional: item (personalizada) sobrepoe; senao herda a do arquivo (biblioteca)
    let schedule = null;
    if (r.schedule) { try { schedule = JSON.parse(r.schedule); } catch { schedule = null; } }
    if (!schedule && r.asset_schedule) { try { schedule = JSON.parse(r.asset_schedule); } catch { schedule = null; } }
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
      // NULL = herda a orientacao da playlist
      rotation: r.rotation,
      mirror: r.mirror,
      _groupRule: r.group_rule,
    };
  });

  if (target !== undefined) {
    items = items.filter((it) => groupRuleAllows(it._groupRule, target));
  }
  items.forEach((it) => { delete it._groupRule; });

  if (activeAt instanceof Date) {
    items = items.filter((it) => isActive(it.schedule, activeAt));
  }
  return items;
}

// Manifest de uma playlist isolada (usado pelo preview do admin).
// `target` ({groupId,deviceId}) passado so no manifest de device -> aplica a
// regra de "Reprodução" por item.
function buildPlaylistManifest(playlist, activeAt, target) {
  const db = getDb();
  return {
    playlist: { id: playlist.id, name: playlist.name },
    version: playlist.version,
    rotation: playlist.rotation || 0,
    mirror: playlist.mirror ? 1 : 0,
    suspended: playlist.suspended ? 1 : 0,
    generatedAt: new Date().toISOString(),
    // playlist suspensa -> nao entrega nada (o player fica em "nada programado")
    items: playlist.suspended ? [] : playlistManifestItems(db, playlist.id, activeAt, target),
  };
}

// Monta o manifest do device — IDENTICO para todos os tipos de player.
function buildManifest(device) {
  const db = getDb();
  const playlistId = resolvePlaylistId(db, device);
  const deviceRotation = [0, 90, 180, 270].includes(device.orientation) ? device.orientation : 0;

  if (!playlistId) {
    return {
      deviceId: device.id,
      serial: device.serial,
      playlist: null,
      version: 0,
      rotation: 0,
      mirror: 0,
      deviceRotation,
      generatedAt: new Date().toISOString(),
      items: [],
    };
  }

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  return {
    deviceId: device.id,
    serial: device.serial,
    deviceRotation,
    ...buildPlaylistManifest(playlist, undefined, {
      groupId: device.group_id || null,
      deviceId: device.id,
    }),
  };
}

module.exports = {
  buildManifest,
  buildPlaylistManifest,
  playlistManifestItems,
  resolvePlaylistId,
};
