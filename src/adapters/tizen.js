'use strict';

const { BasePlayerAdapter } = require('./base');

// Samsung Tizen (linha signage QM/QB/QH).
class TizenAdapter extends BasePlayerAdapter {
  static get type() {
    return 'tizen';
  }

  static get label() {
    return 'Samsung (Tizen)';
  }

  static provisioning() {
    return {
      type: this.type,
      method: 'url-launcher',
      // M1 valida via URL Launcher; app .wgt assinado (webapis.js) so na Fase 3.
      steps: [
        'No painel do monitor: Menu > URL Launcher Settings.',
        'Apontar para a URL do player servida pelo CMS.',
        'Fase 3: instalar .wgt assinado com certificado de parceiro.',
      ],
      sssp_config_hint: 'sssp_config.xml para deploy via servidor (Fase 3).',
    };
  }

  static capabilities() {
    return { power: true, reboot: true, screenshot: true, volume: true };
  }
}

module.exports = { TizenAdapter };
