# Baggy Deploy TODO Checklist (Agent Handoff)

Goal: deploy `tuta-mail-api` + `tuta-mail-api-bridge` on `baggy` with systemd, loopback-only access, and n8n integration.

## 0) Preconditions

- [ ] SSH access works: `ssh baggy 'hostname && whoami'`
- [ ] Decide runtime user model:
  - [ ] Option A: existing user `pabloq` (faster)
  - [ ] Option B: dedicated `tuta` system user (recommended)
- [ ] Confirm disk target paths before install:
  - [ ] `df -h /var/lib /home`
  - [ ] Ensure runtime data does not fill `/` unexpectedly

## 1) Host setup

- [ ] Install bridge build/runtime prerequisites:
  - [ ] `build-essential`, `pkg-config`, `libssl-dev`
  - [ ] Rust via rustup (stable, minimal profile)
- [ ] Verify tools present: `node`, `npm`, `sqlite3`, `jq`, `git`

## 2) Place source on baggy

- [ ] Ensure repo exists on server (`~/src/tutanota`) via clone or rsync
- [ ] Confirm required files are present:
  - [ ] `packages/tuta-mail-api/**`
  - [ ] `packages/tuta-mail-api-bridge/**`
  - [ ] root `Cargo.toml`, `Cargo.lock`, root `package-lock.json`
  - [ ] `Procfile.mail-api` (optional for local overmind runs)

## 3) Build artifacts

- [ ] Build Node API:
  - [ ] `cd ~/src/tutanota/packages/tuta-mail-api`
  - [ ] `npm ci`
  - [ ] `npm run build`
  - [ ] `npm test`
- [ ] Build Rust bridge:
  - [ ] `cd ~/src/tutanota`
  - [ ] `cargo build -p tuta-mail-api-bridge --release`
  - [ ] `cargo test -p tuta-mail-api-bridge`

## 4) Install artifacts

- [ ] Install bridge binary:
  - [ ] `/usr/local/bin/tuta-mail-api-bridge` (mode 0755)
- [ ] Install Node API app files:
  - [ ] sync `dist/`, `package.json`, `package-lock.json` into `/var/lib/tuta-mail-api/app`
  - [ ] run `npm ci --omit=dev` inside `/var/lib/tuta-mail-api/app` as service user

## 5) Secrets and env files

- [ ] Generate tokens:
  - [ ] `API_TOKEN=$(openssl rand -base64 32)`
  - [ ] `BRIDGE_TOKEN=$(openssl rand -base64 32)`
- [ ] Write `/etc/tuta-mail-api/env` with:
  - [ ] `MAIL_API_HOST=127.0.0.1`
  - [ ] `MAIL_API_PORT=3100`
  - [ ] `MAIL_API_SERVICE_MODE=tuta`
  - [ ] `MAIL_API_DB_PATH=/var/lib/tuta-mail-api/state.sqlite`
  - [ ] `TUTA_BRIDGE_BASE_URL=http://127.0.0.1:4711`
  - [ ] `TUTA_BRIDGE_AUTH_TOKEN=<BRIDGE_TOKEN>`
  - [ ] `BOOTSTRAP_TOKEN=true`
  - [ ] `TUTA_MAIL_API_TOKEN=<API_TOKEN>`
- [ ] Write `/etc/tuta-mail-bridge/env` with:
  - [ ] `TUTA_MAIL_BRIDGE_API_URL=https://app.tuta.com`
  - [ ] `TUTA_MAIL_BRIDGE_MAIL=<service account>`
  - [ ] `TUTA_MAIL_BRIDGE_PASSWORD=<service password>`
  - [ ] `TUTA_MAIL_BRIDGE_DATA_DIR=/var/lib/tuta-mail-bridge`
  - [ ] `TUTA_MAIL_BRIDGE_LISTEN=127.0.0.1:4711`
  - [ ] `TUTA_MAIL_BRIDGE_TOKEN=<BRIDGE_TOKEN>`
- [ ] Set secure permissions (0600 env files; owned by service user)

## 6) Systemd units

- [ ] Create `/etc/systemd/system/tuta-mail-bridge.service`
- [ ] Create `/etc/systemd/system/tuta-mail-api.service`
- [ ] `sudo systemctl daemon-reload`
- [ ] `sudo systemctl enable --now tuta-mail-bridge tuta-mail-api`
- [ ] `sudo systemctl status tuta-mail-bridge tuta-mail-api --no-pager`

## 7) Validation

- [ ] Health check:
  - [ ] `curl -sf http://127.0.0.1:3100/v1/health | jq .mail`
  - [ ] expect `kind=http_bridge`, `mailOperationsReady=true`
- [ ] Auth check:
  - [ ] `GET /v1/folders` with bearer token returns 200
  - [ ] without token returns 401
- [ ] Run REST smoke:
  - [ ] `bash packages/tuta-mail-api/scripts/rest-smoke-test.sh`
  - [ ] if sending to external domains, set `REST_SMOKE_EXTERNAL_PASSWORD`

## 8) n8n wiring

- [ ] Create Header Auth credential in n8n:
  - [ ] header `Authorization`
  - [ ] value `Bearer <API_TOKEN>`
- [ ] Point HTTP Request nodes to `http://127.0.0.1:3100/v1/...`
- [ ] Run one end-to-end workflow smoke in n8n

## 9) Operations and hardening

- [ ] Set up log monitoring:
  - [ ] `journalctl -u tuta-mail-api -u tuta-mail-bridge -f`
- [ ] Confirm firewall exposure:
  - [ ] only 80/443 public as needed
  - [ ] ports 3100/4711 not publicly exposed
- [ ] Document token rotation execution (manual SQL revoke for old token)

## 10) Final handoff notes

- [ ] Record final locations:
  - [ ] source repo path
  - [ ] env file paths
  - [ ] systemd unit paths
  - [ ] data dirs (`/var/lib/tuta-mail-api`, `/var/lib/tuta-mail-bridge`)
- [ ] Record validated command outputs (health, smoke, systemd status)
- [ ] Keep this checklist updated during execution

## 11) Upgrade to multi-account (new mode)

See `mail-bridge-deploy-baggy.md` → "Upgrade the live deployment to multi-account".

- [ ] `git checkout feat/tuta-mail-bridge-mcp` in `~/src/tutanota`; `npm ci`; rebuild API + bridge; `npm test -w @tutao/tuta-mail-api`
- [ ] Redeploy API app to `/var/lib/tuta-mail-api/app` (`npm ci --omit=dev`); restart; confirm `/v1/health` shows `accounts[]`
- [ ] Per account: bridge env file (distinct `LISTEN` port + `DATA_DIR`), `tuta-mail-bridge@<id>.service` instance
- [ ] `/etc/tuta-mail-api/accounts.json` (0600 tuta) + `MAIL_API_ACCOUNTS_FILE` in env; drop legacy `TUTA_BRIDGE_*` / `TUTA_MAIL_API_TOKEN`
- [ ] Swap `tuta-mail-bridge.service` → `tuta-mail-bridge@<id>` instances; update API `After=`/`Requires=`
- [ ] Validate: `/v1/health` one `http_bridge` ready entry per account; `X-Tuta-Account` echoed

## 12) Install the MCP server (Claude / Cursor)

See `mail-bridge-deploy-baggy.md` → "MCP server (Claude / Cursor / third-party apps)".

- [ ] `npm run build -w @tutao/tuta-mail-mcp`; `npm test -w @tutao/tuta-mail-mcp`
- [ ] `/etc/tuta-mail-api/mcp-accounts.json` (0600 tuta) mapping account id → API bearer token
- [ ] Add `tuta-mail` entry to the MCP host config (`command: node`, `args: [.../tuta-mail-mcp/dist/index.js]`, `MAIL_API_BASE_URL`, `MAIL_API_MCP_ACCOUNTS_FILE`)
- [ ] Smoke test: pipe an `initialize` JSON-RPC line into `node dist/index.js`; expect a result naming `tuta-mail-mcp`
- [ ] Confirm tokens are never committed; files stay `0600`, loopback only
