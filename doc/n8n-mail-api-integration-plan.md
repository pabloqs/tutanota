# Tuta Mail Read API for n8n: Required Changes

## Goal

Build a secure API that reads Tuta mailbox data and exposes controlled endpoints for automation in n8n workflows.

This document defines the required changes, security model, quality gates, and rollout plan.

## Scope

- Provide API access to mailbox/folder/message data, including write actions for send, move, delete, and status updates.
- Achieve feature parity with common SMTP/IMAP mail workflows (header access, attachments, threading, filtering, read status, delete).
- Support automation use cases in n8n (triage, routing, notifications, enrichment).
- Ensure third-party access is strictly authenticated and authorized.
- Enforce high engineering quality across implementation and CI.

## Non-Goals

- Building a full SMTP/IMAP server (the API covers equivalent read/write features over REST).
- Exposing bulk-destructive actions (for example bulk permanent delete).
- Weak auth models (API key in query params, basic auth, long-lived static secrets).

## Current Codebase Capabilities to Reuse

- `tuta-sdk/rust/sdk`: login, encrypted entity handling, mail facade access.
- `packages/node-mimimi`: MIME/IMAP import compatibility logic and edge-case tests.
- Existing project build/test/lint ecosystem in monorepo.

## Target Architecture

### Standalone API process and Tuta connectivity

The n8n-facing service (`packages/tuta-mail-api`) is **always a standalone Node/Express process**: one binary (or `node dist/index.js`) with its own port, bearer-token auth, and optional SQLite for tokens and idempotency. n8n and other clients talk only to this HTTP API.

**Important:** this package does **not** embed the Tuta Rust SDK or open an encrypted mail session to `TUTA_API_URL` by itself. Mail against real Tuta servers is implemented in one of these ways:

| `MAIL_API_SERVICE_MODE` | `TUTA_BRIDGE_BASE_URL` | Behaviour |
|---|---|---|
| `dev` (default) | ignored | In-memory demo mailbox. **No** calls to Tuta. Safe for local automation tests. |
| `tuta` | **set** | Mail calls go to a **sidecar** over `POST …/invoke` (`HttpBridgeTutaClient`). The reference implementation is **`packages/tuta-mail-api-bridge`** (Rust, workspace member): it uses `tuta-sdk`, logs in with `TUTA_MAIL_BRIDGE_MAIL` / `TUTA_MAIL_BRIDGE_PASSWORD`, and talks to `TUTA_MAIL_BRIDGE_API_URL` (or `TUTA_API_URL`). Point `TUTA_BRIDGE_BASE_URL` at that process (for example `http://127.0.0.1:4711`). |
| `tuta` | **unset** | Mail endpoints that need the SDK return **503** (`upstream_unavailable`). The process still starts; use this to detect misconfiguration. |

`TUTA_API_URL` is loaded in this service for **operators and health reporting** (and for a future in-process client). It is **not** used today to fetch mail inside Node.

**Operational discovery:** `GET /v1/health` (no auth) returns `{ status, mail }` where `mail.kind` is one of `dev_stub`, `http_bridge`, or `tuta_unconfigured`, and `mail.mailOperationsReady` is `false` when production mail is not wired. On startup, the process logs the same backend kind and warns when mail is not ready.

**Roadmap:** optional single image bundling Node API + bridge, or an in-process binding (N-API / subprocess) so operators do not manage two listen ports—without reimplementing crypto in TypeScript.

**Bridge quickstart:** `cargo build -p tuta-mail-api-bridge --release` from repo root; see `packages/tuta-mail-api-bridge/README.md` for env vars and current limitations (`moveMail` is trash-only). `downloadAttachment`, mail-id `loadMails` cursors, and `sendMail` are implemented.

### Clients: MCP server (Claude, Cursor) and REST

The REST API is the stable core; third-party apps connect through it in two ways:

- **MCP server** ([`packages/tuta-mail-mcp`](../packages/tuta-mail-mcp)) — an MCP server for hosts like Claude Desktop/Code and Cursor. It exposes the mailbox as tools (`list_folders`, `list_messages`, `get_message`, `send_message`, `move_message`, `download_attachment`, `mark_message`, `delete_message`, plus `list_accounts`) over stdio, wrapping the REST API. **One MCP server manages all accounts**: each tool takes an `account` argument, and the server holds one bearer token per account, preserving the "token → one account" isolation. See its [README](../packages/tuta-mail-mcp/README.md).
- **Direct REST** — any HTTP client (n8n HTTP nodes, scripts, other services) calls the endpoints below with a per-account bearer token.

### Multi-account support

The service can front **multiple Tuta accounts** (designed for a small, static set of 2–10). The model is:

- **One bridge per account.** Each account has its own `tuta-mail-api-bridge` process (own login, port, SDK cache dir), so accounts are isolated by process, port, and cache. The Rust bridge stays single-account; you run N of them.
- **Tokens are bound to one account.** Each API token carries an `accountId` ([`TokenRecord.accountId`](../packages/tuta-mail-api/lib/dto/types.ts)); the account is implied by the bearer token. A token can never reach another account's mail, and n8n uses one Header Auth credential per account. There is no request-side account selector.
- **Accounts config.** Provide `MAIL_API_ACCOUNTS_FILE` (path to a JSON file) or `MAIL_API_ACCOUNTS` (inline JSON). Both accept a bare array or `{ "accounts": [...] }`. Each entry:

  | Field | Required | Notes |
  |---|---|---|
  | `id` | yes | Slug `^[a-z0-9][a-z0-9_-]*$`. Appears in `/v1/health` and the `X-Tuta-Account` response header — **never** an email address. |
  | `serviceMode` | no | `tuta` or `dev`; defaults to `MAIL_API_SERVICE_MODE`. |
  | `bridgeBaseUrl` | when `tuta` | This account's bridge sidecar URL. |
  | `bridgeAuthToken` | no | Bearer token sent to that bridge. |
  | `bridgeTimeoutMs` | no | Defaults to `TUTA_BRIDGE_TIMEOUT_MS`. |
  | `tutaApiUrl` | no | Health/reporting only. |
  | `label` | no | Human-readable label for operators. |
  | `token` | no | Fixed API token registered at bootstrap (with `BOOTSTRAP_TOKEN=true`), bound to this account, long-lived. |

- **Backward compatible.** With neither env var set, a single `default` account is synthesized from the legacy `TUTA_BRIDGE_BASE_URL` / `TUTA_BRIDGE_AUTH_TOKEN` / `TUTA_API_URL` / `TUTA_MAIL_API_TOKEN`. Existing single-account deployments and tokens keep working unchanged.
- **Health.** `GET /v1/health` returns `accounts: [{ id, label, kind, mailOperationsReady, ... }]` (one per account) plus a top-level `mail` mirroring the `default`/legacy shape.
- **Persistence.** The SQLite `api_tokens` table gains an `account_id` column; pre-existing databases are migrated in place (rows default to `default`).

Deployment (templated systemd unit per bridge, accounts file, per-account n8n credentials) is in [`n8n-mail-api-deploy-baggy.md`](./n8n-mail-api-deploy-baggy.md) → "Multiple accounts".

### Local dev runbook (`.env.mail-api` + Overmind + smoke)

This repository includes a practical local run path that starts the Node API and Rust bridge together:

1. Fill `.env.mail-api` with:
   - API auth token (`TUTA_MAIL_API_TOKEN`) and `BOOTSTRAP_TOKEN=true`
   - bridge credentials (`TUTA_MAIL_BRIDGE_MAIL`, `TUTA_MAIL_BRIDGE_PASSWORD`)
   - bridge + API networking (`TUTA_MAIL_BRIDGE_LISTEN`, `TUTA_BRIDGE_BASE_URL`, `MAIL_API_HOST`, `MAIL_API_PORT`)
2. Start both processes with Overmind:
   - `overmind start -D -f Procfile.mail-api`
3. Verify readiness:
   - `curl -sf http://127.0.0.1:3100/v1/health`
4. Run REST smoke:
   - `set -a; source ./.env.mail-api; set +a`
   - `export TUTA_MAIL_API_BASE="http://${MAIL_API_HOST:-127.0.0.1}:${MAIL_API_PORT:-3100}"`
   - `bash packages/tuta-mail-api/scripts/rest-smoke-test.sh`

Notes:
- For external recipients (for example Gmail), set `REST_SMOKE_EXTERNAL_PASSWORD` so the secure-external send step succeeds.
- On cold starts, run smoke after health is up and the bridge has had a few seconds to finish initialization.

### 1) Internal Mail Access Layer

- Create a service module that wraps Tuta SDK calls:
  - Login/session bootstrap.
  - Load mailbox and folders.
  - Resolve folder message entries and retrieve decrypted mail metadata/content.
- Add stable internal interfaces so API handlers do not directly call SDK internals.

### 2) API Layer for n8n

- Add dedicated API service endpoints:
  - `GET /health`
  - `GET /v1/folders`
  - `GET /v1/messages?folder={id|kind}&cursor=...&limit=...&since=...&before=...&unread=...&from=...&hasAttachments=...`
  - `GET /v1/messages/{id}`
  - `GET /v1/messages/{id}/attachments/{attachmentId}` — binary attachment download
  - `PATCH /v1/messages/{id}` — mark read/unread (IMAP `\Seen` equivalent)
  - `POST /v1/messages/send`
  - `POST /v1/messages/{id}/move`
  - `DELETE /v1/messages/{id}` — trash message (IMAP `\Deleted` equivalent)
- Return deterministic JSON schema with pagination metadata and error envelopes.

### SMTP/IMAP Feature Parity

The API must expose the following mail metadata to match common SMTP header and IMAP flag capabilities:

| SMTP/IMAP Feature | Tuta Source Field | API Exposure |
|---|---|---|
| `From` | `Mail.sender` | `MessageSummary.from` |
| `To` / `CC` / `BCC` | `MailDetails.recipients` | `MessageDetail.to/cc/bcc` |
| `Reply-To` | `MailDetails.replyTos` | `MessageDetail.replyTo` |
| `Date` (sent) | `MailDetails.sentDate` | `MessageDetail.sentAt` / `MessageSummary.sentAt` |
| `Date` (received) | `Mail.receivedDate` | `MessageSummary.receivedAt` |
| `Return-Path` / envelope sender | `Mail.differentEnvelopeSender` | `MessageDetail.envelopeSender` |
| `In-Reply-To` / `References` | `Mail.replyType` + parsed headers | `MessageDetail.replyType`, `MessageDetail.headers` |
| `List-Unsubscribe` | `Mail.listUnsubscribe` | `MessageDetail.listUnsubscribe` |
| SPF/DKIM/DMARC result | `Mail.authStatus` | `MessageDetail.authStatus` |
| Phishing/spam classification | `Mail.phishingStatus` | `MessageDetail.phishingStatus` |
| E2E encryption flag | `Mail.confidential` | `MessageDetail.confidential` / `MessageSummary.confidential` |
| Mail state (draft/sent/received) | `Mail.state` | `MessageSummary.state` |
| `\Seen` flag | `Mail.unread` | `MessageSummary.unread` (+ `PATCH` to change) |
| `\Deleted` | via `trashMails` | `DELETE /v1/messages/{id}` |
| Attachment MIME parts | `Mail.attachments` → `TutanotaFile` | `MessageDetail.attachments` + download endpoint |
| Raw MIME headers | `MailDetails.headers` (LZ4-compressed) | `MessageDetail.headers` |
| Inline images (`Content-ID`) | attachments with CID references | `MessageDetail.attachments[].contentId` |

### 3) Integration Hardening Layer

- Idempotency and retry-safe behavior for n8n calls.
- Explicit rate limits and request size limits.
- Structured logs and request tracing for auditability.

## Security Requirements (MUST)

### Strong Token-Based Access for Third Parties

- Use strong bearer tokens only (minimum 256-bit random entropy).
- Store tokens hashed at rest (Argon2id preferred, bcrypt acceptable if already standardized).
- Never log raw tokens.
- Compare token hashes in constant time.
- Support token metadata:
  - `token_id`
  - `created_at`, `expires_at`
  - scopes (for example: `mail:read`)
  - owner/integration label (for example: `n8n-prod`)
  - status (`active`, `revoked`)

### Transport and Network Security

- TLS required end-to-end.
- Optional mTLS and/or IP allowlisting for n8n runtime IPs in production.
- CORS locked down (if browser access is not needed, disable it).

### API Security Controls

- Short TTL access token strategy if feasible, or rotating long token with strict expiry.
- Rotation endpoint/process:
  - create new token
  - overlap window
  - revoke old token
- Global and per-token rate limits.
- Brute-force protections and suspicious access alerts.

### Data Security

- Minimize returned data fields by default.
- Redact/omit sensitive headers unless explicitly requested.
- Define retention policy for caches, temp files, and logs.
- Secrets managed via secure secret storage (no plaintext in repo or configs).

## API Authorization Model

- Enforce scope checks on every endpoint.
- Required scopes:
  - `mail:read:folders` — list folders
  - `mail:read:messages` — list/detail messages, download attachments
  - `mail:write` — mark read/unread
  - `mail:send` — send messages
  - `mail:move` — move messages between folders
  - `mail:delete` — trash/delete messages
- Keep scopes least-privilege and assign only what each n8n workflow needs.

## Reliability and Operational Requirements

- Timeouts for downstream calls (SDK/network) with retries and bounded backoff.
- Circuit breaker behavior for repeated upstream failures.
- Health/readiness probes and dependency checks.
- Error taxonomy aligned with stable client handling:
  - `auth_error`
  - `permission_error`
  - `rate_limit_error`
  - `upstream_unavailable`
  - `validation_error`
  - `internal_error`

## Testing and Quality Gates (MUST)

## Coverage

- Target: 100% coverage for all newly introduced business logic modules.
- Minimum enforcement in CI:
  - line coverage: 100% on new modules
  - branch coverage: 100% on new modules
- If full 100% on integration wrappers is impractical, isolate non-deterministic adapters and enforce 100% on deterministic domain logic, with explicit exception list approved in review.

## Test Types

- Unit tests:
  - auth/token validation, scope checks, expiry, revocation.
  - pagination and response mapping logic.
  - error mapping and retry decisions.
  - send payload validation, recipient/header sanitization, attachment constraints.
  - move validation (allowed target folder, ownership checks, idempotent behavior).
  - mark-read/unread state transitions.
  - delete/trash validation and ownership checks.
  - attachment download: content-type negotiation, size limits, streaming.
  - message filtering: date range, sender, unread, hasAttachments query params.
  - SMTP header field mapping: replyTo, envelopeSender, authStatus, listUnsubscribe, replyType.
  - inline attachment Content-ID extraction.
- Integration tests:
  - endpoint auth behavior.
  - n8n-oriented request/response flows.
  - Tuta access layer mocking/stubbing.
  - end-to-end send flow for valid/invalid payloads.
  - end-to-end move flow across supported folders and failure conditions.
  - attachment download round-trip (upload via send, download via detail).
  - mark-read/unread round-trip.
  - delete round-trip and verify folder state.
  - filter queries returning correct subsets.
- Security tests:
  - invalid token, expired token, revoked token, malformed headers.
  - rate-limit and abuse scenarios.
  - unauthorized write attempts (missing `mail:send`, `mail:move`, `mail:write`, or `mail:delete` scope).
  - attachment download size limit enforcement.
  - path traversal attempts on attachment IDs.

## Node/TypeScript Quality Gates (if component is Node-based)

- `tsc --noEmit` must pass.
- Lint must pass with zero errors.
- Formatting must pass (or auto-fix + verify clean).
- Test suite must pass.
- Coverage gate must pass.

Recommended CI check sequence:

1. Typecheck
2. Lint
3. Format check
4. Unit + integration tests
5. Coverage gate

## Non-Node Components

If any part is implemented outside Node/TypeScript, define equivalent strict gates:

- Rust (including `packages/tuta-mail-api-bridge` and `tuta-sdk/rust/sdk`):
  - **CI:** `.github/workflows/rust-test.yml` runs on pull requests that touch `tuta-sdk/**` or `packages/tuta-mail-api-bridge/**` (among other paths) and executes `cargo fmt --check`, `cargo clippy --all --no-deps -- -Dwarnings`, and `cargo test --all` for the workspace (which includes the bridge crate).
  - `cargo fmt --check`
  - `cargo clippy -- -D warnings`
  - `cargo test`
  - coverage tooling configured and enforced for new modules
- Other language runtimes:
  - formatter check
  - linter/static analysis with fail-on-warning policy where reasonable
  - full test pass + coverage gate for new modules

## Implementation Work Breakdown

_Status (2026-04): `packages/tuta-mail-api` (Express API) plus **`packages/tuta-mail-api-bridge`** (Rust `POST /invoke` sidecar using tuta-sdk). See **Standalone API process and Tuta connectivity** and `packages/tuta-mail-api-bridge/README.md`. `GET /v1/health` exposes `mail.mailOperationsReady`. Token hashing is SHA-256 today (Argon2id still planned). **Update:** bridge implements **`downloadAttachment`** (blob read + decrypt), **`loadMails`** cursors as mail `listId/elementId` (Node `nextCursor`) or legacy MailSetEntry CustomId, and **`sendMail`** (draft create + send via SDK)._

### Phase 1: Design
- [x] Finalize endpoint contract and auth scheme
- [x] Define token storage schema and scope model

### Phase 2: Project Scaffolding
- [x] Create project directory structure and build config
- [x] Rust sidecar crate in workspace (`packages/tuta-mail-api-bridge`, root `Cargo.toml` member)
- [x] Set up TypeScript config, linting, and formatting
- [ ] Add dependency on `tuta-sdk` and required packages _(superseded by optional HTTP bridge sidecar + `TUTA_BRIDGE_BASE_URL`; no in-process `tuta-sdk` in Node yet)_
- [x] Set up test framework and coverage tooling _(Node test runner + `tsx`; coverage gate not wired)_

### Phase 3: Security Foundation
- [ ] Implement token issuance and hash storage (Argon2id) _(issuance + SHA-256 at rest; migrate to Argon2id)_
- [x] Implement token verification (constant-time compare)
- [ ] Implement token rotation and revocation _(revocation in store; no rotation playbook / admin API yet)_
- [x] Add auth middleware (bearer token extraction and validation)
- [x] Add scope-checking middleware
- [x] Add rate-limiting middleware

### Phase 4: Mail Access Layer (Tuta SDK Wrapper)
- [x] Implement login/session bootstrap wrapper _(Rust bridge: `Sdk::create_session` with env credentials; Node remains transport-only)_
- [x] Implement mailbox and folder loading _(via `TutaSdkClient` / dev stub / HTTP bridge)_
- [x] Implement message list loading with pagination _(bridge: MailSetEntry + `loadMail`; **cursor** accepts mail id `listId/elementId` for Node `nextCursor`, or legacy MailSetEntry CustomId)_
- [x] Implement message detail loading (decrypt + decompress) _(bridge: `MailDetailsBlob` → JSON fields expected by `TutaMailService`)_
- [x] Implement attachment loading and streaming _(bridge: **`downloadAttachment`** loads `TutanotaFile`, resolves session key, reads blobs via BlobService GET + decrypt; Node route returns full body—no true streaming/chunked response yet)_
- [x] Implement message filtering (date range, sender, unread, hasAttachments)
- [x] Map `Mail` entity to `MessageSummary` DTO (from, subject, receivedAt, sentAt, unread, confidential, state, hasAttachments)
- [x] Map `MailDetails` to `MessageDetail` DTO (to, cc, bcc, replyTo, bodyHtml, bodyText, headers)
- [x] Map SMTP-equivalent fields: `Mail.authStatus` → `authStatus`, `Mail.phishingStatus` → `phishingStatus`, `Mail.differentEnvelopeSender` → `envelopeSender`, `Mail.listUnsubscribe` → `listUnsubscribe`, `Mail.replyType` → `replyType`
- [ ] Extract and map inline attachment Content-IDs for `multipart/related` parity _(attachment `cid` → `contentId` only; full multipart parity pending)_
- [x] Implement mark-read/unread via SDK (`setUnreadStatusForMails`)
- [x] Implement trash via SDK (`trashMails`)
- [x] Implement move via SDK (`simpleMoveMaill`) _(bridge: **trash only** via `simple_move_mail`; archive/spam targets not exposed)_
- [x] Implement send via SDK (draft create + send) _(bridge `sendMail` invoke implemented; smoke-tested via `POST /v1/messages/send`)_

### Phase 5: API Endpoints
- [x] `GET /v1/health` — health check
- [x] `GET /v1/folders` — list folders
- [x] `GET /v1/messages` — list messages with filtering and pagination
- [x] `GET /v1/messages/{id}` — get message detail
- [x] `GET /v1/messages/{id}/attachments/{attachmentId}` — download attachment _(dev stub and **Rust bridge** via `downloadAttachment` invoke)_
- [x] `PATCH /v1/messages/{id}` — mark read/unread
- [x] `DELETE /v1/messages/{id}` — trash message
- [x] `POST /v1/messages/send` — send message _(HTTP route + validation; **tuta + bridge** path wired through bridge `sendMail` invoke)_
- [x] `POST /v1/messages/{id}/move` — move message
- [x] Add input schema validation for all endpoints
- [x] Add query parameter validation for message filtering

### Phase 6: Observability
- [ ] Structured logging with request IDs _(request IDs on requests and error envelopes; no structured logger yet)_
- [x] Standalone readiness: `GET /v1/health` returns `mail` metadata (`kind`, `mailOperationsReady`, `tutaApiUrl`, `detail`) for operators and uptime checks
- [ ] Metrics (request count, latency, error rate)
- [ ] Audit events for write operations (send, move, delete)

### Phase 7: Testing
- [x] Unit tests: auth/token validation, scope checks, expiry, revocation
- [x] Unit tests: mail backend metadata (`getMailBackendMetadata`) and health JSON for dev / tuta-unconfigured
- [ ] Unit tests: pagination and response mapping logic
- [ ] Unit tests: SMTP header field mapping (replyTo, envelopeSender, authStatus, etc.)
- [x] Unit tests: send payload validation, recipient/header sanitization
- [ ] Unit tests: move validation, mark-read/unread, delete _(move/send validation covered; PATCH/DELETE routes not yet covered by integration tests)_
- [ ] Unit tests: message filtering (date range, sender, unread, hasAttachments) _(query parsing only)_
- [ ] Unit tests: attachment download, content-type, size limits, inline Content-ID _(download + size cap covered; no Content-ID / MIME round-trip tests)_
- [x] Integration tests: endpoint auth behavior
- [ ] Integration tests: n8n-oriented request/response flows
- [ ] Integration tests: attachment round-trip, mark-read round-trip, delete round-trip
- [ ] Integration tests: filter queries returning correct subsets
- [ ] Security tests: invalid/expired/revoked tokens, malformed headers _(record-level validation tests; HTTP-level abuse cases thin)_
- [ ] Security tests: rate-limit and abuse scenarios
- [ ] Security tests: unauthorized scope attempts, path traversal on attachment IDs _(insufficient-scope `403` covered in integration tests; path traversal and token abuse scenarios not yet covered)_
- [ ] Enforce 100% coverage for new modules

### Phase 8: CI/CD Gates
- [x] Rust fmt / clippy / test workflow for workspace (includes **`tuta-sdk`** and **`tuta-mail-api-bridge`** on relevant PR paths) — `.github/workflows/rust-test.yml`
- [ ] Add mandatory typecheck job (`tsc --noEmit`) _(package builds with `tsc -b`; not in root `tsconfig` project references yet)_
- [ ] Add lint job (zero errors)
- [ ] Add format check job
- [ ] Add test + coverage gate job
- [ ] Fail build on any gate failure

### Phase 9: Documentation
- [ ] Setup guide for n8n auth header usage and rotation playbook _(local dev runbook added: `.env.mail-api`, Overmind, health, smoke; token rotation playbook still pending)_
- [x] Bridge operator reference — `packages/tuta-mail-api-bridge/README.md` (env vars, build, invoke limitations)
- [ ] Runbook for incident response and key compromise
- [ ] API reference (generated from OpenAPI spec) _(OpenAPI draft in-repo; generation/publish pending)_

## n8n Integration Contract

- n8n must call API over HTTPS with `Authorization: Bearer <token>`.
- Token must be provisioned per environment (dev/stage/prod), not shared.
- Token rotation schedule must be defined (for example every 30-90 days).
- n8n workflow retries should use exponential backoff and respect `429`.
- For send, move, write, and delete operations, use dedicated workflows/tokens with appropriate scopes only when required.

## Acceptance Criteria

- API endpoints return correct mailbox/folder/message data for authorized calls.
- Message detail includes all SMTP-equivalent fields: replyTo, sentAt, envelopeSender, authStatus, phishingStatus, confidential, listUnsubscribe, replyType, inline attachment contentId.
- Attachment download endpoint streams binary content with correct Content-Type and Content-Disposition headers.
- Mark read/unread endpoint toggles the unread flag and returns updated state.
- Delete endpoint trashes the message and returns confirmation.
- Message list filtering by date range, sender, unread status, and hasAttachments returns correct subsets.
- Send endpoint successfully sends supported messages with proper validation and auditing.
- Move endpoint successfully moves messages to authorized folders with idempotent semantics.
- Unauthorized/invalid/expired tokens are consistently rejected.
- Insufficient-scope tokens are rejected for send/move/write/delete endpoints.
- No secrets or raw tokens appear in logs.
- All CI quality gates pass.
- Coverage requirement for new modules is met and enforced automatically.
- Documentation and operational runbook are complete for n8n onboarding.

## OpenAPI Contract (Draft)

This section provides a practical OpenAPI-style contract for rapid implementation and n8n integration.

### Base

- Base URL: `https://<your-domain>/api`
- Version prefix: `/v1`
- Auth: `Authorization: Bearer <token>`
- Content type: `application/json`

### Security Schemes

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: OpaqueToken
```

All endpoints below require `bearerAuth`.

### Shared Schemas

```yaml
components:
  schemas:
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              enum:
                - auth_error
                - permission_error
                - rate_limit_error
                - upstream_unavailable
                - validation_error
                - internal_error
            message:
              type: string
            requestId:
              type: string
    Pagination:
      type: object
      required: [limit, hasMore]
      properties:
        limit:
          type: integer
          minimum: 1
        nextCursor:
          type: string
          nullable: true
        hasMore:
          type: boolean
    Folder:
      type: object
      required: [id, name, kind]
      properties:
        id:
          type: string
        name:
          type: string
        kind:
          type: string
          enum: [inbox, sent, trash, archive, spam, draft, custom, all]
    MessageSummary:
      type: object
      required: [id, subject, receivedAt, unread, folderIds, from]
      properties:
        id:
          type: string
        subject:
          type: string
        receivedAt:
          type: string
          format: date-time
        unread:
          type: boolean
        folderIds:
          type: array
          items:
            type: string
        from:
          $ref: '#/components/schemas/EmailAddress'
    EmailAddress:
      type: object
      required: [address]
      properties:
        name:
          type: string
          nullable: true
        address:
          type: string
          format: email
    MessageSummary:
      type: object
      required: [id, subject, receivedAt, unread, folderIds, from]
      properties:
        id:
          type: string
        subject:
          type: string
        receivedAt:
          type: string
          format: date-time
        sentAt:
          type: string
          format: date-time
        unread:
          type: boolean
        confidential:
          type: boolean
          description: Whether the message is end-to-end encrypted.
        state:
          type: string
          enum: [received, draft, sent]
          description: Mail state (maps from Mail.state).
        hasAttachments:
          type: boolean
        folderIds:
          type: array
          items:
            type: string
        from:
          $ref: '#/components/schemas/EmailAddress'
    MessageDetail:
      allOf:
        - $ref: '#/components/schemas/MessageSummary'
        - type: object
          properties:
            to:
              type: array
              items:
                $ref: '#/components/schemas/EmailAddress'
            cc:
              type: array
              items:
                $ref: '#/components/schemas/EmailAddress'
            bcc:
              type: array
              items:
                $ref: '#/components/schemas/EmailAddress'
            replyTo:
              type: array
              items:
                $ref: '#/components/schemas/EmailAddress'
              description: Reply-To addresses (SMTP Reply-To header equivalent).
            envelopeSender:
              type: string
              nullable: true
              description: Envelope sender if different from From (SMTP Return-Path equivalent).
            authStatus:
              type: string
              nullable: true
              enum: [pass, fail, soft_fail, none, unknown]
              description: SPF/DKIM/DMARC authentication result.
            phishingStatus:
              type: string
              enum: [unknown, suspicious, phishing]
              description: Phishing/spam classification status.
            listUnsubscribe:
              type: boolean
              description: Whether List-Unsubscribe header was present.
            replyType:
              type: string
              enum: [none, reply, reply_all, forward]
              description: How this message relates to a previous message.
            confidential:
              type: boolean
              description: Whether message is end-to-end encrypted.
            bodyHtml:
              type: string
            bodyText:
              type: string
            headers:
              type: object
              additionalProperties:
                type: string
              description: Raw SMTP headers (decompressed from Tuta LZ4 storage).
            attachments:
              type: array
              items:
                type: object
                properties:
                  id:
                    type: string
                  filename:
                    type: string
                  contentType:
                    type: string
                  sizeBytes:
                    type: integer
                  contentId:
                    type: string
                    nullable: true
                    description: Content-ID for inline attachments (MIME multipart/related).
    UpdateMessageRequest:
      type: object
      properties:
        unread:
          type: boolean
          description: Set read/unread status (IMAP \Seen flag equivalent).
    UpdateMessageResponse:
      type: object
      required: [messageId, unread]
      properties:
        messageId:
          type: string
        unread:
          type: boolean
    DeleteMessageResponse:
      type: object
      required: [messageId, trashed]
      properties:
        messageId:
          type: string
        trashed:
          type: boolean
    SendMessageRequest:
      type: object
      required: [to, subject]
      properties:
        from:
          $ref: '#/components/schemas/EmailAddress'
        to:
          type: array
          minItems: 1
          items:
            $ref: '#/components/schemas/EmailAddress'
        cc:
          type: array
          items:
            $ref: '#/components/schemas/EmailAddress'
        bcc:
          type: array
          items:
            $ref: '#/components/schemas/EmailAddress'
        subject:
          type: string
          minLength: 1
        bodyText:
          type: string
        bodyHtml:
          type: string
        replyTo:
          type: array
          items:
            $ref: '#/components/schemas/EmailAddress'
        attachments:
          type: array
          items:
            type: object
            required: [filename, contentType, contentBase64]
            properties:
              filename:
                type: string
              contentType:
                type: string
              contentBase64:
                type: string
    SendMessageResponse:
      type: object
      required: [messageId, status]
      properties:
        messageId:
          type: string
        status:
          type: string
          enum: [queued, sent]
    MoveMessageRequest:
      type: object
      required: [targetFolderId]
      properties:
        targetFolderId:
          type: string
        idempotencyKey:
          type: string
    MoveMessageResponse:
      type: object
      required: [messageId, moved, targetFolderId]
      properties:
        messageId:
          type: string
        moved:
          type: boolean
        targetFolderId:
          type: string
```

### Paths

```yaml
paths:
  /v1/folders:
    get:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:read:folders
      responses:
        '200':
          description: List folders
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '429':
          description: Too Many Requests
  /v1/messages:
    get:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:read:messages
      parameters:
        - in: query
          name: folder
          schema: { type: string }
          required: false
        - in: query
          name: cursor
          schema: { type: string }
          required: false
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
          required: false
        - in: query
          name: since
          schema: { type: string, format: date-time }
          required: false
          description: Filter messages received on or after this date.
        - in: query
          name: before
          schema: { type: string, format: date-time }
          required: false
          description: Filter messages received before this date.
        - in: query
          name: unread
          schema: { type: boolean }
          required: false
          description: Filter by read/unread status.
        - in: query
          name: from
          schema: { type: string }
          required: false
          description: Filter by sender address (substring match).
        - in: query
          name: hasAttachments
          schema: { type: boolean }
          required: false
          description: Filter messages that have attachments.
      responses:
        '200':
          description: Paginated message summaries
        '400':
          description: Validation error
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /v1/messages/{id}:
    get:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:read:messages
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Message detail
        '404':
          description: Not found
    patch:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:write
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateMessageRequest'
      responses:
        '200':
          description: Message updated
        '400':
          description: Validation error
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Not found
    delete:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:delete
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Message trashed
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Not found
  /v1/messages/{id}/attachments/{attachmentId}:
    get:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:read:messages
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
        - in: path
          name: attachmentId
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Attachment binary content (Content-Type from file metadata)
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Not found
        '413':
          description: Attachment exceeds download size limit
  /v1/messages/send:
    post:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:send
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SendMessageRequest'
      responses:
        '200':
          description: Message accepted/sent
        '400':
          description: Validation error
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '413':
          description: Payload too large
        '429':
          description: Too Many Requests
  /v1/messages/{id}/move:
    post:
      security: [{ bearerAuth: [] }]
      x-required-scope: mail:move
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/MoveMessageRequest'
      responses:
        '200':
          description: Message moved
        '400':
          description: Validation error
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Not found
        '409':
          description: Conflict (idempotency/folder state)
```

### Example Requests for n8n

Send:

```http
POST /api/v1/messages/send HTTP/1.1
Authorization: Bearer <token-with-mail:send>
Content-Type: application/json

{
  "to": [{ "address": "ops@example.com", "name": "Ops" }],
  "subject": "Automated alert",
  "bodyText": "A workflow condition has been triggered."
}
```

Move:

```http
POST /api/v1/messages/MAIL_ID_123/move HTTP/1.1
Authorization: Bearer <token-with-mail:move>
Content-Type: application/json

{
  "targetFolderId": "FOLDER_ARCHIVE_1",
  "idempotencyKey": "n8n-{{ $json.executionId }}"
}
```

### Contract Notes

- `x-required-scope` is documentation metadata; enforce this in middleware.
- For `send`, enforce max recipients, max attachment count, max payload size, and content-type allowlist.
- For `move`, validate ownership/visibility of source and target folders.
- For `delete`, trash the message (soft delete); permanent deletion is not exposed.
- For `patch` (mark read/unread), only the `unread` field is mutable.
- For attachment download, set `Content-Disposition: attachment; filename="..."` and `Content-Type` from file metadata. Enforce max download size.
- Message filtering (`since`, `before`, `from`, `unread`, `hasAttachments`) is applied server-side before pagination.
- Return consistent `ErrorEnvelope` for all non-2xx responses.

## Open Decisions

- Token format choice:
  - opaque random token (preferred for server-side control), or
  - signed JWT with strict TTL and rotation.
- Whether mTLS is mandatory in production.
- Final limits for request rate and payload size.

## Next Step

After approval of this plan, create an implementation RFC with:

- exact endpoint schemas,
- auth storage schema migration,
- test matrix,
- CI pipeline updates,
- staged rollout plan (dev -> stage -> production).
