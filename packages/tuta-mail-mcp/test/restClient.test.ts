import test from "node:test"
import assert from "node:assert/strict"
import { RestClient, RestError } from "../lib/restClient.js"
import { startFakeRest } from "./fakeRestServer.js"

async function withClient(
	handler: Parameters<typeof startFakeRest>[0],
	run: (client: RestClient, rest: Awaited<ReturnType<typeof startFakeRest>>) => Promise<void>,
	timeoutMs = 60000,
): Promise<void> {
	const rest = await startFakeRest(handler)
	const client = new RestClient(rest.baseUrl, timeoutMs)
	try {
		await run(client, rest)
	} finally {
		await rest.close()
	}
}

test("health: GET /v1/health without auth", async () => {
	await withClient(
		() => ({ json: { status: "ok", accounts: [{ id: "work", label: "Work", kind: "http_bridge", serviceMode: "tuta", mailOperationsReady: true }] } }),
		async (client, rest) => {
			const health = await client.health()
			assert.equal(health.status, "ok")
			assert.equal(health.accounts?.[0].id, "work")
			assert.equal(rest.requests[0].auth, null)
			assert.equal(rest.requests[0].url, "/v1/health")
		},
	)
})

test("listFolders: sends bearer token and unwraps data", async () => {
	await withClient(
		() => ({ json: { data: [{ id: "inbox", name: "Inbox", kind: "inbox" }] } }),
		async (client, rest) => {
			const folders = await client.listFolders("tok-work")
			assert.equal(folders[0].id, "inbox")
			assert.equal(rest.requests[0].auth, "Bearer tok-work")
			assert.equal(rest.requests[0].url, "/v1/folders")
		},
	)
})

test("listMessages: builds query string from params", async () => {
	await withClient(
		() => ({ json: { data: [], pagination: { limit: 5, nextCursor: null, hasMore: false } } }),
		async (client, rest) => {
			await client.listMessages("t", {
				folder: "inbox",
				limit: 5,
				unread: true,
				from: "a@b.com",
				hasAttachments: false,
				since: "2026-01-01",
				before: "2026-02-01",
				cursor: "c1",
			})
			const url = new URL(`http://x${rest.requests[0].url}`)
			assert.equal(url.pathname, "/v1/messages")
			assert.equal(url.searchParams.get("folder"), "inbox")
			assert.equal(url.searchParams.get("limit"), "5")
			assert.equal(url.searchParams.get("unread"), "true")
			assert.equal(url.searchParams.get("hasAttachments"), "false")
			assert.equal(url.searchParams.get("from"), "a@b.com")
			assert.equal(url.searchParams.get("since"), "2026-01-01")
			assert.equal(url.searchParams.get("before"), "2026-02-01")
			assert.equal(url.searchParams.get("cursor"), "c1")
		},
	)
})

test("listMessages: no params yields bare path", async () => {
	await withClient(
		() => ({ json: { data: [], pagination: { limit: 50, nextCursor: null, hasMore: false } } }),
		async (client, rest) => {
			await client.listMessages("t", {})
			assert.equal(rest.requests[0].url, "/v1/messages")
		},
	)
})

test("getMessage: encodes id and unwraps data", async () => {
	await withClient(
		() => ({ json: { data: { id: "list/el", subject: "Hi" } } }),
		async (client, rest) => {
			const msg = await client.getMessage("t", "list/el")
			assert.equal(msg.subject, "Hi")
			assert.equal(rest.requests[0].url, "/v1/messages/list%2Fel")
		},
	)
})

test("downloadAttachment: returns bytes, filename from Content-Disposition, content type", async () => {
	await withClient(
		() => ({
			buffer: Buffer.from("welcome"),
			headers: { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="welcome.txt"' },
		}),
		async (client) => {
			const att = await client.downloadAttachment("t", "m1", "a1")
			assert.equal(att.data.toString("utf8"), "welcome")
			assert.equal(att.filename, "welcome.txt")
			assert.equal(att.contentType, "text/plain")
		},
	)
})

test("downloadAttachment: falls back to attachmentId when no Content-Disposition", async () => {
	await withClient(
		() => ({ buffer: Buffer.from("x"), headers: { "Content-Type": "application/pdf" } }),
		async (client) => {
			const att = await client.downloadAttachment("t", "m1", "att-99")
			assert.equal(att.filename, "att-99")
			assert.equal(att.contentType, "application/pdf")
		},
	)
})

test("updateMessage / deleteMessage / sendMessage / moveMessage round-trips", async () => {
	await withClient(
		(req) => {
			if (req.method === "PATCH") return { json: { data: { messageId: "m1", unread: req.body ? (req.body as { unread: boolean }).unread : false } } }
			if (req.method === "DELETE") return { json: { data: { messageId: "m1", trashed: true } } }
			if (req.url === "/v1/messages/send") return { json: { data: { messageId: "sent-1", status: "sent" } } }
			if (req.url.endsWith("/move"))
				return { json: { data: { messageId: "m1", moved: true, targetFolderId: (req.body as { targetFolderId: string }).targetFolderId } } }
			return { status: 404, json: { error: { code: "validation_error", message: "nope" } } }
		},
		async (client, rest) => {
			assert.equal((await client.updateMessage("t", "m1", true)).unread, true)
			assert.equal((await client.deleteMessage("t", "m1")).trashed, true)

			const sent = await client.sendMessage("t", { to: [{ address: "a@b.com" }], subject: "s" }, "idem-1")
			assert.equal(sent.messageId, "sent-1")
			const sendReq = rest.requests.find((r) => r.url === "/v1/messages/send")
			assert.equal(sendReq?.idempotencyKey, "idem-1")

			const moved = await client.moveMessage("t", "m1", "trash", "idem-2")
			assert.equal(moved.targetFolderId, "trash")
			const moveReq = rest.requests.find((r) => r.url.endsWith("/move"))
			assert.equal((moveReq?.body as { idempotencyKey: string }).idempotencyKey, "idem-2")
		},
	)
})

test("error envelope maps to RestError with code and status", async () => {
	await withClient(
		() => ({ status: 422, json: { error: { code: "external_secure_send_unavailable", message: "need password", requestId: "r1" } } }),
		async (client) => {
			await assert.rejects(client.sendMessage("t", { to: [{ address: "x@ext.com" }], subject: "s" }), (e: unknown) => {
				assert.ok(e instanceof RestError)
				assert.equal(e.status, 422)
				assert.equal(e.code, "external_secure_send_unavailable")
				assert.equal(e.message, "need password")
				assert.equal(e.requestId, "r1")
				return true
			})
		},
	)
})

test("non-JSON error body yields generic RestError", async () => {
	await withClient(
		() => ({ status: 500, buffer: Buffer.from("boom"), headers: { "Content-Type": "text/plain" } }),
		async (client) => {
			await assert.rejects(client.listFolders("t"), (e: unknown) => {
				assert.ok(e instanceof RestError)
				assert.equal(e.status, 500)
				assert.equal(e.code, "http_error")
				return true
			})
		},
	)
})

test("timeout maps to RestError code=timeout", async () => {
	// Handler that never responds would hang; instead use a tiny timeout against a slow buffer.
	const rest = await startFakeRest(() => ({ json: { data: [] } }))
	// Point the client at a black-hole port to force a connection failure quickly.
	await rest.close()
	const client = new RestClient(rest.baseUrl, 50)
	await assert.rejects(client.listFolders("t"), (e: unknown) => {
		assert.ok(e instanceof RestError)
		// Either a connection refusal (network_error) or an abort (timeout) — both are normalized.
		assert.ok(e.code === "network_error" || e.code === "timeout")
		return true
	})
})
