import { loadConfig } from "./config/env.js"
import { getMailBackendMetadata } from "./config/mailBackendMetadata.js"
import { randomBytes } from "node:crypto"
import { generateToken, hashToken } from "./auth/token.js"
import { TokenStore } from "./auth/tokenStore.js"
import { SqliteTokenStore } from "./auth/sqliteTokenStore.js"
import { openMailApiDatabase } from "./db/mailApiSqlite.js"
import { MemoryIdempotencyStore } from "./idempotency/idempotencyStore.js"
import { SqliteIdempotencyStore } from "./idempotency/sqliteIdempotencyStore.js"
import { createApp, type AppStoreOptions } from "./app.js"
import { createMailService } from "./services/factory.js"
import type { ITokenStore } from "./auth/tokenStore.js"
import type { MoveMessageResponse, SendMessageResponse, TokenRecord } from "./dto/types.js"

const config = loadConfig()
const mailService = createMailService(config)
const mailMeta = getMailBackendMetadata(config)
if (!mailMeta.mailOperationsReady) {
	console.warn(`[tuta-mail-api] ${mailMeta.detail}`)
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
	const scopes = ["mail:read:folders", "mail:read:messages", "mail:write", "mail:send", "mail:move", "mail:delete"] as const
	// Fixed env tokens are long-lived service credentials; random bootstrap tokens stay 24h.
	const fixedRaw = process.env.TUTA_MAIL_API_TOKEN?.trim()
	const ttlMs = fixedRaw ? 10 * 365 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
	if (fixedRaw) {
		const now = new Date()
		const record: TokenRecord = {
			tokenId: randomBytes(16).toString("hex"),
			tokenHash: hashToken(fixedRaw),
			createdAt: now,
			expiresAt: new Date(now.getTime() + ttlMs),
			scopes: [...scopes],
			ownerLabel: "bootstrap",
			status: "active",
		}
		tokenStore.add(record)
		console.log("[tuta-mail-api] bootstrap: registered TUTA_MAIL_API_TOKEN from environment (value not logged)")
	} else {
		const { rawToken, record } = generateToken([...scopes], "bootstrap", ttlMs)
		tokenStore.add(record)
		console.log("Bootstrap token (store securely):", rawToken)
	}
}

const app = createApp(mailService, tokenStore, config, storeOptions)
app.listen(config.port, config.host, () => {
	console.log(`[tuta-mail-api] http://${config.host}:${config.port} | mailBackend=${mailMeta.kind} | tutaApiUrl=${mailMeta.tutaApiUrl}`)
})
