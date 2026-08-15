import { readFileSync } from "node:fs"

/** One account the MCP server can act on, with the bearer token bound to it in the REST API. */
export interface McpAccount {
	/** Account slug, matching the id configured in `tuta-mail-api` (`X-Tuta-Account`). */
	id: string
	/** Optional human-readable label surfaced to the model via `list_accounts`. */
	label: string | null
	/** Bearer token for this account (never surfaced to the model). */
	token: string
}

export interface McpConfig {
	/** Base URL of the `tuta-mail-api` REST service (e.g. `http://127.0.0.1:3100`). */
	baseUrl: string
	/** Request timeout in milliseconds for REST calls. */
	timeoutMs: number
	/** Accounts this server manages (at least one). */
	accounts: McpAccount[]
}

/** Slug rule shared with `tuta-mail-api` account ids. */
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

interface RawAccount {
	id?: unknown
	label?: unknown
	token?: unknown
}

function optionalString(value: unknown): string | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

function normalizeAccount(raw: RawAccount, source: string): McpAccount {
	const id = optionalString(raw.id)
	if (!id) {
		throw new Error(`[tuta-mail-mcp] each account in ${source} requires a non-empty string 'id'`)
	}
	if (!ACCOUNT_ID_PATTERN.test(id)) {
		throw new Error(`[tuta-mail-mcp] invalid account id '${id}' in ${source}: must match ${ACCOUNT_ID_PATTERN}`)
	}
	const token = optionalString(raw.token)
	if (!token) {
		throw new Error(`[tuta-mail-mcp] account '${id}' in ${source} requires a non-empty 'token'`)
	}
	return { id, label: optionalString(raw.label), token }
}

/**
 * Parse the accounts list from `MAIL_API_MCP_ACCOUNTS_FILE` (JSON file path) or
 * `MAIL_API_MCP_ACCOUNTS` (inline JSON). Both accept a bare array or
 * `{ "accounts": [...] }`. Falls back to a single account built from
 * `MAIL_API_TOKEN` (+ optional `MAIL_API_ACCOUNT_ID`, default `default`).
 */
function loadAccounts(env: NodeJS.ProcessEnv): McpAccount[] {
	const filePath = env.MAIL_API_MCP_ACCOUNTS_FILE?.trim()
	const inline = env.MAIL_API_MCP_ACCOUNTS?.trim()

	let rawJson: string | null = null
	let source = ""
	if (filePath) {
		rawJson = readFileSync(filePath, "utf8")
		source = `MAIL_API_MCP_ACCOUNTS_FILE (${filePath})`
	} else if (inline) {
		rawJson = inline
		source = "MAIL_API_MCP_ACCOUNTS"
	}

	if (!rawJson) {
		const token = optionalString(env.MAIL_API_TOKEN)
		if (!token) {
			throw new Error(
				"[tuta-mail-mcp] no accounts configured: set MAIL_API_MCP_ACCOUNTS / MAIL_API_MCP_ACCOUNTS_FILE, or MAIL_API_TOKEN for a single account",
			)
		}
		const id = optionalString(env.MAIL_API_ACCOUNT_ID) ?? "default"
		return [normalizeAccount({ id, token }, "MAIL_API_TOKEN")]
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(rawJson)
	} catch (e) {
		throw new Error(`[tuta-mail-mcp] failed to parse ${source} as JSON: ${e instanceof Error ? e.message : String(e)}`)
	}
	const rawAccounts: unknown = Array.isArray(parsed) ? parsed : (parsed as { accounts?: unknown })?.accounts
	if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
		throw new Error(`[tuta-mail-mcp] ${source} must be a non-empty array of accounts (or { "accounts": [...] })`)
	}

	const accounts = rawAccounts.map((raw) => normalizeAccount(raw as RawAccount, source))
	const seen = new Set<string>()
	for (const acct of accounts) {
		if (seen.has(acct.id)) {
			throw new Error(`[tuta-mail-mcp] duplicate account id '${acct.id}' in ${source}`)
		}
		seen.add(acct.id)
	}
	return accounts
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
	const baseUrlRaw = env.MAIL_API_BASE_URL?.trim() || "http://127.0.0.1:3100"
	const timeoutRaw = Number.parseInt(env.MAIL_API_TIMEOUT_MS ?? "60000", 10)
	return {
		baseUrl: baseUrlRaw.replace(/\/$/, ""),
		timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60000,
		accounts: loadAccounts(env),
	}
}
