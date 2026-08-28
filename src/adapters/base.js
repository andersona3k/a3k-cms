'use strict';

// Contrato do adapter de player. Cada tipo (tizen/webos/android/windows) e um
// driver que implementa provisionamento + capacidades/comandos. O CONTEUDO
// (manifest) NAO passa por aqui — o manifest e identico para todos os players.
//
// M0: apenas stubs. A implementacao real de cada metodo entra na Fase 3.

class BasePlayerAdapter {
  /** identificador usado em devices.player_type */
  static get type() {
    return 'base';
  }

  /** rotulo legivel para UI */
  static get label() {
    return 'Base';
  }

  /**
   * Instrucoes de provisionamento para este tipo de player.
   * Retorna um objeto serializavel que o painel "Add player" renderiza.
   */
  static provisioning() {
    return {
      type: this.type,
      method: 'stub',
      steps: ['Nao implementado no M0.'],
    };
  }

  /**
   * Capacidades que o painel pode expor para este tipo (liga/desliga, reboot,
   * screenshot, ...). No runtime real isso e cruzado com o que o device
   * reporta no heartbeat (devices.capabilities).
   */
  static capabilities() {
    return {
      power: false,
      reboot: false,
      screenshot: false,
      volume: false,
    };
  }

  /**
   * Traduz um comando logico do painel para a acao concreta do player.
   * M0: lanca — nada de comando remoto ainda.
   */
  static async sendCommand(device, command /*, params */) {
    throw new Error(
      `[adapter:${this.type}] sendCommand("${command}") nao implementado no M0`
    );
  }
}

module.exports = { BasePlayerAdapter };
