'use strict';

// Registry de adapters de player. player_type gravado no device escolhe o driver.
// O manifest NAO passa por aqui — e identico para todos (garante agnosticidade).

const { BasePlayerAdapter } = require('./base');
const { TizenAdapter } = require('./tizen');
const { WebosAdapter } = require('./webos');
const { AndroidAdapter } = require('./android');
const { WindowsAdapter } = require('./windows');

const ADAPTERS = {
  [TizenAdapter.type]: TizenAdapter,
  [WebosAdapter.type]: WebosAdapter,
  [AndroidAdapter.type]: AndroidAdapter,
  [WindowsAdapter.type]: WindowsAdapter,
};

const PLAYER_TYPES = Object.keys(ADAPTERS);

function getAdapter(playerType) {
  return ADAPTERS[playerType] || BasePlayerAdapter;
}

function listAdapters() {
  return PLAYER_TYPES.map((type) => ({
    type,
    label: ADAPTERS[type].label,
    provisioning: ADAPTERS[type].provisioning(),
    capabilities: ADAPTERS[type].capabilities(),
  }));
}

module.exports = { getAdapter, listAdapters, PLAYER_TYPES, ADAPTERS };
