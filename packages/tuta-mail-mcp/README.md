# tuta-mail-mcp

Model Context Protocol (MCP) server that exposes Tuta mailbox operations as tools
for MCP hosts such as **Claude Desktop**, **Claude Code**, and **Cursor**. It is a
thin client over the `packages/tuta-mail-api` REST service (which in turn talks to
the Rust bridge → `tuta-sdk`), so all auth, rate limiting, idempotency, and
account isolation are enforced by the REST layer.

```
MCP host (Claude / Cursor / …)  ──stdio──►  tuta-mail-mcp  ──HTTP──►  tuta-mail-api  ──►  bridge(s) ──► Tuta
```

## Multi-account

**One MCP server manages all accounts.** Every account-scoped tool takes an
`account` argument (a slug like `work` or `personal`). The server holds one bearer
token per account and sends the matching token to the REST API, which maps it back
to that account — so a tool call can only ever touch the account named in `account`.
Call `list_accounts` first to discover configured ids. When only one account is
configured, `account` may be omitted.

## Configuration (environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `MAIL_API_BASE_URL` | no | REST service base URL (default `http://127.0.0.1:3100`). |
| `MAIL_API_TIMEOUT_MS` | no | Per-request timeout (default `60000`). |
| `MAIL_API_MCP_ACCOUNTS` | one of these | Inline JSON: array of `{ id, token, label? }` (or `{ "accounts": [...] }`). |
| `MAIL_API_MCP_ACCOUNTS_FILE` | one of these | Path to a JSON file with the same shape. |
| `MAIL_API_TOKEN` | fallback | Single-account shortcut; pairs with optional `MAIL_API_ACCOUNT_ID` (default `default`). |

Account `id`s must be slugs (`^[a-z0-9][a-z0-9_-]*$`) matching the ids configured
in `tuta-mail-api`. Tokens are the per-account bearer tokens minted there; they are
never surfaced to the model.

Example `accounts.json`:

```json
{
  "accounts": [
    { "id": "work", "label": "Work", "token": "<API_TOKEN_WORK>" },
    { "id": "personal", "label": "Personal", "token": "<API_TOKEN_PERSONAL>" }
  ]
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `list_accounts` | List managed accounts + each account's backend readiness (no tokens). |
| `list_folders` | List folders for an account. |
| `list_messages` | List message summaries with pagination + filters (unread, sender, date range, attachments). |
| `get_message` | Full message: headers, recipients, body, attachment metadata. |
| `download_attachment` | Attachment bytes (base64) + filename + content type. |
| `mark_message` | Set unread flag (IMAP `\Seen`). |
| `delete_message` | Move to trash (IMAP `\Deleted`). |
| `send_message` | Send mail; `externalPassword` for secure external send; `idempotencyKey` for safe retries. |
| `move_message` | Move to another folder (bridge currently trash-only). |

All tools return JSON text; failures come back as MCP tool errors (`isError: true`)
carrying the REST error code and message rather than crashing the server.

## Build & run

```bash
cargo --version >/dev/null 2>&1 || true   # bridge is a separate process; see tuta-mail-api-bridge
npm ci
npm run build -w @tutao/tuta-mail-mcp
```

The server speaks MCP over **stdio**, so it is normally launched by the MCP host
rather than run by hand. Logs go to stderr (stdout is the JSON-RPC channel).

### Claude Desktop / Claude Code / Cursor

Add to the host's MCP config (e.g. Claude Desktop `claude_desktop_config.json`,
Cursor `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tuta-mail": {
      "command": "node",
      "args": ["/abs/path/to/tutanota/packages/tuta-mail-mcp/dist/index.js"],
      "env": {
        "MAIL_API_BASE_URL": "http://127.0.0.1:3100",
        "MAIL_API_MCP_ACCOUNTS_FILE": "/etc/tuta-mail-api/mcp-accounts.json"
      }
    }
  }
}
```

The `tuta-mail-api` REST service (and one bridge per account) must be running and
reachable at `MAIL_API_BASE_URL`; see `doc/mail-bridge-deploy-baggy.md`.

## Tests

```bash
npm test -w @tutao/tuta-mail-mcp
```

Covers config parsing, the REST client (against a mock HTTP server), and full
end-to-end tool calls via an in-memory MCP client/server pair — including
per-account routing (each account's token reaches only its own mailbox).
