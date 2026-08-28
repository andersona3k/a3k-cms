# A3K CMS — Digital Signage

CMS agnostico de player, multiempresa. Sistema **pull-based**: o player pareia,
baixa a midia, roda offline e faz polling pedindo o manifest. O manifest e
**identico para todos os players** — e isso que garante a agnosticidade.

Veja [PROJECT.md](../PROJECT.md) (em `C:\AUTOMACAO\CMS\PROJECT.md`) para o contexto completo.

## Estado atual: M0 — Fundacao (concluido)

- Schema completo, tudo escopado por `company_id` (multiempresa no schema; o
  enforcement so entra no M5).
- Runner de migrations idempotente (`src/db/migrations/*.sql`).
- Auth de admin: login com JWT, hash de senha via `scrypt` (sem dep nativa).
- Stubs dos adapters de player (tizen / webos / android / windows).
- Banco: `node:sqlite` (builtin do Node 22.5+), arquivo em `data/cms.sqlite`.

### O que NAO existe ainda (proximos milestones)

M1 fatia vertical (upload -> playlist -> pareamento -> manifest -> player),
M2 biblioteca (ffprobe/sharp), M3 drag-drop, M4 dispositivos a fundo,
M5 multiempresa+permissoes, M6 day-parting, Fase 3 apps nativos.

## Setup

```bash
npm install
cp .env.example .env      # ajuste JWT_SECRET e as credenciais do seed
npm run migrate           # cria as tabelas
npm run seed              # cria empresa A3K + role admin + usuario admin
npm start                 # sobe em http://localhost:3000
```

`npm run reset` apaga o arquivo do banco. `npm test` roda o teste de aceite do M0.

## API (M0)

| Metodo | Rota | Auth | Descricao |
|--------|------|------|-----------|
| GET  | `/api/health`      | nao  | status do servico |
| POST | `/api/auth/login`  | nao  | `{email,password}` -> `{token,user}` |
| GET  | `/api/auth/me`     | Bearer | usuario autenticado + permissoes |
| GET  | `/api/adapters`    | Bearer | stubs de provisionamento/capacidades por player_type |

```bash
curl -s localhost:3000/api/health
TOKEN=$(curl -s -XPOST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@a3k.local","password":"admin123"}' | jq -r .token)
curl -s localhost:3000/api/auth/me -H "authorization: Bearer $TOKEN"
```

## Estrutura

```
src/
  config.js            env + caminhos
  server.js            bootstrap (migra no boot) + listen
  app.js               montagem do express
  db/
    index.js           conexao node:sqlite (WAL, FKs on)
    migrate.js         runner de migrations
    migrations/001_init.sql   schema completo da fundacao
  auth/
    password.js        hash/verify scrypt
    jwt.js             sign/verify
    middleware.js      requireAuth, requirePermission
    routes.js          /login, /me
  adapters/            base + tizen/webos/android/windows (stubs) + registry
scripts/
  seed.js              empresa + admin (idempotente)
  reset.js             apaga o banco
test/
  m0.test.js           teste de aceite do M0
```

## Modelo de dados

`companies`, `roles`, `users` — configuracao e permissoes.
`folders`, `assets` — biblioteca (colunas de metadados nullable ate o M2).
`playlists` (com `version`), `playlist_items` (com `schedule` reservado p/ M6).
`device_groups`, `devices` (`serial` unico, `player_type`, `capabilities` JSON).
`assignments` — aponta uma playlist para um `device` ou `group`; alvo unico por
`(company_id, target_type, target_id)`. Device sem assignment proprio herda a do
grupo (resolucao em codigo, no M1).

Regra-chave: alterar uma playlist **incrementa `version`** -> dispara re-sync no player.
