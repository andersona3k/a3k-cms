# PROJECT.md — CMS de Digital Signage A3K (v2)

> Contexto para o Claude Code. Plataforma agnóstica de player, multiempresa.
> Princípio-mestre: **desenhar o schema para tudo agora, construir uma
> fatia vertical fina primeiro, depois aprofundar cada módulo.**

---

## Os 4 módulos do produto

1. **Configuração** — multiempresa, usuários, permissões, adapters de player.
2. **Biblioteca / Conteúdo** — upload de mídia, pastas, metadados.
3. **Playlist** — nomear, arrastar conteúdo, ordenar, (depois) agendar.
4. **Dispositivos** — players em listas/grupos, adicionar player, parear.

---

## Regra de ouro: fundação vs. feature

### Vai no schema AGORA (retrofit depois é caro)
- **Multiempresa**: `company_id` em TODA tabela. Mesmo com 1 empresa no começo.
- **Permissões**: modelo `users` + `roles` desde a 1a linha. Enforcement pode
  ser só "admin" no início, mas as tabelas existem.
- **Adapter de player**: abstração onde cada tipo (tizen/webos/android/windows)
  é um driver. `player_type` gravado em cada device.
- Estrutura de **pastas/assets** e **devices/grupos** no modelo de dados.

### Constrói EM CIMA, incremental (não trava a fundação)
- Extração de metadados (ffprobe/sharp).
- Drag-and-drop da playlist.
- Grupos de dispositivos (UI).
- Provisionamento remoto por tipo de player.
- Day-parting.

---

## O que mantém o CMS agnóstico

Sistema **pull-based**: o player pareia, baixa a mídia, roda offline, e faz
polling pedindo o manifest. **O manifest é IGUAL para os 3 players** — é isso
que garante a agnosticidade. NÃO criar manifest diferente por plataforma.

A "camada de comunicação por player" NÃO é o conteúdo — é um **adapter** que
define, por tipo:
- **Provisionamento**: como instalar (APK Android / URL sssp_config Samsung /
  ipk webOS / instalador Windows).
- **Capacidades + comandos**: o que o painel expõe (liga/desliga, reboot,
  screenshot). Aqui entra a lib Samsung `webapis.js` — só na Fase 3.

```
CMS (agnóstico) -- manifest idêntico --> [Tizen] [webOS] [Android] [Windows]
       |
       +- adapters (provisionamento + comandos), 1 por tipo de player
```

---

## Modelo de dados (fundação)

Tudo escopado por `company_id`.

```
companies      : id, name
users          : id, company_id, email, password_hash, role_id
roles          : id, company_id, name, permissions

folders        : id, company_id, parent_id, name
assets         : id, company_id, folder_id, type, filename, url, hash,
                 size_bytes, width, height, duration, fps, bitrate, codec, mime

playlists      : id, company_id, name, version
playlist_items : id, playlist_id, asset_id, ordem, duration   (+schedule depois)

device_groups  : id, company_id, name
devices        : id, company_id, group_id, serial, status, name,
                 player_type, last_seen, capabilities
assignments    : id, company_id, playlist_id, target_type(device|group), target_id
```

Regra-chave: alterar playlist **incrementa `version`** -> dispara re-sync no player.
Assignment pode mirar um **device** ou um **grupo** (device herda do grupo).

---

## Contrato da API (player)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/pair/new` | Registra device, devolve `{deviceId, serial}` |
| GET  | `/api/devices/:id/manifest?v=N` | Playlist+versão, ou 304 se nada mudou |
| GET  | `/assets/:file` | Download da mídia |
| POST | `/api/devices/:id/heartbeat` | Atualiza lastSeen + capabilities |

---

## Stack

Node.js + Express + SQLite (migra p/ Postgres depois). Mídia no filesystem.
**ffmpeg** no servidor p/ ffprobe (metadados de vídeo) + **sharp** (imagem).
Roda no Proxmox/VPS. Frontend do admin: HTML/JS (SortableJS p/ drag-drop).

---

## Ordem de construção

**M0 — Fundação.** Schema completo acima (com company_id, users/roles,
player_type, adapters como stub). Migrations. Auth de admin.

**M1 — Fatia vertical (1 empresa, só admin).** Upload simples -> playlist
create/add -> pareamento (serial) -> assign playlist->device -> manifest ->
player consome. Sem metadados, sem drag-drop, sem grupos ainda.
[OK] Teste: tocar ponta a ponta nos 3 monitores (Samsung URL Launcher, LG,
Android kiosk) na rede do Proxmox.

**M2 — Biblioteca a fundo.** Pastas, ffprobe/sharp no upload, painel de
info do arquivo (formato, resolução, fps, bitrate, tamanho).

**M3 — Playlist UX.** Drag-and-drop, reordenar, preview.

**M4 — Dispositivos a fundo.** Grupos, assign-to-grupo, lista/organização,
fluxo "Add player" com provisionamento por adapter (APK / URLs Tizen-webOS /
instalador Windows) -> device gera serial -> valida e vincula.

**M5 — Multiempresa + permissões (ativação).** Enforcement do company_id em
tudo, UI de roles/permissões, gestão de empresas. (Schema já pronto do M0.)

**M6 — Day-parting.** Condicionais dia/horário, avaliadas no relógio local.

**Fase 3 — Apps nativos (trilho separado).** APK Android (WebView kiosk +
autostart + cache + watchdog), app Tizen `.wgt` assinado (cert parceiro +
`webapis.js`), app webOS (cadastro parceiro), player Windows (Chromium kiosk).
Só os nativos entregam offline real.

---

## Como conduzir o Claude Code
- Um milestone por vez. Pedir "implementa o M0", testar, depois M1.
- Não abrir M5/M6/Fase 3 antes do M1 fechar ponta a ponta.
- Reaproveitar o `player/index.html` existente (no M1 só troca a origem de
  `playlist.json` para `/api/devices/:id/manifest`).
- Cada milestone tem teste de aceite — usar como checkpoint.

## Hardware de teste
1 Samsung (linha signage QM/QB/QH), 1 LG (webOS Signage), 1 Android.
Os três validam o M1 de uma vez — manifest idêntico serve todos.
