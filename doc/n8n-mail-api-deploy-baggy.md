# Deploy `tuta-mail-api` to `baggy` (host: `bagales`, 192.168.0.15)

Target: install the n8n mail API as two systemd services on `baggy`, terminate TLS
with the existing nginx + Let's Encrypt setup, and expose it to the local n8n
instance over loopback only (no public exposure required, since n8n runs on the
same host).

## Discovered host state (probed 2026-04-15)

| Aspect | Value |
|---|---|
| OS | Ubuntu 24.04.4 LTS (noble), kernel 6.8 |
| Hostname | `bagales` (LAN: 192.168.0.15, ssh alias: `baggy`) |
| Arch / CPU / RAM | x86_64, 4 cores, 15 GiB |
| Disks | `/` 118G **77 % used** (27G free), `/home` 324G 80 % used (64G free) |
| Login user | `pabloq` (uid 1000), in `sudo`, `docker` |
| Node | `/usr/bin/node` v20.20.1, npm 10.8.2 — **OK, no install needed** |
| Rust | **not installed**; apt offers only 1.75 (too old for `tuta-sdk`) → install via `rustup` |
| sqlite3, jq, git | present |
| Reverse proxy | nginx 1.24, certbot present |
| Existing nginx vhosts | `n8n.bagales.freeddns.org` (→ 127.0.0.1:5678), `atisbos.bagales.freeddns.org`, `bagales.freeddns.org` (default), `zotero-proxy.conf` (port 8888) |
| Existing certs | none under `/etc/letsencrypt/live` accessible without sudo — must be there since nginx serves them; confirm with `sudo ls /etc/letsencrypt/live` |
| Existing services | `n8n.service` (User=n8n, port 5678, EnvironmentFile=/var/lib/n8n/.env), `nginx.service` |
| Listen ports | 22, 80, 443 publicly; 5678 (n8n) and 23119 (zotero) loopback (inferred) |
| Firewall | `ufw` installed, status not readable without sudo — verify before opening anything |
| n8n | `/usr/bin/n8n`, runs as user `n8n`, group `n8n`, working dir `/var/lib/n8n` |

### Constraints this imposes

- **Disk pressure on `/`**: do **not** put SDK file cache, build artifacts, or
  `node_modules` under `/opt`. Use `/home/pabloq/srv/tuta-mail-api/` (or
  `/var/lib/tuta-mail-api` on the same partition — verify which mount it's on)
  for runtime data; build the Rust bridge under `$HOME` so target/ stays on
  `/home`.
- **n8n is already on the box** — no need for a public hostname. Bind the
  mail API to `127.0.0.1:3100` and have n8n call `http://127.0.0.1:3100`. This
  means we can **skip TLS / nginx / Let's Encrypt entirely for v1**. (Optional
  Phase 6 below adds a public hostname if remote access is later needed.)
- **No new Linux user needed** if we run as `pabloq` for v1. For better
  isolation and parity with `n8n.service` we should still create a `tuta` user;
  see Phase 1 alternative.

## Token auth approach (decision)

We reuse the existing `BOOTSTRAP_TOKEN=true` + `TUTA_MAIL_API_TOKEN=…` path from
`packages/tuta-mail-api/lib/index.ts`, but with three differences vs. the test
runbook:

1. **Generate the token off-server** (don't rely on the print-once branch in
   `index.ts:65` — easy to lose to log rotation):
   ```bash
   openssl rand -base64 32
   ```
   Paste the same value into both the systemd env file *and* the n8n credential.
2. **Persist tokens via SQLite**: set `MAIL_API_DB_PATH=/home/pabloq/srv/tuta-mail-api/state.sqlite`.
   The bootstrap path is idempotent — restarting with the same env value re-adds
   the same hash row, no re-bootstrap dance needed.
3. **Bridge auth**: also set `TUTA_MAIL_BRIDGE_TOKEN` so only the API process
   can reach the SDK sidecar (defense-in-depth, even on loopback).

This satisfies the plan's MUSTs:
- 256-bit entropy (`openssl rand -base64 32`)
- Hashed at rest (SHA-256 — Argon2id upgrade still on roadmap)
- Constant-time compare (already in `verifyTokenHash`)
- Never logged (the bootstrap branch explicitly avoids logging the env value)

**Rotation playbook** (manual until an admin API exists):
1. Generate new token, replace `TUTA_MAIL_API_TOKEN` in `/etc/tuta-mail-api/env`.
2. `sudo systemctl restart tuta-mail-api` → new hash registered alongside old.
3. Update n8n credential, redeploy workflows.
4. Mark old row revoked: `sqlite3 state.sqlite "UPDATE tokens SET status='revoked' WHERE token_id=…"`.

(Multiple integrations / per-workflow tokens require a small admin CLI — out of
scope for v1; the single bootstrap token covers all six scopes.)

## Deploy plan

### Phase 1 — provision

Choose ONE of:

**1A. Run as existing `pabloq` user** (faster; acceptable for v1 internal use):
```bash
ssh baggy 'mkdir -p ~/srv/tuta-mail-api ~/srv/tuta-mail-bridge ~/srv/tuta-mail-bridge/data'
```
Env files live under `~/.config/tuta-mail-api/` (mode 0600).

**1B. Dedicated service user** (recommended — matches `n8n.service` pattern):
```bash
ssh baggy 'sudo useradd --system --home /var/lib/tuta-mail-api --create-home --shell /usr/sbin/nologin tuta'
ssh baggy 'sudo mkdir -p /var/lib/tuta-mail-api /var/lib/tuta-mail-bridge /etc/tuta-mail-api /etc/tuta-mail-bridge'
ssh baggy 'sudo chown -R tuta: /var/lib/tuta-mail-api /var/lib/tuta-mail-bridge'
ssh baggy 'sudo chmod 750 /etc/tuta-mail-api /etc/tuta-mail-bridge'
```

The rest of this doc assumes **1B**. Substitute paths/user for 1A if you went that route.

### Phase 2 — install Rust toolchain (bridge only)

```bash
ssh baggy 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal'
ssh baggy '. ~/.cargo/env && rustc --version'
ssh baggy 'sudo apt-get install -y build-essential pkg-config libssl-dev'
```

### Phase 3 — get source + build

```bash
# Clone or rsync the repo to baggy
ssh baggy 'mkdir -p ~/src && cd ~/src && git clone https://github.com/tutao/tutanota.git || (cd tutanota && git pull)'
# Or, if the working tree on baggy must match a local branch:
rsync -a --delete --exclude node_modules --exclude target --exclude .git \
    ./ baggy:~/src/tutanota/

# Build the Node API (produces dist/)
ssh baggy 'cd ~/src/tutanota/packages/tuta-mail-api && npm ci && npm run build && npm test'

# Build the Rust bridge
ssh baggy '. ~/.cargo/env && cd ~/src/tutanota && cargo build -p tuta-mail-api-bridge --release && cargo test -p tuta-mail-api-bridge'
```

### Phase 4 — install artifacts

```bash
# Bridge binary → /usr/local/bin (only one file; tiny disk impact)
ssh baggy 'sudo install -m 0755 ~/src/tutanota/target/release/tuta-mail-api-bridge /usr/local/bin/'

# Node API → /var/lib/tuta-mail-api (avoid filling /opt on the small / partition)
ssh baggy '
  sudo rsync -a --delete \
    ~/src/tutanota/packages/tuta-mail-api/dist/ \
    ~/src/tutanota/packages/tuta-mail-api/package.json \
    ~/src/tutanota/packages/tuta-mail-api/package-lock.json \
    /var/lib/tuta-mail-api/app/
  sudo chown -R tuta: /var/lib/tuta-mail-api/app
  sudo -u tuta bash -c "cd /var/lib/tuta-mail-api/app && npm ci --omit=dev"
'
```

> **Why npm ci on the box, not rsyncing node_modules from dev?**
> `better-sqlite3` is a native module compiled for the host's glibc/Node ABI.

### Phase 5 — secrets

Generate two independent tokens locally first:
```bash
API_TOKEN=$(openssl rand -base64 32)
BRIDGE_TOKEN=$(openssl rand -base64 32)
echo "$API_TOKEN"   # save into n8n credentials manager
```

Write `/etc/tuta-mail-api/env` (mode 0600, owner `tuta:tuta`):
```ini
MAIL_API_HOST=127.0.0.1
MAIL_API_PORT=3100
MAIL_API_SERVICE_MODE=tuta
MAIL_API_DB_PATH=/var/lib/tuta-mail-api/state.sqlite
TUTA_BRIDGE_BASE_URL=http://127.0.0.1:4711
TUTA_BRIDGE_AUTH_TOKEN=<BRIDGE_TOKEN>
TUTA_BRIDGE_TIMEOUT_MS=60000
BOOTSTRAP_TOKEN=true
TUTA_MAIL_API_TOKEN=<API_TOKEN>
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
MAX_ATTACHMENT_BYTES=26214400
```

Write `/etc/tuta-mail-bridge/env` (mode 0600, owner `tuta:tuta`):
```ini
TUTA_MAIL_BRIDGE_API_URL=https://app.tuta.com
TUTA_MAIL_BRIDGE_MAIL=<service tuta account>
TUTA_MAIL_BRIDGE_PASSWORD=<service tuta password>
TUTA_MAIL_BRIDGE_DATA_DIR=/var/lib/tuta-mail-bridge
TUTA_MAIL_BRIDGE_LISTEN=127.0.0.1:4711
TUTA_MAIL_BRIDGE_TOKEN=<BRIDGE_TOKEN>   # MUST match TUTA_BRIDGE_AUTH_TOKEN above
```

Apply with `sudo install -m 0600 -o tuta -g tuta /tmp/env /etc/tuta-mail-api/env`
(don't `cat >` as root — leaves wrong permissions).

> ⚠ Use a **dedicated Tuta service account**, not a personal one. The bridge logs
> in with email + password and gets full mailbox access; treat these creds as
> sensitive infrastructure secrets.

### Phase 6 — systemd units

`/etc/systemd/system/tuta-mail-bridge.service`:
```ini
[Unit]
Description=Tuta Mail API Bridge (Rust SDK sidecar)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tuta
Group=tuta
EnvironmentFile=/etc/tuta-mail-bridge/env
ExecStart=/usr/local/bin/tuta-mail-api-bridge
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tuta-mail-bridge

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/tuta-mail-api.service`:
```ini
[Unit]
Description=Tuta Mail API (n8n-facing HTTP)
After=tuta-mail-bridge.service network-online.target
Requires=tuta-mail-bridge.service

[Service]
Type=simple
User=tuta
Group=tuta
WorkingDirectory=/var/lib/tuta-mail-api/app
EnvironmentFile=/etc/tuta-mail-api/env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tuta-mail-api

[Install]
WantedBy=multi-user.target
```

Enable + start:
```bash
ssh baggy 'sudo systemctl daemon-reload && sudo systemctl enable --now tuta-mail-bridge tuta-mail-api'
ssh baggy 'sudo systemctl status tuta-mail-bridge tuta-mail-api --no-pager'
```

### Phase 7 — smoke test (loopback)

```bash
ssh baggy 'curl -sf http://127.0.0.1:3100/v1/health | jq .mail'
# expect: kind=http_bridge, mailOperationsReady=true

ssh baggy 'set -a; source /etc/tuta-mail-api/env; set +a;
           curl -sf -H "Authorization: Bearer $TUTA_MAIL_API_TOKEN" \
                http://127.0.0.1:3100/v1/folders | jq'
```

Then run the existing REST smoke test against loopback:
```bash
ssh baggy '
  cd ~/src/tutanota/packages/tuta-mail-api &&
  TUTA_MAIL_API_BASE=http://127.0.0.1:3100 \
  TUTA_MAIL_API_TOKEN=$(grep ^TUTA_MAIL_API_TOKEN= /etc/tuta-mail-api/env | cut -d= -f2-) \
    bash scripts/rest-smoke-test.sh
'
```

### Phase 8 — wire up n8n

In the n8n UI (`https://n8n.bagales.freeddns.org`):
1. Settings → Credentials → New "Header Auth": name `tuta-mail-api`,
   header `Authorization`, value `Bearer <API_TOKEN>`.
2. Use HTTP Request nodes targeting `http://127.0.0.1:3100/v1/...` with that
   credential. (n8n runs on the same host; loopback works.)

### Phase 9 — observability

```bash
# Live logs
ssh baggy 'journalctl -u tuta-mail-api -u tuta-mail-bridge -f'

# Health probe via cron / uptime-kuma every minute
* * * * * curl -sf http://127.0.0.1:3100/v1/health > /dev/null || logger -t tuta-mail-api "health probe failed"
```

Logrotate is automatic via journald.

## Optional — Phase 10: public exposure (skip for v1)

If we later need to call the API from outside the box:

1. Add a new nginx vhost `mail-api.bagales.freeddns.org` reverse-proxying to
   `127.0.0.1:3100` (mirror the existing `n8n.bagales.freeddns.org` config).
2. Issue cert: `sudo certbot --nginx -d mail-api.bagales.freeddns.org`.
3. Tighten firewall: `sudo ufw status` first, then ensure 443 is allowed and
   3100 is **not** publicly reachable. Optional IP allowlist in nginx for known
   n8n / monitoring sources.
4. Rotate `TUTA_MAIL_API_TOKEN` on first public exposure (the loopback-only
   token has weaker exposure assumptions).

## Multiple accounts (2–10)

The single-account flow above maps `TUTA_MAIL_API_TOKEN` → one bridge. For
several accounts, keep **one bridge process per account** (own login, port, and
SDK cache dir) and describe them to the API in an accounts file. Each API token
is bound to exactly one account, so n8n gets one Header Auth credential per
account and the account is implied by the token (no request-side selection).

### 1. Accounts file

Write `/etc/tuta-mail-api/accounts.json` (mode 0600, owner `tuta:tuta`). The
`id` is a slug (`^[a-z0-9][a-z0-9_-]*$`) — **never** an email address, since it
appears in `/v1/health` and the `X-Tuta-Account` response header.

```json
{
  "accounts": [
    { "id": "work",     "label": "Work",     "serviceMode": "tuta", "bridgeBaseUrl": "http://127.0.0.1:4711", "bridgeAuthToken": "<BRIDGE_TOKEN_WORK>",     "token": "<API_TOKEN_WORK>" },
    { "id": "personal", "label": "Personal", "serviceMode": "tuta", "bridgeBaseUrl": "http://127.0.0.1:4712", "bridgeAuthToken": "<BRIDGE_TOKEN_PERSONAL>", "token": "<API_TOKEN_PERSONAL>" }
  ]
}
```

In `/etc/tuta-mail-api/env`, point the API at the file and drop the legacy
single-account `TUTA_BRIDGE_*` / `TUTA_MAIL_API_TOKEN` lines:

```ini
MAIL_API_HOST=127.0.0.1
MAIL_API_PORT=3100
MAIL_API_SERVICE_MODE=tuta
MAIL_API_DB_PATH=/var/lib/tuta-mail-api/state.sqlite
MAIL_API_ACCOUNTS_FILE=/etc/tuta-mail-api/accounts.json
BOOTSTRAP_TOKEN=true
```

With `BOOTSTRAP_TOKEN=true`, each account's `token` is registered (bound to that
account, 10-year TTL); accounts without a `token` get a random 24h token printed
once at startup.

### 2. One bridge env file per account

`/etc/tuta-mail-bridge/work.env`:
```ini
TUTA_MAIL_BRIDGE_API_URL=https://app.tuta.com
TUTA_MAIL_BRIDGE_MAIL=<work service account>
TUTA_MAIL_BRIDGE_PASSWORD=<work service password>
TUTA_MAIL_BRIDGE_DATA_DIR=/var/lib/tuta-mail-bridge/work
TUTA_MAIL_BRIDGE_LISTEN=127.0.0.1:4711
TUTA_MAIL_BRIDGE_TOKEN=<BRIDGE_TOKEN_WORK>   # must match bridgeAuthToken for "work"
```

`/etc/tuta-mail-bridge/personal.env` is identical but with the personal
credentials, `DATA_DIR=/var/lib/tuta-mail-bridge/personal`, `LISTEN=127.0.0.1:4712`,
and the personal bridge token. **Each account needs a distinct port and data dir.**

### 3. Templated systemd unit for the bridges

Replace `tuta-mail-bridge.service` with a template instantiated per account.
`/etc/systemd/system/tuta-mail-bridge@.service`:
```ini
[Unit]
Description=Tuta Mail API Bridge (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tuta
Group=tuta
EnvironmentFile=/etc/tuta-mail-bridge/%i.env
ExecStart=/usr/local/bin/tuta-mail-api-bridge
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tuta-mail-bridge

[Install]
WantedBy=multi-user.target
```

Update `tuta-mail-api.service` to require each instance:
```ini
After=tuta-mail-bridge@work.service tuta-mail-bridge@personal.service network-online.target
Requires=tuta-mail-bridge@work.service tuta-mail-bridge@personal.service
```

Provision and start:
```bash
ssh baggy 'sudo mkdir -p /var/lib/tuta-mail-bridge/work /var/lib/tuta-mail-bridge/personal && sudo chown -R tuta: /var/lib/tuta-mail-bridge'
ssh baggy 'sudo systemctl daemon-reload && sudo systemctl enable --now tuta-mail-bridge@work tuta-mail-bridge@personal tuta-mail-api'
```

### 4. Validate + wire n8n

```bash
ssh baggy 'curl -sf http://127.0.0.1:3100/v1/health | jq ".accounts[] | {id, kind: .kind, ready: .mailOperationsReady}"'
# expect one entry per account, kind=http_bridge, ready=true
```

In n8n create one Header Auth credential per account (`Authorization: Bearer
<API_TOKEN_WORK>`, etc.) and point each workflow at the credential for the
account it should act on. Responses echo `X-Tuta-Account: <id>` for debugging.

## Risks / questions to confirm before executing

- [ ] `/` partition is at 77 %. Confirm `/var/lib/tuta-mail-api` lands on the
      same partition; if so, prefer `/home/tuta/...` paths instead. Run
      `df -h /var/lib` to verify.
- [ ] Firewall state — `sudo ufw status verbose` to confirm 3100 and 4711
      aren't accidentally exposed.
- [ ] Tuta service-account credentials provisioned (separate from any personal
      account).
- [ ] The two outbound requirements: bridge needs HTTPS to `app.tuta.com`;
      verify the network egress works (`curl -I https://app.tuta.com`).
- [ ] Decide 1A (run as `pabloq`) vs. 1B (dedicated `tuta` user). 1B is
      recommended; 1A is faster.

## Rollback

```bash
ssh baggy '
  sudo systemctl disable --now tuta-mail-api tuta-mail-bridge
  sudo rm /etc/systemd/system/tuta-mail-{api,bridge}.service
  sudo systemctl daemon-reload
  sudo rm -rf /etc/tuta-mail-api /etc/tuta-mail-bridge /var/lib/tuta-mail-api /var/lib/tuta-mail-bridge /usr/local/bin/tuta-mail-api-bridge
  sudo userdel -r tuta 2>/dev/null
'
```

The n8n service and existing nginx vhosts are untouched at every step — this
deploy is additive.
