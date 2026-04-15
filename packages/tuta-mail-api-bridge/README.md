# tuta-mail-api-bridge

Rust sidecar that logs into Tuta with **tuta-sdk** and exposes `POST /invoke`, the contract expected by `packages/tuta-mail-api` (`HttpBridgeTutaClient`).

## Build

From the monorepo root (Rust toolchain required):

```bash
cargo build -p tuta-mail-api-bridge --release
```

Binary: `target/release/tuta-mail-api-bridge`

## Configuration (environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `TUTA_MAIL_BRIDGE_MAIL` | yes | Account mail address |
| `TUTA_MAIL_BRIDGE_PASSWORD` | yes | Account password |
| `TUTA_MAIL_BRIDGE_API_URL` | no | Tuta REST base URL (default `https://app.tuta.com`; falls back to `TUTA_API_URL` if set) |
| `TUTA_MAIL_BRIDGE_DATA_DIR` | no | Writable directory for SDK cache (default: temp `tuta-mail-api-bridge-data`) |
| `TUTA_MAIL_BRIDGE_LISTEN` | no | Bind address (default `127.0.0.1:4711`) |
| `TUTA_MAIL_BRIDGE_TOKEN` | no | If set, `/invoke` requires `Authorization: Bearer <same value>` |

## Run with the Node API

Terminal A:

```bash
export TUTA_MAIL_BRIDGE_MAIL='you@tuta.com'
export TUTA_MAIL_BRIDGE_PASSWORD='…'
./target/release/tuta-mail-api-bridge
```

Terminal B:

```bash
export MAIL_API_SERVICE_MODE=tuta
export TUTA_BRIDGE_BASE_URL='http://127.0.0.1:4711'
# optional: export TUTA_BRIDGE_AUTH_TOKEN='same as TUTA_MAIL_BRIDGE_TOKEN'
npm run build -w @tutao/tuta-mail-api && npm run start -w @tutao/tuta-mail-api
```

## Implemented invoke methods

- `loadFolders`, `loadMails`, `loadMail`, `loadMailDetails`, `loadAttachmentMeta`, `downloadAttachment`, `setUnread`, `trashMail`
- `moveMail` — only **trash** (`targetFolderId` `trash` or `3`); matches SDK `simple_move_mail` limitations
- `sendMail` — implemented (draft create + send)

## Local combined run (Overmind + smoke)

From the repo root, with `.env.mail-api` configured:

```bash
overmind start -D -f Procfile.mail-api
curl -sf http://127.0.0.1:3100/v1/health
set -a; source ./.env.mail-api; set +a
export TUTA_MAIL_API_BASE="http://${MAIL_API_HOST:-127.0.0.1}:${MAIL_API_PORT:-3100}"
bash packages/tuta-mail-api/scripts/rest-smoke-test.sh
```

For external recipients (for example Gmail), set `REST_SMOKE_EXTERNAL_PASSWORD` before running smoke.

## Pagination note

`loadMails` uses **MailSetEntry** ranges internally. The **`cursor`** parameter may be a **mail** id (`listId/elementId`, same string as message `id` / Node `nextCursor`) or a legacy **MailSetEntry** element **CustomId**. Omit `cursor` or pass an empty string for the first page.
