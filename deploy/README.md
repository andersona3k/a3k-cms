# Deploy — A3K CMS

Alvo: **Ubuntu 22.04/24.04**, Node 22, systemd + nginx. Sem Docker.

```
/opt/a3k-cms            checkout do repo (dono: usuário de serviço a3k)
/opt/a3k-cms/.env       config de produção (NÃO versionado)
/opt/a3k-cms/data/      cms.sqlite (WAL)
/opt/a3k-cms/media/     arquivos enviados
/etc/systemd/system/a3k-cms.service
/etc/nginx/sites-available/a3k-cms
/var/backups/a3k-cms/   snapshots do backup.sh
```

## Primeira vez

```bash
# na VM, como root
git clone git@github.com:andersona3k/a3k-cms.git /tmp/a3k-cms   # ou baixe só a pasta deploy/
sudo bash /tmp/a3k-cms/deploy/setup.sh
```

`setup.sh` instala Node/nginx/sqlite3, cria o usuário `a3k`, instala o unit
systemd e o site nginx, e **gera uma deploy key**. Ele imprime a chave pública:
cadastre em **GitHub → repo → Settings → Deploy keys → Add deploy key**
(pode ser read-only).

```bash
sudo bash /opt/a3k-cms/deploy/deploy.sh          # clona em /opt/a3k-cms + npm ci + migrate

sudo cp /opt/a3k-cms/.env.production.example /opt/a3k-cms/.env
sudo nano /opt/a3k-cms/.env                       # JWT_SECRET forte, SEED_ADMIN_PASSWORD
#   gerar segredo:  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
sudo chown a3k:a3k /opt/a3k-cms/.env && sudo chmod 600 /opt/a3k-cms/.env

sudo -u a3k bash -lc 'cd /opt/a3k-cms && npm run migrate && npm run seed'
sudo systemctl restart a3k-cms
curl -s localhost:3000/api/health                 # {"ok":true,...}
```

Agende o backup:

```bash
( crontab -l 2>/dev/null; echo '15 3 * * * /opt/a3k-cms/deploy/backup.sh >> /var/log/a3k-cms-backup.log 2>&1' ) | crontab -
```

Acesso: `http://<ip-da-vm>/admin/` e `http://<ip-da-vm>/player/`.

## Atualizações (recorrente)

```bash
sudo bash /opt/a3k-cms/deploy/deploy.sh
```

git reset --hard em `origin/master` + `npm ci --omit=dev` + `npm run migrate`
(as migrações também rodam sozinhas no boot) + `systemctl restart a3k-cms` +
checagem do `/api/health`.

### Rede que filtra o GitHub

Se a VM não alcança `github.com` (ex.: DNS/firewall corporativo — `getent hosts
github.com` devolve um IP que não é da GitHub), `deploy.sh` falha no clone.
Nesse caso o deploy sai da máquina de desenvolvimento:

```bash
bash deploy/push-deploy.sh a3k-cms-vm
```

`git archive` do branch atual → `ssh` → `tar -x` em `/opt/a3k-cms` + `npm ci
--omit=dev --ignore-scripts` + migrate + restart. A VM usa **ffmpeg/ffprobe do
sistema** (`apt install ffmpeg`, `FFMPEG_PATH`/`FFPROBE_PATH` no `.env`), então
`ffmpeg-static` (que baixa binário do GitHub) não é necessário —
`--ignore-scripts` pula esse download. A VM externa, com saída liberada, usa o
`deploy.sh` normal.

## VM externa (depois de validar)

1. DNS do domínio → IP da VM. Ajuste `server_name` em
   `/etc/nginx/sites-available/a3k-cms`.
2. TLS:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d signage.suaempresa.com.br
   ```
   O certbot adiciona o bloco 443 + redirect 80→443. **HTTPS destrava o Service
   Worker do player** (boot offline a frio) e permite o link funcionar de
   qualquer rede.
3. Firewall: `sudo ufw allow 22,80,443/tcp && sudo ufw enable`. `fail2ban`.
4. Backup para fora da VM (rsync/rclone do `/var/backups/a3k-cms`).

## Operação

| Ação | Comando |
|---|---|
| logs | `journalctl -u a3k-cms -f` |
| status | `systemctl status a3k-cms` |
| restart | `systemctl restart a3k-cms` |
| nginx | `nginx -t && systemctl reload nginx` |
| backup manual | `sudo /opt/a3k-cms/deploy/backup.sh` |
| restore sqlite | parar o serviço, `gunzip -c cms-*.sqlite.gz > /opt/a3k-cms/data/cms.sqlite`, `chown a3k:a3k`, iniciar |
