import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { loadConfig, type ApiConfig } from "../lib/config/env.js"
import { createApp } from "../lib/app.js"
import { createMailServiceRegistry, type MailServiceRegistry } from "../lib/services/factory.js"
import { DevMailService } from "../lib/services/devMailService.js"
import { generateToken, hashToken } from "../lib/auth/token.js"
import { TokenStore } from "../lib/auth/tokenStore.js"
import { SqliteTokenStore } from "../lib/auth/sqliteTokenStore.js"
import { openMailApiDatabase } from "../lib/db/mailApiSqlite.js"
import type { Folder } from "../lib/dto/types.js"

const baseCfg: ApiConfig = {
	port: 0,
	host: "127.0.0.1",
	tutaApiUrl: "https://app.tuta.com",
	maxAttachmentBytes: 10_000_000,
	rateLimitMax: 100,
	rateLimitWindowMs: 60_000,
	serviceMode: "dev",
	idempotencyTtlMs: 60_000,
	dbPath: null,
	tutaBridgeBaseUrl: null,
	tutaBridgeAuthToken: null,
	tutaBridgeTimeoutMs: 60_000,
}

/** A mail service whose folder list identifies the account it belongs to. */
class MarkerMailService extends DevMailService {
	constructor(private readonly marker: string) {
		super()
	}
	override async listFolders(): Promise<Folder[]> {
		return [{ id: this.marker, name: this.marker, kind: "inbox" }]
	}
}

async function startServer(app: ReturnType<typeof createApp>): Promise<Server> {
	return await new Promise<Server>((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server))
	})
}

/** Run `fn` with the given env overrides applied, restoring the prior environment after. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const keys = [
		"MAIL_API_ACCOUNTS",
		"MAIL_API_ACCOUNTS_FILE",
		"MAIL_API_SERVICE_MODE",
		"TUTA_BRIDGE_BASE_URL",
		"TUTA_BRIDGE_AUTH_TOKEN",
		"TUTA_API_URL",
		"TUTA_MAIL_API_TOKEN",
		...Object.keys(overrides),
	]
	const prev = new Map<string, string | undefined>()
	for (const k of keys) prev.set(k, process.env[k])
	// Clear the relevant keys first so leftover env doesn't leak into the test.
	for (const k of keys) delete process.env[k]
	for (const [k, v] of Object.entries(overrides)) {
		if (v !== undefined) process.env[k] = v
	}
	try {
		await fn()
	} finally {
		for (const [k, v] of prev) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
}

test("loadConfig: synthesizes a single 'default' account from legacy env", async () => {
	await withEnv({ MAIL_API_SERVICE_MODE: "tuta", TUTA_BRIDGE_BASE_URL: "http://127.0.0.1:4711/", TUTA_MAIL_API_TOKEN: "legacy-token" }, () => {
		const cfg = loadConfig()
		assert.equal(cfg.accounts?.length, 1)
		const acct = cfg.accounts![0]
		assert.equal(acct.id, "default")
		assert.equal(acct.serviceMode, "tuta")
		assert.equal(acct.bridgeBaseUrl, "http://127.0.0.1:4711")
		assert.equal(acct.bootstrapToken, "legacy-token")
	})
})

test("loadConfig: parses inline MAIL_API_ACCOUNTS array", async () => {
	const accounts = JSON.stringify([
		{ id: "work", label: "Work", serviceMode: "tuta", bridgeBaseUrl: "http://127.0.0.1:4711", token: "tok-work" },
		{ id: "personal", serviceMode: "dev" },
	])
	await withEnv({ MAIL_API_ACCOUNTS: accounts }, () => {
		const cfg = loadConfig()
		assert.equal(cfg.accounts?.length, 2)
		assert.equal(cfg.accounts![0].id, "work")
		assert.equal(cfg.accounts![0].label, "Work")
		assert.equal(cfg.accounts![0].bridgeBaseUrl, "http://127.0.0.1:4711")
		assert.equal(cfg.accounts![0].bootstrapToken, "tok-work")
		assert.equal(cfg.accounts![1].id, "personal")
		assert.equal(cfg.accounts![1].serviceMode, "dev")
	})
})

test("loadConfig: accepts { accounts: [...] } wrapper and a file source", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tuta-accounts-"))
	const file = join(dir, "accounts.json")
	writeFileSync(file, JSON.stringify({ accounts: [{ id: "a" }, { id: "b" }] }))
	await withEnv({ MAIL_API_ACCOUNTS_FILE: file }, () => {
		const cfg = loadConfig()
		assert.deepEqual(
			cfg.accounts?.map((a) => a.id),
			["a", "b"],
		)
	})
})

test("loadConfig: rejects duplicate account ids", async () => {
	await withEnv({ MAIL_API_ACCOUNTS: JSON.stringify([{ id: "dup" }, { id: "dup" }]) }, () => {
		assert.throws(() => loadConfig(), /duplicate account id 'dup'/)
	})
})

test("loadConfig: rejects invalid account id slug", async () => {
	await withEnv({ MAIL_API_ACCOUNTS: JSON.stringify([{ id: "Not A Slug" }]) }, () => {
		assert.throws(() => loadConfig(), /invalid account id/)
	})
})

test("createMailServiceRegistry: one service per account, keyed by id", async () => {
	await withEnv({ MAIL_API_ACCOUNTS: JSON.stringify([{ id: "a" }, { id: "b" }]) }, () => {
		const cfg = loadConfig()
		const registry = createMailServiceRegistry(cfg)
		assert.deepEqual([...registry.keys()].sort(), ["a", "b"])
	})
})

test("routing: each token reaches only its own account's service", async () => {
	const registry: MailServiceRegistry = new Map([
		["work", new MarkerMailService("work")],
		["personal", new MarkerMailService("personal")],
	])
	const store = new TokenStore()
	const work = generateToken(["mail:read:folders"], "work", 60_000, "work")
	const personal = generateToken(["mail:read:folders"], "personal", 60_000, "personal")
	store.add(work.record)
	store.add(personal.record)

	const app = createApp(registry, store, baseCfg)
	const server = await startServer(app)
	const { port } = server.address() as AddressInfo
	try {
		const workRes = await fetch(`http://127.0.0.1:${port}/v1/folders`, { headers: { Authorization: `Bearer ${work.rawToken}` } })
		assert.equal(workRes.status, 200)
		assert.equal(workRes.headers.get("x-tuta-account"), "work")
		const workBody = (await workRes.json()) as { data: Folder[] }
		assert.equal(workBody.data[0].id, "work")

		const personalRes = await fetch(`http://127.0.0.1:${port}/v1/folders`, { headers: { Authorization: `Bearer ${personal.rawToken}` } })
		assert.equal(personalRes.status, 200)
		assert.equal(personalRes.headers.get("x-tuta-account"), "personal")
		const personalBody = (await personalRes.json()) as { data: Folder[] }
		assert.equal(personalBody.data[0].id, "personal")
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})

test("routing: token for an unconfigured account yields 500", async () => {
	const registry: MailServiceRegistry = new Map([["work", new MarkerMailService("work")]])
	const store = new TokenStore()
	const ghost = generateToken(["mail:read:folders"], "ghost", 60_000, "missing")
	store.add(ghost.record)
	const app = createApp(registry, store, baseCfg)
	const server = await startServer(app)
	const { port } = server.address() as AddressInfo
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/folders`, { headers: { Authorization: `Bearer ${ghost.rawToken}` } })
		assert.equal(res.status, 500)
		const body = (await res.json()) as { error: { code: string } }
		assert.equal(body.error.code, "internal_error")
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})

test("health: reports per-account backend metadata", async () => {
	const cfg: ApiConfig = {
		...baseCfg,
		accounts: [
			{
				id: "work",
				label: "Work",
				serviceMode: "tuta",
				bridgeBaseUrl: "http://127.0.0.1:4711",
				bridgeAuthToken: null,
				bridgeTimeoutMs: 60_000,
				tutaApiUrl: "https://app.tuta.com",
				bootstrapToken: null,
			},
			{
				id: "personal",
				label: null,
				serviceMode: "dev",
				bridgeBaseUrl: null,
				bridgeAuthToken: null,
				bridgeTimeoutMs: 60_000,
				tutaApiUrl: "https://app.tuta.com",
				bootstrapToken: null,
			},
		],
	}
	const registry = new Map([
		["work", new MarkerMailService("work")],
		["personal", new MarkerMailService("personal")],
	])
	const app = createApp(registry, new TokenStore(), cfg)
	const server = await startServer(app)
	const { port } = server.address() as AddressInfo
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
		assert.equal(res.status, 200)
		const body = (await res.json()) as { status: string; accounts: Array<{ id: string; kind: string; mailOperationsReady: boolean }> }
		assert.equal(body.status, "ok")
		assert.equal(body.accounts.length, 2)
		const work = body.accounts.find((a) => a.id === "work")!
		assert.equal(work.kind, "http_bridge")
		assert.equal(work.mailOperationsReady, true)
		const personal = body.accounts.find((a) => a.id === "personal")!
		assert.equal(personal.kind, "dev_stub")
		// Account ids are slugs, never email addresses, so health stays PII-free.
		assert.ok(!JSON.stringify(body).includes("@"))
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})

test("sqlite: adds account_id column to a pre-multi-account database, defaulting to 'default'", () => {
	const dir = mkdtempSync(join(tmpdir(), "tuta-migrate-"))
	const dbPath = join(dir, "state.sqlite")

	// Simulate an old database created before multi-account support (no account_id column).
	const legacy = new Database(dbPath)
	legacy.exec(`
		CREATE TABLE api_tokens (
			token_id TEXT PRIMARY KEY NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			scopes_json TEXT NOT NULL,
			owner_label TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
		);
	`)
	const now = Date.now()
	legacy
		.prepare(
			`INSERT INTO api_tokens (token_id, token_hash, created_at_ms, expires_at_ms, scopes_json, owner_label, status)
			VALUES (?, ?, ?, ?, ?, ?, 'active')`,
		)
		.run("t1", hashToken("legacy-raw"), now, now + 60_000, JSON.stringify(["mail:send"]), "old")
	legacy.close()

	// Reopen through the migrating opener; account_id should be backfilled to 'default'.
	const db = openMailApiDatabase(dbPath)
	const store = new SqliteTokenStore(db)
	const found = store.findByRawToken("legacy-raw")
	assert.ok(found)
	assert.equal(found?.accountId, "default")

	// New inserts round-trip their bound account.
	const fresh = generateToken(["mail:send"], "new", 60_000, "work")
	store.add(fresh.record)
	assert.equal(store.findByRawToken(fresh.rawToken)?.accountId, "work")
	db.close()
})
