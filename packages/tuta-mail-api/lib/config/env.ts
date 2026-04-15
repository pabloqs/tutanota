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
	 */
	tutaBridgeBaseUrl: string | null
	/** Optional bearer token sent to the bridge as `Authorization: Bearer …`. */
	tutaBridgeAuthToken: string | null
	/** Bridge `fetch` timeout in milliseconds. */
	tutaBridgeTimeoutMs: number
}

export function loadConfig(): ApiConfig {
	const portRaw = process.env.PORT ?? process.env.MAIL_API_PORT ?? "3100"
	const port = Number.parseInt(portRaw, 10)
	return {
		port: Number.isFinite(port) ? port : 3100,
		host: process.env.HOST ?? process.env.MAIL_API_HOST ?? "127.0.0.1",
		tutaApiUrl: process.env.TUTA_API_URL ?? "https://app.tuta.com",
		maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? String(25 * 1024 * 1024), 10),
		rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
		rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
		serviceMode: process.env.MAIL_API_SERVICE_MODE === "tuta" ? "tuta" : "dev",
		idempotencyTtlMs: parseInt(process.env.IDEMPOTENCY_TTL_MS ?? String(24 * 60 * 60 * 1000), 10),
		dbPath: process.env.MAIL_API_DB_PATH?.trim() ? process.env.MAIL_API_DB_PATH.trim() : null,
		tutaBridgeBaseUrl: process.env.TUTA_BRIDGE_BASE_URL?.trim() ? process.env.TUTA_BRIDGE_BASE_URL.trim().replace(/\/$/, "") : null,
		tutaBridgeAuthToken: process.env.TUTA_BRIDGE_AUTH_TOKEN?.trim() ? process.env.TUTA_BRIDGE_AUTH_TOKEN.trim() : null,
		tutaBridgeTimeoutMs: parseInt(process.env.TUTA_BRIDGE_TIMEOUT_MS ?? "60000", 10),
	}
}
