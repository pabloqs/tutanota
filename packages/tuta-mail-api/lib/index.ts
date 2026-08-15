import { loadConfig, type AccountConfig } from "./config/env.js"
import { getAccountBackendMetadata } from "./config/mailBackendMetadata.js"
import { randomBytes } from "node:crypto"
import { generateToken, hashToken } from "./auth/token.js"
import { TokenStore } from "./auth/tokenStore.js"
import { SqliteTokenStore } from "./auth/sqliteTokenStore.js"
import { openMailApiDatabase } from "./db/mailApiSqlite.js"
import { MemoryIdempotencyStore } from "./idempotency/idempotencyStore.js"
import { SqliteIdempotencyStore } from "./idempotency/sqliteIdempotencyStore.js"
import { createApp, type AppStoreOptions } from "./app.js"
import { createMailServiceRegistry } from "./services/factory.js"
import type { ITokenStore } from "./auth/tokenStore.js"
import type { MoveMessageResponse, SendMessageResponse, Scope, TokenRecord } from "./dto/types.js"

const config = loadConfig()
const registry = createMailServiceRegistry(config)
const accounts: AccountConfig[] = config.accounts ?? []

for (const account of accounts) {
	const meta = getAccountBackendMetadata(account)
	const label = account.label ? ` (${account.label})` : ""
	if (!meta.mailOperationsReady) {
		console.warn(`[tuta-mail-api] account '${account.id}'${label}: ${meta.detail}`)
	} else {
		console.log(`[tuta-mail-api] account '${account.id}'${label}: mailBackend=${meta.kind}`)
	}
}

let tokenStore: ITokenStore
let storeOptions: AppStoreOptions

if (config.dbPath) {
	const db = openMailApiDatabase(config.dbPath)
	tokenStore = new SqliteTokenStore(db)
	storeOptions = {
		sendIdempotency: new SqliteIdempotencyStore<SendMessageResponse>(db, config.idempotencyTtlMs),
		moveIdempotency: new SqliteIdempotencyStore<MoveMessageResponse>(db, config.idempotencyTtlMs),
	}
} else {
	tokenStore = new TokenStore()
	storeOptions = {
		sendIdempotency: new MemoryIdempotencyStore<SendMessageResponse>(config.idempotencyTtlMs),
		moveIdempotency: new MemoryIdempotencyStore<MoveMessageResponse>(config.idempotencyTtlMs),
	}
}

if (process.env.BOOTSTRAP_TOKEN === "true") {
	const scopes: Scope[] = ["mail:read:folders", "mail:read:messages", "mail:write", "mail:send", "mail:move", "mail:delete"]
	// Fixed per-account tokens are long-lived service credentials; random bootstrap tokens stay 24h.
	const fixedTtlMs = 10 * 365 * 24 * 60 * 60 * 1000
	const randomTtlMs = 24 * 60 * 60 * 1000
	for (const account of accounts) {
		const fixedRaw = account.bootstrapToken
		if (fixedRaw) {
			const now = new Date()
			const record: TokenRecord = {
				tokenId: randomBytes(16).toString("hex"),
				tokenHash: hashToken(fixedRaw),
				createdAt: now,
				expiresAt: new Date(now.getTime() + fixedTtlMs),
				scopes: [...scopes],
				ownerLabel: `bootstrap:${account.id}`,
				status: "active",
				accountId: account.id,
			}
			tokenStore.add(record)
			console.log(`[tuta-mail-api] bootstrap: registered fixed token for account '${account.id}' from config (value not logged)`)
		} else {
			const { rawToken, record } = generateToken([...scopes], `bootstrap:${account.id}`, randomTtlMs, account.id)
			tokenStore.add(record)
			console.log(`Bootstrap token for account '${account.id}' (store securely):`, rawToken)
		}
	}
}

const app = createApp(registry, tokenStore, config, storeOptions)
app.listen(config.port, config.host, () => {
	console.log(`[tuta-mail-api] http://${config.host}:${config.port} | accounts=${accounts.map((a) => a.id).join(",")}`)
})
