'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const SHOT_DIR = path.join(config.mediaDir, 'screenshots');
const SHOT_KEEP_DAYS = 7;
const COMM_KEEP_DAYS = 30;
const CMD_TYPES = ['ping', 'restart', 'clear_cache', 'unassign_playlist', 'screenshot'];
const SHOT_INTERVALS = [1, 5, 10, 30, 60];

function pruneScreenshots(db, deviceId) {
  const old = db
    .prepare(
      `SELECT url FROM device_screenshots
        WHERE device_id = ? AND taken_at < datetime('now', ?)`
    )
    .all(deviceId, `-${SHOT_KEEP_DAYS} days`);
  for (const r of old) {
    try { fs.unlinkSync(path.join(SHOT_DIR, path.basename(r.url))); } catch {}
  }
  db.prepare(
    `DELETE FROM device_screenshots WHERE device_id = ? AND taken_at < datetime('now', ?)`
  ).run(deviceId, `-${SHOT_KEEP_DAYS} days`);
}

function pruneCommLog(db, deviceId) {
  db.prepare(
    `DELETE FROM device_comm_log WHERE device_id = ? AND at < datetime('now', ?)`
  ).run(deviceId, `-${COMM_KEEP_DAYS} days`);
}

function pendingCommands(db, deviceId) {
  return db
    .prepare(
      `SELECT id, type, params FROM device_commands
        WHERE device_id = ? AND status = 'pending' ORDER BY id`
    )
    .all(deviceId)
    .map((c) => ({ id: c.id, type: c.type, params: c.params ? safeJson(c.params) : null }));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
  SHOT_DIR, SHOT_KEEP_DAYS, COMM_KEEP_DAYS, CMD_TYPES, SHOT_INTERVALS,
  pruneScreenshots, pruneCommLog, pendingCommands,
};
