'use strict';

const { BasePlayerAdapter } = require('./base');

// Windows (Chromium em kiosk).
class WindowsAdapter extends BasePlayerAdapter {
  static get type() {
    return 'windows';
  }

  static get label() {
    return 'Windows';
  }

  static provisioning() {
    return {
      type: this.type,
      method: 'installer',
      steps: [
        'Rodar o instalador do player A3K para Windows.',
        'Configura Chromium em kiosk + autostart (Fase 3).',
        'M1: Chrome/Edge em --kiosk apontando para a URL do player.',
      ],
      installer_url: null,
    };
  }

  static capabilities() {
    return { power: false, reboot: true, screenshot: true, volume: true };
  }
}

module.exports = { WindowsAdapter };
