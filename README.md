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

### M2 — Biblioteca a fundo (concluido)

- **Pastas**: CRUD, renomear, mover (com prevencao de ciclo), apagar com guard
  (`409` se nao vazia; `?force=true` cascateia subpastas e desarquiva assets).
- **Metadados no upload**: `sharp` p/ imagem (width/height/format), `ffprobe`
  (binario embutido via `@ffprobe-installer/ffprobe`) p/ video/audio
  (duration/fps/bitrate/codec/format). Falha de probe nao quebra o upload —
  `probe_status` fica `error` e da p/ reprocessar.
- Asset: filtro por pasta, mover/renomear (`PATCH`), apagar (`DELETE`, remove o
  arquivo do disco se nenhum outro asset usar o mesmo hash; `409` se estiver em
  playlist, `?force=true` apaga e **bumpa a version** das playlists afetadas),
  `POST .../reprobe`.
- Painel de info do arquivo no `/admin/` (formato, resolucao, fps, bitrate,
  codec, tamanho, hash, status do probe) + preview.

### M3 — Playlist UX (concluido)

- **Reordenar**: `PUT /api/playlists/:id/order` `{item_ids:[...]}` — exige
  exatamente o conjunto atual de itens; grava `ordem` e bumpa a `version`.
- **Editar item**: `PATCH /api/playlists/:id/items/:itemId` `{duration?,ordem?}`.
- **Preview**: `GET /api/playlists/:id/manifest` devolve o mesmo shape do
  manifest de device (playlist isolada, sem precisar de um device).
- `/admin/`: drag-and-drop dos itens (SortableJS, servido de `node_modules`
  em `/vendor/sortablejs/`), duracao editavel inline, modal de preview que
  toca a playlist item a item.

### M4 — Dispositivos a fundo (concluido)

- **Grupos**: CRUD de `device-groups`, mover devices (individual via
  `PATCH /api/devices/:id {group_id}` ou em lote via
  `POST /api/device-groups/:id/devices {device_ids}`), `POST/DELETE
  /api/device-groups/:id/assign` (playlist -> grupo).
- **Heranca**: device sem assignment proprio toca a playlist do grupo;
  assignment proprio sobrepoe. `GET /api/devices` expoe `own_playlist`,
  `effective_playlist {id,name,version,source:'device'|'group'}` e `group_name`.
- **Add player**: `POST /api/pair/requests {name?,group_id?,player_type?}`
  gera um codigo curto + as instrucoes de provisionamento do adapter
  (`GET`/`DELETE /api/pair/requests[/:id]` p/ listar/cancelar/pollar). O player
  informa o codigo em `POST /api/pair/new {code,...}` e nasce vinculado
  (nome/grupo/tipo da solicitacao). Sem `code`, o pair continua abrindo um
  device solto (M1).
- **Manifest `?p=`**: alem de `?v=`, o player manda `&p=<playlistId>`; o `304`
  so acontece se a playlist E a versao baterem — troca de playlist (ex: grupo
  reapontado) e detectada mesmo que o numero da `version` coincida.
- `/admin/`: card de grupos + "Add player" (modal com codigo, provisionamento
  e poll ate parear); coluna de grupo e de playlist efetiva por device.

### M5 — Multiempresa + permissoes (concluido)

- **Isolamento**: toda query ja era escopada por `req.auth.companyId`; agora
  cruzar empresa devolve `404`. Empresa origem do usuario ganha um `homeCompanyId`.
- **Superadmin** (`users.is_superadmin`, migration 005): opera acima das
  empresas. Gere empresas via `/api/companies` (CRUD, cria a empresa + role
  `admin` + admin user). Pode atuar dentro de outra empresa mandando o header
  `X-Company-Id` (ou `?company_id`).
- **Permissoes**: `roles.permissions` = JSON `{ "*": true }` ou chaves do
  vocabulario (`src/lib/permissions.js`): `assets:write`, `folders:write`,
  `playlists:write`, `devices:write`, `groups:write`, `pairing:manage`,
  `users:manage`, `roles:manage`. `writeGuard(perm)` protege **toda mutacao**
  dos routers admin; GET so exige estar autenticado. Superadmin e `*` passam.
- **Papeis / usuarios**: `/api/roles` (perm `roles:manage`) e `/api/users`
  (perm `users:manage`), escopados a empresa em contexto. Nao da p/ desativar
  a si mesmo; nao apaga role em uso.
- **Pareamento multiempresa**: `POST /api/pair/new` sem `code` e recusado
  quando ha >1 empresa (o codigo carrega a empresa alvo).
- `/admin/`: card "5 · Administracao" (Empresas [superadmin], Papeis com
  checkboxes de permissao, Usuarios) + seletor de empresa no cabecalho.

### M6 — Day-parting (concluido)

- Cada `playlist_item` tem um `schedule` (JSON, coluna reservada desde o 001):
  ```
  schedule = null                     -> sempre no ar
  schedule = {
    days:  [1..7],       // ISO: 1=segunda..7=domingo. Ausente/vazio = todos.
    start: "HH:MM",       // hora local. Ausente = 00:00.
    end:   "HH:MM",       // hora local. Ausente = 24:00. start > end = vira a meia-noite.
    from:  "YYYY-MM-DD",  // primeira data (inclusive), opcional
    until: "YYYY-MM-DD"   // ultima data (inclusive), opcional
  }
  ```
  Numa janela virada (22:00-06:00), `days` = o dia em que a janela COMECA.
- `src/lib/schedule.js`: `validateSchedule` (normaliza, dropa filtros vazios,
  rejeita horas/dias/datas invalidas) e `isActive(schedule, date)`.
- `schedule` entra em `POST`/`PATCH`/`PUT` de itens (PATCH aceita `null` p/
  limpar). Toda mudanca bumpa a `version`.
- **Avaliado no relogio LOCAL do player**: o manifest de device carrega
  `schedule` por item e NAO filtra; o player (`public/player/index.html`)
  reavalia o subconjunto no ar a cada 20s. Fora de qualquer janela ->
  "Nada programado para agora".
- `GET /api/playlists/:id/manifest?active_at=<ISO>|now` filtra server-side
  (preview "como fica as 14h"). `GET /api/playlists/:id` traz `active_now` por item.
- `/admin/`: coluna **Horario** por item (resumo + bolinha no ar/fora) + editor
  (dias, inicio/fim, intervalo de datas).

### Fase 3 — apps nativos (em andamento)

Trilho separado, em `players/`. So os nativos entregam offline real.

- **`players/android/`** — casca de kiosk (Kotlin, minSdk 28) sobre `<cms>/player/`:
  autostart no boot, tela cheia imersiva, watchdog, e **cache de disco** que
  interceta os GET do WebView (`/assets/*`, manifest, casca) p/ tocar offline.
  Pareia pelo codigo do "Add player". `./gradlew :app:assembleDebug`. Ver o
  README de la.
- Pendente: `.wgt` Tizen assinado, app webOS, player Windows (Chrome/Edge
  `--kiosk` vs Assigned Access vs Electron — a decidir por projeto).

O player web (`public/player/index.html`) agora aceita `?code=<pairCode>` na URL
(usado so enquanto o device nao tem token) — serve a todos os wrappers nativos.

## Setup

```bash
npm install
cp .env.example .env      # ajuste JWT_SECRET e as credenciais do seed
npm run migrate           # cria/atualiza as tabelas
npm run seed              # cria empresa A3K + role admin + usuario admin
npm start                 # sobe em http://localhost:3000
```

`npm run reset` apaga o banco. `npm test` roda os testes de aceite (M0..M5).

O `seed` cria o admin como **superadmin**. Usuarios comuns entram por `/api/users`
(criados por quem tem `users:manage`) e recebem um `role_id`.

## API

### Admin (Bearer JWT do login)

Toda mutacao (`POST`/`PATCH`/`PUT`/`DELETE`) exige a permissao do recurso
(`assets:write`, `playlists:write`, ...); `GET` so exige estar autenticado.
Superadmin manda `X-Company-Id` p/ atuar em outra empresa.

| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/api/auth/login` | `{email,password}` -> `{token,user}` |
| GET  | `/api/auth/me` | usuario + permissoes + `isSuperadmin` |
| GET  | `/api/adapters` | stubs de provisionamento/capacidades por player_type |
| POST | `/api/assets` | multipart `file` (+ `folder_id` opc.) -> asset com metadados extraidos |
| GET  | `/api/assets[?folder_id=N\|unfiled]` · `/api/assets/:id` | lista / painel de info |
| PATCH | `/api/assets/:id` | `{folder_id?,filename?}` mover / renomear |
| POST | `/api/assets/:id/reprobe` | re-extrai metadados |
| DELETE | `/api/assets/:id[?force=true]` | apaga (409 se em playlist; force bumpa version) |
| GET  | `/api/folders` | lista plana (parent_id, contagens) |
| POST | `/api/folders` | `{name,parent_id?}` |
| PATCH | `/api/folders/:id` | `{name?,parent_id?}` renomear / mover |
| DELETE | `/api/folders/:id[?force=true]` | apaga (409 se nao vazia) |
| POST | `/api/playlists` | `{name}` -> playlist |
| GET  | `/api/playlists` · `/api/playlists/:id` | lista / detalhe com itens |
| GET  | `/api/playlists/:id/manifest[?active_at=<ISO>\|now]` | preview; com `active_at` filtra o day-parting |
| POST | `/api/playlists/:id/items` | `{asset_id,duration?,ordem?,schedule?}` (bumpa version) |
| PATCH | `/api/playlists/:id/items/:itemId` | `{duration?,ordem?,schedule?}` (`schedule:null` limpa) |
| PUT  | `/api/playlists/:id/items` | `{items:[{asset_id,duration,schedule?}]}` substitui tudo |
| PUT  | `/api/playlists/:id/order` | `{item_ids:[...]}` reordena (bumpa version) |
| DELETE | `/api/playlists/:id/items/:itemId` | remove item (bumpa version) |
| GET  | `/api/devices` · `/api/devices/:id` | lista / detalhe (+ `own_playlist`, `effective_playlist`, manifest) |
| PATCH | `/api/devices/:id` | `{name?,status?,player_type?,group_id?}` |
| POST | `/api/devices/:id/assign` | `{playlist_id}` (upsert do assignment do device) |
| DELETE | `/api/devices/:id/assign` | desatribui (volta a herdar do grupo) |
| GET  | `/api/device-groups` · POST · PATCH · DELETE | CRUD de grupos |
| POST | `/api/device-groups/:id/devices` | `{device_ids:[...]}` move devices p/ o grupo |
| POST · DELETE | `/api/device-groups/:id/assign` | `{playlist_id}` playlist -> grupo |
| POST | `/api/pair/requests` | `{name?,group_id?,player_type?}` -> `{request:{code},provisioning}` |
| GET  | `/api/pair/requests[/:id]` | lista / poll (mostra o device quando consumido) |
| DELETE | `/api/pair/requests/:id` | cancela o codigo |
| GET · POST · PATCH | `/api/companies[/:id]` | **superadmin** — gestao de empresas |
| GET · POST · PATCH · DELETE | `/api/roles[/:id]` | perm `roles:manage` — `{name,permissions}` |
| GET · POST · PATCH | `/api/users[/:id]` · POST `/:id/password` | perm `users:manage` |

### Player (sem JWT — `pair` aberto; manifest/heartbeat via token do device)

| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/api/pair/new` | `{hardware_id?,player_type?,name?,code?}` -> `{deviceId,serial,token,claimed}` |
| GET  | `/api/devices/:id/manifest?v=N&p=PID` | manifest, ou `304` se `v` **e** `p` baterem |
| POST | `/api/devices/:id/heartbeat` | `{playlist_version?,capabilities?}` -> `{currentVersion,playlistId}` |
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
    migrations/        001_init · 002_pairing · 003_library · 004_devices · 005_multitenant
                       (M6 nao tem migration: playlist_items.schedule ja existe do 001)
  auth/                password (scrypt) · jwt · middleware (writeGuard, superadmin) · routes
  adapters/            base + tizen/webos/android/windows (stubs) + registry
  lib/
    ids.js             gerador de serial + token + codigo de pareamento
    company.js         empresa alvo de pair sem codigo + companyCount()
    permissions.js     vocabulario de permissoes + validacao + `grants()`
    schedule.js        day-parting: validateSchedule + isActive (janela local)
    media.js           storage do multer, hash sha256, dedup
    manifest.js        manifest de device + manifest de playlist (preview, opc. filtrado)
    probe.js           sharp (imagem) + ffprobe (video/audio), normalizacao
    library.js         aplica probe no asset, apaga arquivo orfao
  routes/
    assets.js · folders.js · playlists.js · devices.js · deviceGroups.js
    pairing.js          Add player (codigo + provisionamento)
    companies.js        gestao de empresas (superadmin)
    roles.js · users.js CRUD de papeis e usuarios por empresa
    player.js           pair/new (com codigo), manifest (?v & ?p), heartbeat
public/
  player/index.html    player kiosk (vanilla) — segue ?p= p/ detectar troca de playlist
  admin/index.html     painel em ABAS (Biblioteca · Playlists · Dispositivos ·
                       Administracao) + barra de Log retratil no rodape. Aba lembrada
                       em localStorage e no hash da URL (#pane-playlist etc.); a aba
                       Administracao so aparece com permissao roles/users:manage.
                       Aba Dispositivos = tela cheia, visao unificada grupo+players:
                       cada grupo e uma linha-mae (playlist atual + "Salvar",
                       renomear, apagar) e os players entram nas linhas abaixo.
                       Colunas: ID · Nome (bolinha verde/vermelha ANTES do nome =
                       online/offline pelo last_seen <3min) · Tipo (icone da
                       plataforma) · Playlist efetiva · Atualizacao (barra de % +
                       data) · Contato · Acao (editar/apagar). Clicar na linha /
                       "editar" abre #devModal: serial, hw, capacidades, versao
                       alvo x versao no player, mover de grupo + playlist propria
                       com "Salvar", e as ultimas 5 mudancas (activity_log) com
                       o e-mail de quem fez. "+ Grupo" / "+ Dispositivo" na toolbar.
node_modules/sortablejs servido em /vendor/sortablejs/ (drag-drop, sem CDN)
scripts/
  seed.js · reset.js
test/
  m0..m10.test.js  testes de aceite (121 no total)
```

`sharp` traz binarios prebuilt; `@ffprobe-installer/ffprobe` baixa o `ffprobe`
por plataforma. Sem toolchain nativo. `FFPROBE_PATH` no `.env` sobrescreve.

## Modelo de dados

`companies`, `roles` (`permissions` JSON), `users` (`is_superadmin` no M5).
`folders`, `assets` — biblioteca (colunas de metadados nullable ate o M2).
`playlists` (com `version`), `playlist_items` (com `schedule` JSON de day-parting, M6).
`assets` ganhou `format`, `metadata` (dump cru do probe), `probe_status`
(`pending`/`ok`/`error`/`skipped`) e `probe_error` no M2.
`device_groups`, `devices` (`serial` unico, `player_type`, `capabilities` JSON,
`hardware_id`/`token`/`last_version` do pareamento; `last_version_at` = quando o
heartbeat confirmou uma versao nova, migration 008).
`activity_log` (008) — trilha de auditoria: uma linha por mudanca de `device`/
`group` (`action` `assign`/`group`/`rename`/`status`, `detail` legivel,
`actor_user_id`/`actor_email`). `GET /api/devices/:id/activity?limit=5` mescla
device + grupo. Escrito por `src/lib/activity.js` (best-effort, nunca quebra a rota).
`assignments` — aponta uma playlist para um `device` ou `group`; alvo unico por
`(company_id, target_type, target_id)`. Device sem assignment proprio herda a do
grupo (resolucao em `lib/manifest.js`).
`pair_requests` (M4) — solicitacoes do fluxo "Add player": `code` unico,
`name`/`group_id`/`player_type` pre-definidos, `status`
(`pending`/`consumed`/`expired`/`cancelled`), `device_id`, `expires_at`.

Regra-chave: alterar uma playlist **incrementa `version`** -> dispara re-sync no player.
