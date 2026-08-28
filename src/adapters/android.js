'use strict';

const { BasePlayerAdapter } = require('./base');

// Android (kiosk / WebView).
class AndroidAdapter extends BasePlayerAdapter {
  static get type() {
    return 'android';
  }

  static get label() {
    return 'Android';
  }

  static provisioning() {
    return {
      type: this.type,
      method: 'apk',
      steps: [
        'Instalar o APK do player A3K (sideload ou MDM).',
        'App: WebView kiosk + autostart + cache + watchdog (Fase 3).',
        'M1: navegador em kiosk apontando para a URL do player.',
      ],
      apk_url: null,
    };
  }

  static capabilities() {
    return { power: false, reboot: true, screenshot: true, volume: true };
  }
}

module.exports = { AndroidAdapter };
