'use strict';

const { BasePlayerAdapter } = require('./base');

// LG webOS Signage.
class WebosAdapter extends BasePlayerAdapter {
  static get type() {
    return 'webos';
  }

  static get label() {
    return 'LG (webOS)';
  }

  static provisioning() {
    return {
      type: this.type,
      method: 'url',
      steps: [
        'SI Server / Custom Home: apontar para a URL do player do CMS.',
        'Fase 3: app .ipk via cadastro de parceiro webOS.',
      ],
    };
  }

  static capabilities() {
    return { power: true, reboot: true, screenshot: false, volume: true };
  }
}

module.exports = { WebosAdapter };
