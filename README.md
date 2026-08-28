# A3K CMS — Digital Signage

CMS agnostico de player, multiempresa. Sistema **pull-based**: o player pareia,
baixa a midia, roda offline e faz polling pedindo o manifest. O manifest e
**identico para todos os players** — e isso que garante a agnosticidade.

Veja [PROJECT.md](../PROJECT.md) (em `C:\AUTOMACAO\CMS\PROJECT.md`) para o contexto completo.

## Estado atual

### M0 — Fundacao (concluido)

- Schema completo, tudo escopado por `company_id` (multiempresa no schema; o
  enforcement so entra no M5).
- Runner de migrations idempotente (`src/db/migrations/*.sql`).
- Auth de admin: login com JWT, hash de senha via `scrypt` (sem dep nativa).
- Stubs dos adapters de player (tizen / webos / android / windows).
- Banco: `node:sqlite` (builtin do Node 22.5+), arquivo em `data/cms.sqlite`.

### M1 — Fatia vertical (concluido)

Ponta a ponta, 1 empresa, so admin: **upload -> playlist create/add -> pareamento
por serial -> assign playlist->device -> manifest -> player consome.**
Sem metadados (ffprobe/sharp fica no M2), sem drag-drop (M3), sem grupos (M4).

- Upload de midia (`multer`), gravada em `media/<sha256><ext>`, dedup por hash.
- CRUD de playlist + itens; qualquer mudanca de conteudo **incrementa `version`**.
- `POST /api/pair/new`: registra device, devolve `{deviceId, serial, token}`.
  Re-pair idempotente pelo `hardware_id`.
- Manifest identico p/ todo player; `?v=N` -> `304` quando nada mudou.
- Heartbeat atualiza `last_seen` + `capabilities` + `last_version`.
- Player web em `/player/` (kiosk, vanilla JS) e mini painel em `/admin/`.

### Proximos

M2 biblioteca a fundo (pastas, ffprobe/sharp, painel de info do arquivo),
M3 playlist UX (drag-drop, reordenar, preview), M4 dispositivos a fundo
(grupos, assign-to-grupo, fluxo "Add player" por adapter), M5 multiempresa +
permissoes (enforcement), M6 day-parting, Fase 3 apps nativos.

## Setup

```bash
npm install
cp .env.example .env      # ajuste JWT_SECRET e as credenciais do seed
npm run migrate           # cria/atualiza as tabelas
npm run seed              # cria empresa A3K + role admin + usuario admin
npm start                 # sobe em http://localhost:3000
```

`npm run reset` apaga o banco. `npm test` roda os testes de aceite (M0 + M1).

## API

### Admin (Bearer JWT do login)

| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/api/auth/login` | `{email,password}` -> `{token,user}` |
| GET  | `/api/auth/me` | usuario + permissoes |
| GET  | `/api/adapters` | stubs de provisionamento/capacidades por player_type |
| POST | `/api/assets` | multipart, campo `file` (+ `folder_id` opc.) -> asset |
| GET  | `/api/assets` · `/api/assets/:id` | lista / detalhe |
| POST | `/api/playlists` | `{name}` -> playlist |
| GET  | `/api/playlists` · `/api/playlists/:id` | lista / detalhe com itens |
| POST | `/api/playlists/:id/items` | `{asset_id,duration?,ordem?}` (bumpa version) |
| PUT  | `/api/playlists/:id/items` | `{items:[{asset_id,duration}]}` substitui tudo |
| DELETE | `/api/playlists/:id/items/:itemId` | remove item (bumpa version) |
| GET  | `/api/devices` · `/api/devices/:id` | lista / detalhe (+ manifest) |
| PATCH | `/api/devices/:id` | `{name?,status?,player_type?,group_id?}` |
| POST | `/api/devices/:id/assign` | `{playlist_id}` (upsert do assignment) |
| DELETE | `/api/devices/:id/assign` | desatribui |

### Player (sem JWT — `pair` aberto; manifest/heartbeat via token do device)

| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/api/pair/new` | `{hardware_id?,player_type?,name?}` -> `{deviceId,serial,token}` |
| GET  | `/api/devices/:id/manifest?v=N` | manifest, ou `304` se `v` == versao atual |
| POST | `/api/devices/:id/heartbeat` | `{playlist_version?,capabilities?}` |
| GET  | `/assets/:file` | download da midia |

## Testar M1 ponta a ponta

1. `npm run seed && npm start`
2. Abra `http://localhost:3000/admin/` — login `admin@a3k.local` / `admin123`.
3. **Upload** de uma imagem ou video.
4. **Criar playlist**, selecionar, **adicionar item**.
5. Abra `http://localhost:3000/player/` num monitor / aba / kiosk.
   O device aparece na secao **Dispositivos** com um serial `A3K-XXXXXX`.
6. Escolha a playlist no seletor do device e clique **atribuir**.
7. Em ~15s o player troca de "Aguardando conteudo" para a midia em loop.
   Editar a playlist bumpa a `version` e o player re-sincroniza sozinho.

Nos 3 monitores de teste (Samsung URL Launcher, LG webOS, Android kiosk) e so
apontar o navegador/kiosk para `/player/` — o manifest e o mesmo para todos.

## Estrutura

```
src/
  config.js            env + caminhos
  server.js            bootstrap (migra no boot) + listen
  app.js               montagem do express (ordem: player antes do admin /devices)
  db/
    index.js           conexao node:sqlite (WAL, FKs on)
    migrate.js         runner de migrations
    migrations/        001_init.sql (fundacao) · 002_m1_pairing.sql
  auth/                password (scrypt) · jwt · middleware · routes
  adapters/            base + tizen/webos/android/windows (stubs) + registry
  lib/
    ids.js             gerador de serial + token de device
    company.js         empresa padrao (M1 single-company)
    media.js           storage do multer, hash sha256, dedup
    manifest.js        resolve assignment + monta o manifest
  routes/
    assets.js          upload / listagem
    playlists.js       CRUD + itens + bump de version
    devices.js         listagem / patch / assign (admin)
    player.js          pair/new, manifest, heartbeat (device token)
public/
  player/index.html    player kiosk (vanilla)
  admin/index.html     mini painel para dirigir o M1
scripts/
  seed.js · reset.js
test/
  m0.test.js · m1.test.js   testes de aceite
```

## Modelo de dados

`companies`, `roles`, `users` — configuracao e permissoes.
`folders`, `assets` — biblioteca (colunas de metadados nullable ate o M2).
`playlists` (com `version`), `playlist_items` (com `schedule` reservado p/ M6).
`device_groups`, `devices` (`serial` unico, `player_type`, `capabilities` JSON,
`hardware_id`/`token`/`last_version` do pareamento).
`assignments` — aponta uma playlist para um `device` ou `group`; alvo unico por
`(company_id, target_type, target_id)`. Device sem assignment proprio herda a do
grupo (resolucao em codigo; heranca de grupo so vale a partir do M4).

Regra-chave: alterar uma playlist **incrementa `version`** -> dispara re-sync no player.
