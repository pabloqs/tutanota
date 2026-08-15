import test from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { HttpBridgeTutaClient } from "../lib/services/httpBridgeTutaClient.js"
import { ApiServiceError } from "../lib/errors.js"

interface CapturedRequest {
	method: string
	url: string
	headers: NodeJS.Dict<string | string[]>
	body: any
}

async function startBridge(
	respond: (req: CapturedRequest, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string; captured: CapturedRequest[] }> {
	const captured: CapturedRequest[] = []
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		let buf = ""
		req.on("data", (c) => (buf += c))
		req.on("end", async () => {
			let body: any = null
			try {
				body = JSON.parse(buf)
			} catch {
				/* ignore */
			}
			const cap: CapturedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body }
			captured.push(cap)
			await respond(cap, res)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const addr = server.address() as AddressInfo
	return { server, baseUrl: `http://127.0.0.1:${addr.port}`, captured }
}

function close(server: Server) {
	return new Promise<void>((r) => server.close(() => r()))
}

function makeClient(baseUrl: string, opts: { token?: string | null; timeoutMs?: number } = {}) {
	return new HttpBridgeTutaClient({
		tutaBridgeBaseUrl: baseUrl,
		tutaBridgeAuthToken: opts.token ?? null,
		tutaBridgeTimeoutMs: opts.timeoutMs ?? 5_000,
	})
}

test("invoke posts JSON {method, params} to /invoke", async () => {
	const { server, baseUrl, captured } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ ok: true, data: [{ id: "f1", name: "Inbox", folderType: 1 }] }))
	})
	try {
		const client = makeClient(baseUrl)
		const folders = await client.loadFolders()
		assert.equal(folders.length, 1)
		assert.equal(folders[0].id, "f1")
		assert.equal(captured[0].url, "/invoke")
		assert.equal(captured[0].method, "POST")
		assert.equal(captured[0].body.method, "loadFolders")
		assert.deepEqual(captured[0].body.params, {})
	} finally {
		await close(server)
	}
})

test("invoke strips trailing slash from base URL", async () => {
	const { server, baseUrl, captured } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ ok: true, data: [] }))
	})
	try {
		const client = makeClient(baseUrl + "/")
		await client.loadFolders()
		assert.equal(captured[0].url, "/invoke")
	} finally {
		await close(server)
	}
})

test("invoke sends Authorization header when token configured", async () => {
	const { server, baseUrl, captured } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ ok: true, data: [] }))
	})
	try {
		const client = makeClient(baseUrl, { token: "secret-bridge-token" })
		await client.loadFolders()
		assert.equal(captured[0].headers["authorization"], "Bearer secret-bridge-token")
	} finally {
		await close(server)
	}
})

test("invoke omits Authorization header when no token configured", async () => {
	const { server, baseUrl, captured } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ ok: true, data: [] }))
	})
	try {
		await makeClient(baseUrl).loadFolders()
		assert.equal(captured[0].headers["authorization"], undefined)
	} finally {
		await close(server)
	}
})

test("invoke maps non-2xx HTTP status to upstream_unavailable", async () => {
	const { server, baseUrl } = await startBridge((_req, res) => {
		res.writeHead(502).end()
	})
	try {
		await assert.rejects(makeClient(baseUrl).loadFolders(), (err: any) => {
			assert.ok(err instanceof ApiServiceError)
			assert.equal(err.code, "upstream_unavailable")
			assert.equal(err.status, 503)
			assert.match(err.message, /HTTP 502/)
			return true
		})
	} finally {
		await close(server)
	}
})

test("invoke maps {ok:false} response to upstream_unavailable, includes debug", async () => {
	const { server, baseUrl } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ ok: false, message: "session expired", debug: "credentials rotated" }))
	})
	try {
		await assert.rejects(makeClient(baseUrl).loadFolders(), (err: any) => {
			assert.equal(err.code, "upstream_unavailable")
			assert.match(err.message, /session expired/)
			assert.match(err.message, /credentials rotated/)
			return true
		})
	} finally {
		await close(server)
	}
})

test("invoke maps errorCode external_secure_send_unavailable to ApiServiceError 422", async () => {
	const { server, baseUrl } = await startBridge((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(
			JSON.stringify({
				ok: false,
				message: "external password required",
				errorCode: "external_secure_send_unavailable",
			}),
		)
	})
	try {
		await assert.rejects(makeClient(baseUrl).sendMail({ to: [{ name: null, address: "x@y.com" }], subject: "s" }), (err: any) => {
			assert.equal(err.code, "external_secure_send_unavailable")
			assert.equal(err.status, 422)
			return true
		})
	} finally {
		await close(server)
	}
})

test("invoke maps timeout/AbortError to upstream_unavailable", async () => {
	const { server, baseUrl } = await startBridge(async (_req, res) => {
		// Never respond within timeout
		await new Promise((r) => setTimeout(r, 200))
		res.writeHead(200).end(JSON.stringify({ ok: true, data: [] }))
	})
	try {
		const client = makeClient(baseUrl, { timeoutMs: 30 })
		await assert.rejects(client.loadFolders(), (err: any) => {
			assert.equal(err.code, "upstream_unavailable")
			assert.match(err.message, /timed out/)
			return true
		})
	} finally {
		await close(server)
	}
})

test("invoke wraps unexpected fetch failure (connection refused) as upstream_unavailable", async () => {
	const client = makeClient("http://127.0.0.1:1") // unused port
	await assert.rejects(client.loadFolders(), (err: any) => {
		assert.equal(err.code, "upstream_unavailable")
		return true
	})
})

test("downloadAttachment decodes base64 content; null when missing", async () => {
	const { server, baseUrl } = await startBridge((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" })
		if (req.body.params.attachmentId === "missing") {
			res.end(JSON.stringify({ ok: true, data: null }))
		} else {
			res.end(
				JSON.stringify({
					ok: true,
					data: {
						contentBase64: Buffer.from("hello-bytes").toString("base64"),
						filename: "n.txt",
						contentType: "text/plain",
					},
				}),
			)
		}
	})
	try {
		const client = makeClient(baseUrl)
		const out = await client.downloadAttachment("m1", "att1")
		assert.ok(out)
		assert.equal(out!.filename, "n.txt")
		assert.equal(out!.contentType, "text/plain")
		assert.equal(out!.data.toString(), "hello-bytes")
		const missing = await client.downloadAttachment("m1", "missing")
		assert.equal(missing, null)
	} finally {
		await close(server)
	}
})

test("each method routes to its named bridge invocation with correct params", async () => {
	const { server, baseUrl, captured } = await startBridge((req, res) => {
		const m = req.body.method
		res.writeHead(200, { "Content-Type": "application/json" })
		if (m === "sendMail") res.end(JSON.stringify({ ok: true, data: { messageId: "MID-1" } }))
		else if (m === "loadMail") res.end(JSON.stringify({ ok: true, data: null }))
		else if (m === "loadMailDetails") res.end(JSON.stringify({ ok: true, data: null }))
		else if (m === "loadAttachmentMeta") res.end(JSON.stringify({ ok: true, data: [] }))
		else if (m === "loadMails") res.end(JSON.stringify({ ok: true, data: [] }))
		else res.end(JSON.stringify({ ok: true, data: true }))
	})
	try {
		const client = makeClient(baseUrl)
		await client.loadMails({ folderId: "F", cursor: "C", count: 10 })
		await client.loadMail("ID-1")
		await client.loadMailDetails({ id: "ID-2" } as any)
		await client.loadAttachmentMeta({ id: "ID-3" } as any)
		await client.setUnread("ID-4", true)
		await client.trashMail("ID-5")
		await client.moveMail("ID-6", "TARGET")
		const sentId = await client.sendMail({ to: [{ name: null, address: "a@b.com" }], subject: "s" })
		assert.equal(sentId, "MID-1")

		const map = Object.fromEntries(captured.map((c) => [c.body.method, c.body.params]))
		assert.deepEqual(map.loadMails, { folderId: "F", cursor: "C", count: 10 })
		assert.deepEqual(map.loadMail, { id: "ID-1" })
		assert.deepEqual(map.loadMailDetails, { mailId: "ID-2" })
		assert.deepEqual(map.loadAttachmentMeta, { mailId: "ID-3" })
		assert.deepEqual(map.setUnread, { id: "ID-4", unread: true })
		assert.deepEqual(map.trashMail, { id: "ID-5" })
		assert.deepEqual(map.moveMail, { id: "ID-6", targetFolderId: "TARGET" })
		assert.equal(map.sendMail.request.subject, "s")
	} finally {
		await close(server)
	}
})
