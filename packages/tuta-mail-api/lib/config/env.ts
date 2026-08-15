import { readFileSync } from "node:fs"

/**
 * A single Tuta account this API serves. Each account is fronted by its own
 * bridge process (`packages/tuta-mail-api-bridge`), so accounts are isolated
 * by process, port, and SDK cache dir. API tokens are bound to exactly one
 * account by `id` (see {@link TokenRecord.accountId}); the account is implied
 * by the bearer token, so callers never select it per request.
 */
export interface AccountConfig {
	/** Stable slug used in token bindings and `/v1/health`. Never an email address. */
	id: string
	/** Optional human-readable label for operators (surfaced in health). */
	label: string | null
	/** Effective mode for this account (`dev` in-memory stub or `tuta` via bridge). */
	serviceMode: "dev" | "tuta"
	/** Bridge sidecar base URL for this account (required when `serviceMode` is `tuta`). */
	bridgeBaseUrl: string | null
	/** Optional bearer token sent to this account's bridge. */
	bridgeAuthToken: string | null
	/** Bridge `fetch` timeout in milliseconds. */
	bridgeTimeoutMs: number
	/** Intended Tuta REST host for this account (health/reporting only). */
	tutaApiUrl: string
	/** Optional fixed API token to register at bootstrap, bound to this account. Never logged. */
	bootstrapToken: string | null
}

export interface ApiConfig {
	port: number
	host: string
	/**
	 * Base URL of the Tuta API server (for example `https://app.tuta.com`).
	 * This Node service does not call it for mail yet; it is surfaced for operators, `/v1/health`, and for a future native or sidecar SDK client.
	 */
	tutaApiUrl: string
	/** Max attachment download size in bytes (default 25MB) */
	maxAttachmentBytes: number
	/** Global rate limit: max requests per window */
	rateLimitMax: number
	/** Rate limit window in milliseconds */
	rateLimitWindowMs: number
	/** Which mail service implementation to use */
	serviceMode: "dev" | "tuta"
	/** TTL in milliseconds for idempotency entries */
	idempotencyTtlMs: number
	/**
	 * If set, SQLite is used for API tokens and idempotency keys (survives restarts).
	 * Example: `/var/lib/tuta-mail-api/mail-api.sqlite` or `:memory:` for tests.
	 */
	dbPath: string | null
	/**
	 * When `serviceMode` is `tuta`, base URL of the HTTP bridge sidecar (must expose `POST /invoke`).
	 * If unset, {@link SdkUnavailableClient} is used until a bridge is deployed.
	 * Legacy single-account field; multi-account deployments use {@link ApiConfig.accounts}.
	 */
	tutaBridgeBaseUrl: string | null
	/** Optional bearer token sent to the bridge as `Authorization: Bearer …`. */
	tutaBridgeAuthToken: string | null
	/** Bridge `fetch` timeout in milliseconds. */
	tutaBridgeTimeoutMs: number
	/**
	 * Accounts this API serves. Always contains at least one entry after {@link loadConfig}.
	 * A single-account deployment (legacy env vars only) yields one account with `id: "default"`.
	 */
	accounts?: AccountConfig[]
}

/** Slug rule for account ids: lowercase alphanumeric plus `-`/`_`, starting alphanumeric. */
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

interface RawAccount {
	id?: unknown
	label?: unknown
	serviceMode?: unknown
	bridgeBaseUrl?: unknown
	bridgeAuthToken?: unknown
	bridgeTimeoutMs?: unknown
	tutaApiUrl?: unknown
	token?: unknown
}

function optionalString(value: unknown): string | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

function normalizeAccount(raw: RawAccount, defaults: { serviceMode: "dev" | "tuta"; tutaApiUrl: string; bridgeTimeoutMs: number }): AccountConfig {
	const id = optionalString(raw.id)
	if (!id) {
		throw new Error("[tuta-mail-api] each account requires a non-empty string 'id'")
	}
	if (!ACCOUNT_ID_PATTERN.test(id)) {
		throw new Error(`[tuta-mail-api] invalid account id '${id}': must match ${ACCOUNT_ID_PATTERN}`)
	}
	const serviceMode = raw.serviceMode === "tuta" ? "tuta" : raw.serviceMode === "dev" ? "dev" : defaults.serviceMode
	const bridgeBaseUrl = optionalString(raw.bridgeBaseUrl)?.replace(/\/$/, "") ?? null
	const bridgeTimeoutRaw = typeof raw.bridgeTimeoutMs === "number" ? raw.bridgeTimeoutMs : Number.parseInt(String(raw.bridgeTimeoutMs ?? ""), 10)
	return {
		id,
		label: optionalString(raw.label),
		serviceMode,
		bridgeBaseUrl,
		bridgeAuthToken: optionalString(raw.bridgeAuthToken),
		bridgeTimeoutMs: Number.isFinite(bridgeTimeoutRaw) ? bridgeTimeoutRaw : defaults.bridgeTimeoutMs,
		tutaApiUrl: optionalString(raw.tutaApiUrl) ?? defaults.tutaApiUrl,
		bootstrapToken: optionalString(raw.token),
	}
}

/**
 * Load and validate the accounts list from `MAIL_API_ACCOUNTS_FILE` (path to a JSON
 * file) or `MAIL_API_ACCOUNTS` (inline JSON). Both accept either a bare array of
 * accounts or `{ "accounts": [...] }`. When neither is set, a single `default`
 * account is synthesized from the legacy single-account env vars so existing
 * deployments keep working unchanged.
 */
function loadAccounts(
	config: Pick<ApiConfig, "serviceMode" | "tutaApiUrl" | "tutaBridgeTimeoutMs" | "tutaBridgeBaseUrl" | "tutaBridgeAuthToken">,
): AccountConfig[] {
	const defaults = { serviceMode: config.serviceMode, tutaApiUrl: config.tutaApiUrl, bridgeTimeoutMs: config.tutaBridgeTimeoutMs }
	const filePath = process.env.MAIL_API_ACCOUNTS_FILE?.trim()
	const inline = process.env.MAIL_API_ACCOUNTS?.trim()

	let rawJson: string | null = null
	let source = ""
	if (filePath) {
		rawJson = readFileSync(filePath, "utf8")
		source = `MAIL_API_ACCOUNTS_FILE (${filePath})`
	} else if (inline) {
		rawJson = inline
		source = "MAIL_API_ACCOUNTS"
	}

	if (!rawJson) {
		// Backward-compatible single-account default from legacy env vars.
		return [
			{
				id: "default",
				label: null,
				serviceMode: config.serviceMode,
				bridgeBaseUrl: config.tutaBridgeBaseUrl,
				bridgeAuthToken: config.tutaBridgeAuthToken,
				bridgeTimeoutMs: config.tutaBridgeTimeoutMs,
				tutaApiUrl: config.tutaApiUrl,
				bootstrapToken: optionalString(process.env.TUTA_MAIL_API_TOKEN),
			},
		]
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(rawJson)
	} catch (e) {
		throw new Error(`[tuta-mail-api] failed to parse ${source} as JSON: ${e instanceof Error ? e.message : String(e)}`)
	}
	const rawAccounts: unknown = Array.isArray(parsed) ? parsed : (parsed as { accounts?: unknown })?.accounts
	if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
		throw new Error(`[tuta-mail-api] ${source} must be a non-empty array of accounts (or { "accounts": [...] })`)
	}

	const accounts = rawAccounts.map((raw) => normalizeAccount(raw as RawAccount, defaults))
	const seen = new Set<string>()
	for (const acct of accounts) {
		if (seen.has(acct.id)) {
			throw new Error(`[tuta-mail-api] duplicate account id '${acct.id}' in ${source}`)
		}
		seen.add(acct.id)
	}
	return accounts
}

export function loadConfig(): ApiConfig {
	const portRaw = process.env.PORT ?? process.env.MAIL_API_PORT ?? "3100"
	const port = Number.parseInt(portRaw, 10)
	const base = {
		port: Number.isFinite(port) ? port : 3100,
		host: process.env.HOST ?? process.env.MAIL_API_HOST ?? "127.0.0.1",
		tutaApiUrl: process.env.TUTA_API_URL ?? "https://app.tuta.com",
		maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? String(25 * 1024 * 1024), 10),
		rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
		rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
		serviceMode: (process.env.MAIL_API_SERVICE_MODE === "tuta" ? "tuta" : "dev") as "dev" | "tuta",
		idempotencyTtlMs: parseInt(process.env.IDEMPOTENCY_TTL_MS ?? String(24 * 60 * 60 * 1000), 10),
		dbPath: process.env.MAIL_API_DB_PATH?.trim() ? process.env.MAIL_API_DB_PATH.trim() : null,
		tutaBridgeBaseUrl: process.env.TUTA_BRIDGE_BASE_URL?.trim() ? process.env.TUTA_BRIDGE_BASE_URL.trim().replace(/\/$/, "") : null,
		tutaBridgeAuthToken: process.env.TUTA_BRIDGE_AUTH_TOKEN?.trim() ? process.env.TUTA_BRIDGE_AUTH_TOKEN.trim() : null,
		tutaBridgeTimeoutMs: parseInt(process.env.TUTA_BRIDGE_TIMEOUT_MS ?? "60000", 10),
	}
	return { ...base, accounts: loadAccounts(base) }
}
