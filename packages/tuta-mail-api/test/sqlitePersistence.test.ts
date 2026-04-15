import test from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { openMailApiDatabase } from "../lib/db/mailApiSqlite.js"
import { SqliteTokenStore } from "../lib/auth/sqliteTokenStore.js"
import { SqliteIdempotencyStore } from "../lib/idempotency/sqliteIdempotencyStore.js"
import { generateToken } from "../lib/auth/token.js"
import { createApp } from "../lib/app.js"
import type { ApiConfig } from "../lib/config/env.js"
import { DevMailService } from "../lib/services/devMailService.js"
import type { SendMessageRequest, SendMessageResponse } from "../lib/dto/types.js"

const cfg: ApiConfig = {
	port: 0,
	host: "127.0.0.1",
	tutaApiUrl: "https://app.tuta.com",
	maxAttachmentBytes: 10_000_000,
	rateLimitMax: 100,
	rateLimitWindowMs: 60_000,
	serviceMode: "dev",
	idempotencyTtlMs: 60_000,
	dbPath: ":memory:",
	tutaBridgeBaseUrl: null,
	tutaBridgeAuthToken: null,
	tutaBridgeTimeoutMs: 60_000,
}

async function startServer(app: ReturnType<typeof createApp>): Promise<Server> {
	return await new Promise<Server>((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server))
	})
}

test("SqliteTokenStore persists token lookup", () => {
	const db = openMailApiDatabase(":memory:")
	const store = new SqliteTokenStore(db)
	const { rawToken, record } = generateToken(["mail:send"], "sqlite-test", 60_000)
	store.add(record)
	const found = store.findByRawToken(rawToken)
	assert.ok(found)
	assert.equal(found?.tokenId, record.tokenId)
	assert.ok(store.revoke(record.tokenId))
	const after = store.findByRawToken(rawToken)
	assert.equal(after, null)
})

test("Sqlite idempotency survives across two app instances on same db file", async () => {
	const path = `:memory:`
	const db = openMailApiDatabase(path)
	const tokenStore = new SqliteTokenStore(db)
	const { rawToken, record } = generateToken(["mail:send"], "idem", 60_000)
	tokenStore.add(record)

	const sendStore = new SqliteIdempotencyStore<{ messageId: string; status: "sent" }>(db, cfg.idempotencyTtlMs)
	const moveStore = new SqliteIdempotencyStore<{ messageId: string; moved: boolean; targetFolderId: string }>(db, cfg.idempotencyTtlMs)

	let sendCalls = 0
	class CountingSendService extends DevMailService {
		override async sendMessage(_request: SendMessageRequest): Promise<SendMessageResponse> {
			sendCalls++
			return { messageId: "persisted-id", status: "sent" }
		}
	}
	const countingService = new CountingSendService()

	const app1 = createApp(countingService, tokenStore, cfg, {
		sendIdempotency: sendStore,
		moveIdempotency: moveStore,
	})
	const server1 = await startServer(app1)
	const address1 = server1.address() as AddressInfo
	const url = `http://127.0.0.1:${address1.port}/v1/messages/send`
	const headers = {
		Authorization: `Bearer ${rawToken}`,
		"Content-Type": "application/json",
		"Idempotency-Key": "idem-sqlite",
	}
	const body = JSON.stringify({ to: [{ address: "a@b.com" }], subject: "s", bodyText: "b" })
	const r1 = await fetch(url, { method: "POST", headers, body })
	assert.equal(r1.status, 200)
	await new Promise<void>((resolve) => server1.close(() => resolve()))

	const app2 = createApp(countingService, tokenStore, cfg, {
		sendIdempotency: sendStore,
		moveIdempotency: moveStore,
	})
	const server2 = await startServer(app2)
	const address2 = server2.address() as AddressInfo
	const url2 = `http://127.0.0.1:${address2.port}/v1/messages/send`
	const r2 = await fetch(url2, { method: "POST", headers, body })
	assert.equal(r2.status, 200)
	const j2 = (await r2.json()) as { data: { messageId: string } }
	assert.equal(j2.data.messageId, "persisted-id")
	assert.equal(sendCalls, 1)
	await new Promise<void>((resolve) => server2.close(() => resolve()))
})
