import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ApiConfig } from "../lib/config/env.js"
import { createApp } from "../lib/app.js"
import { generateToken } from "../lib/auth/token.js"
import { TokenStore } from "../lib/auth/tokenStore.js"
import { DevMailService } from "../lib/services/devMailService.js"
import { createMailService } from "../lib/services/factory.js"
import type { MailService } from "../lib/services/mailService.js"

const cfg: ApiConfig = {
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

type BridgeHandlerResult =
	| { ok: true; data: unknown }
	| { ok: false; message: string; errorCode?: string }

async function startBridgeServer(
	handler: (method: string, params: unknown) => BridgeHandlerResult,
): Promise<{ server: Server; baseUrl: string }> {
	return await new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method !== "POST" || req.url !== "/invoke") {
				res.writeHead(404).end()
				return
			}
			let buf = ""
			req.on("data", (c) => {
				buf += c
			})
			req.on("end", () => {
				try {
					const body = JSON.parse(buf) as { method: string; params: unknown }
					const out = handler(body.method, body.params)
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify(out))
				} catch {
					res.writeHead(500).end()
				}
			})
		})
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo
			resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
		})
	})
}

async function withServer(
	tokenScopes: Parameters<typeof generateToken>[0],
	run: (base: string, headers: Record<string, string>) => Promise<void>,
) {
	const store = new TokenStore()
	const { rawToken, record } = generateToken(tokenScopes, "test", 60_000)
	store.add(record)
	const app = createApp(new DevMailService(), store, cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const base = `http://127.0.0.1:${address.port}`
	try {
		await run(base, { Authorization: `Bearer ${rawToken}`, "Content-Type": "application/json" })
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}

async function startServer(app: ReturnType<typeof createApp>): Promise<Server> {
	return await new Promise<Server>((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server))
	})
}

test("health endpoint works without auth", async () => {
	const app = createApp(new DevMailService(), new TokenStore(), cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`)
	assert.equal(response.status, 200)
	const body = (await response.json()) as {
		status: string
		mail: { kind: string; mailOperationsReady: boolean; serviceMode: string }
	}
	assert.equal(body.status, "ok")
	assert.equal(body.mail.kind, "dev_stub")
	assert.equal(body.mail.serviceMode, "dev")
	assert.equal(body.mail.mailOperationsReady, true)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("health reports tuta mode without bridge as not ready", async () => {
	const app = createApp(new DevMailService(), new TokenStore(), { ...cfg, serviceMode: "tuta", tutaBridgeBaseUrl: null })
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`)
	assert.equal(response.status, 200)
	const body = (await response.json()) as { mail: { kind: string; mailOperationsReady: boolean } }
	assert.equal(body.mail.kind, "tuta_unconfigured")
	assert.equal(body.mail.mailOperationsReady, false)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("protected endpoint requires auth", async () => {
	const app = createApp(new DevMailService(), new TokenStore(), cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/folders`)
	assert.equal(response.status, 401)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("list folders succeeds with scope", async () => {
	await withServer(["mail:read:folders"], async (base, headers) => {
		const response = await fetch(`${base}/v1/folders`, { headers })
		assert.equal(response.status, 200)
	})
})

test("send requires send scope", async () => {
	await withServer(["mail:read:messages"], async (base, headers) => {
		const denied = await fetch(`${base}/v1/messages/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ to: [{ address: "a@b.com" }], subject: "x", bodyText: "hello" }),
		})
		assert.equal(denied.status, 403)
	})
})

test("send and move succeed with scopes", async () => {
	await withServer(["mail:send", "mail:move"], async (base, headers) => {
		const send = await fetch(`${base}/v1/messages/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ to: [{ address: "a@b.com" }], subject: "ok", bodyText: "hello" }),
		})
		assert.equal(send.status, 200)

		const move = await fetch(`${base}/v1/messages/msg-1/move`, {
			method: "POST",
			headers,
			body: JSON.stringify({ targetFolderId: "archive" }),
		})
		assert.equal(move.status, 200)
	})
})

test("tuta service mode returns upstream_unavailable until adapter wired", async () => {
	const store = new TokenStore()
	const { rawToken, record } = generateToken(["mail:read:folders"], "test", 60_000)
	store.add(record)
	const mailService = createMailService({ ...cfg, serviceMode: "tuta", tutaBridgeBaseUrl: null })
	const app = createApp(mailService, store, cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/folders`, {
		headers: { Authorization: `Bearer ${rawToken}` },
	})
	assert.equal(response.status, 503)
	const body = (await response.json()) as { error: { code: string } }
	assert.equal(body.error.code, "upstream_unavailable")
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("tuta service mode with HTTP bridge lists folders", async () => {
	const { server: bridgeServer, baseUrl: bridgeBase } = await startBridgeServer((method) => {
		if (method === "loadFolders") {
			return { ok: true, data: [{ id: "inbox", name: "Inbox", folderType: 1 }] }
		}
		return { ok: false, message: `unexpected method ${method}` }
	})
	try {
		const store = new TokenStore()
		const { rawToken, record } = generateToken(["mail:read:folders"], "test", 60_000)
		store.add(record)
		const mailService = createMailService({
			...cfg,
			serviceMode: "tuta",
			tutaBridgeBaseUrl: bridgeBase,
			tutaBridgeAuthToken: null,
		})
		const app = createApp(mailService, store, cfg)
		const apiServer = await startServer(app)
		const address = apiServer.address() as AddressInfo
		const response = await fetch(`http://127.0.0.1:${address.port}/v1/folders`, {
			headers: { Authorization: `Bearer ${rawToken}` },
		})
		assert.equal(response.status, 200)
		const body = (await response.json()) as { data: { id: string; name: string; kind: string }[] }
		assert.equal(body.data.length, 1)
		assert.equal(body.data[0].id, "inbox")
		assert.equal(body.data[0].kind, "inbox")
		await new Promise<void>((resolve) => apiServer.close(() => resolve()))
	} finally {
		await new Promise<void>((resolve) => bridgeServer.close(() => resolve()))
	}
})

test("tuta bridge returns upstream_unavailable when invoke reports failure", async () => {
	const { server: bridgeServer, baseUrl: bridgeBase } = await startBridgeServer(() => ({
		ok: false,
		message: "session expired",
	}))
	try {
		const store = new TokenStore()
		const { rawToken, record } = generateToken(["mail:read:folders"], "test", 60_000)
		store.add(record)
		const mailService = createMailService({ ...cfg, serviceMode: "tuta", tutaBridgeBaseUrl: bridgeBase })
		const app = createApp(mailService, store, cfg)
		const apiServer = await startServer(app)
		const address = apiServer.address() as AddressInfo
		const response = await fetch(`http://127.0.0.1:${address.port}/v1/folders`, {
			headers: { Authorization: `Bearer ${rawToken}` },
		})
		assert.equal(response.status, 503)
		const body = (await response.json()) as { error: { code: string; message: string } }
		assert.equal(body.error.code, "upstream_unavailable")
		assert.match(body.error.message, /session expired/)
		await new Promise<void>((resolve) => apiServer.close(() => resolve()))
	} finally {
		await new Promise<void>((resolve) => bridgeServer.close(() => resolve()))
	}
})

test("tuta bridge external_secure_send_unavailable maps to HTTP 422", async () => {
	const { server: bridgeServer, baseUrl: bridgeBase } = await startBridgeServer((method) => {
		if (method === "sendMail") {
			return {
				ok: false,
				message: "Password-protected external sending is not available for x@example.com",
				errorCode: "external_secure_send_unavailable",
			}
		}
		return { ok: false, message: `unexpected method ${method}` }
	})
	try {
		const store = new TokenStore()
		const { rawToken, record } = generateToken(["mail:send"], "test", 60_000)
		store.add(record)
		const mailService = createMailService({ ...cfg, serviceMode: "tuta", tutaBridgeBaseUrl: bridgeBase })
		const app = createApp(mailService, store, cfg)
		const apiServer = await startServer(app)
		const address = apiServer.address() as AddressInfo
		const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages/send`, {
			method: "POST",
			headers: { Authorization: `Bearer ${rawToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ to: [{ address: "x@example.com" }], subject: "s", bodyText: "b" }),
		})
		assert.equal(response.status, 422)
		const body = (await response.json()) as { error: { code: string; message: string } }
		assert.equal(body.error.code, "external_secure_send_unavailable")
		assert.match(body.error.message, /Password-protected external sending/)
		await new Promise<void>((resolve) => apiServer.close(() => resolve()))
	} finally {
		await new Promise<void>((resolve) => bridgeServer.close(() => resolve()))
	}
})

test("attachment download succeeds and returns binary response", async () => {
	await withServer(["mail:read:messages"], async (base, headers) => {
		const response = await fetch(`${base}/v1/messages/msg-1/attachments/att-1`, { headers })
		assert.equal(response.status, 200)
		assert.equal(response.headers.get("content-type"), "text/plain")
		assert.match(response.headers.get("content-disposition") ?? "", /welcome\.txt/)
		const body = await response.text()
		assert.equal(body, "welcome")
	})
})

test("attachment download enforces max size", async () => {
	const store = new TokenStore()
	const { rawToken, record } = generateToken(["mail:read:messages"], "test", 60_000)
	store.add(record)
	const oversizedService: MailService = {
		...(new DevMailService()),
		async downloadAttachment() {
			return {
				data: Buffer.alloc(20),
				filename: "too-big.bin",
				contentType: "application/octet-stream",
			}
		},
	}
	const app = createApp(oversizedService, store, { ...cfg, maxAttachmentBytes: 10 })
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages/msg-1/attachments/att-1`, {
		headers: { Authorization: `Bearer ${rawToken}` },
	})
	assert.equal(response.status, 413)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("send endpoint honors Idempotency-Key header", async () => {
	let sendCount = 0
	const store = new TokenStore()
	const { rawToken, record } = generateToken(["mail:send"], "test", 60_000)
	store.add(record)
	const countingService: MailService = {
		...(new DevMailService()),
		async sendMessage(request) {
			sendCount++
			return { messageId: `id-${request.subject}`, status: "sent" }
		},
	}
	const app = createApp(countingService, store, cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const url = `http://127.0.0.1:${address.port}/v1/messages/send`
	const headers = {
		Authorization: `Bearer ${rawToken}`,
		"Content-Type": "application/json",
		"Idempotency-Key": "same-op",
	}
	const body = JSON.stringify({ to: [{ address: "a@b.com" }], subject: "s1", bodyText: "body" })
	const a = await fetch(url, { method: "POST", headers, body })
	const b = await fetch(url, { method: "POST", headers, body })
	assert.equal(a.status, 200)
	assert.equal(b.status, 200)
	assert.equal(sendCount, 1)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("move endpoint honors idempotencyKey in body", async () => {
	let moveCount = 0
	const store = new TokenStore()
	const { rawToken, record } = generateToken(["mail:move"], "test", 60_000)
	store.add(record)
	const countingService: MailService = {
		...(new DevMailService()),
		async moveMessage(id, request) {
			moveCount++
			return { messageId: id, moved: true, targetFolderId: request.targetFolderId }
		},
	}
	const app = createApp(countingService, store, cfg)
	const server = await startServer(app)
	const address = server.address() as AddressInfo
	const url = `http://127.0.0.1:${address.port}/v1/messages/msg-1/move`
	const headers = {
		Authorization: `Bearer ${rawToken}`,
		"Content-Type": "application/json",
	}
	const body = JSON.stringify({ targetFolderId: "archive", idempotencyKey: "move-key-1" })
	const a = await fetch(url, { method: "POST", headers, body })
	const b = await fetch(url, { method: "POST", headers, body })
	assert.equal(a.status, 200)
	assert.equal(b.status, 200)
	assert.equal(moveCount, 1)
	await new Promise<void>((resolve) => server.close(() => resolve()))
})
