import test from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "../lib/server.js"
import type { McpConfig } from "../lib/config.js"
import { startFakeRest, type CapturedRequest, type FakeResponse } from "./fakeRestServer.js"

const TOKENS: Record<string, string> = { "Bearer tok-work": "work", "Bearer tok-personal": "personal" }

/** Fake tuta-mail-api that routes by bearer token to an account and tags responses with it. */
function accountAwareHandler(req: CapturedRequest): FakeResponse {
	const url = new URL(`http://x${req.url}`)
	if (url.pathname === "/v1/health") {
		return {
			json: {
				status: "ok",
				accounts: [
					{ id: "work", label: "Work", kind: "http_bridge", serviceMode: "tuta", mailOperationsReady: true },
					{ id: "personal", label: "Personal", kind: "dev_stub", serviceMode: "dev", mailOperationsReady: true },
				],
			},
		}
	}
	const account = req.auth ? TOKENS[req.auth] : undefined
	if (!account) {
		return { status: 401, json: { error: { code: "auth_error", message: "bad token" } } }
	}
	if (url.pathname === "/v1/folders") {
		return {
			json: {
				data: [
					{ id: `${account}-inbox`, name: "Inbox", kind: "inbox" },
					{ id: `${account}-trash`, name: "Trash", kind: "trash" },
				],
			},
		}
	}
	if (url.pathname === "/v1/messages") {
		return { json: { data: [{ id: `${account}-m1`, subject: `hello ${account}` }], pagination: { limit: 50, nextCursor: null, hasMore: false } } }
	}
	if (url.pathname === "/v1/messages/send") {
		return { json: { data: { messageId: `sent-${account}`, status: "sent" } } }
	}
	const attMatch = /^\/v1\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
	if (attMatch) {
		return {
			buffer: Buffer.from(`bytes-${account}`),
			headers: { "Content-Type": "text/plain", "Content-Disposition": `attachment; filename="${account}.txt"` },
		}
	}
	const moveMatch = /^\/v1\/messages\/([^/]+)\/move$/.exec(url.pathname)
	if (moveMatch) {
		return {
			json: {
				data: { messageId: decodeURIComponent(moveMatch[1]), moved: true, targetFolderId: (req.body as { targetFolderId: string }).targetFolderId },
			},
		}
	}
	const idMatch = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname)
	if (idMatch) {
		const id = decodeURIComponent(idMatch[1])
		if (req.method === "GET") {
			return { json: { data: { id, subject: `detail ${account}`, bodyText: "body", attachments: [{ id: "a1", filename: "f.txt" }] } } }
		}
		if (req.method === "PATCH") {
			return { json: { data: { messageId: id, unread: (req.body as { unread: boolean }).unread } } }
		}
		if (req.method === "DELETE") {
			return { json: { data: { messageId: id, trashed: true } } }
		}
	}
	return { status: 404, json: { error: { code: "validation_error", message: "not found" } } }
}

const config = (baseUrl: string): McpConfig => ({
	baseUrl,
	timeoutMs: 60000,
	accounts: [
		{ id: "work", label: "Work", token: "tok-work" },
		{ id: "personal", label: "Personal", token: "tok-personal" },
	],
})

async function withMcp(run: (client: Client, rest: Awaited<ReturnType<typeof startFakeRest>>) => Promise<void>): Promise<void> {
	const rest = await startFakeRest(accountAwareHandler)
	const server = createMcpServer(config(rest.baseUrl))
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	const client = new Client({ name: "test-client", version: "1.0.0" })
	await client.connect(clientTransport)
	try {
		await run(client, rest)
	} finally {
		await client.close()
		await server.close()
		await rest.close()
	}
}

function textOf(result: CallToolResult): string {
	const first = result.content[0]
	assert.equal(first.type, "text")
	return (first as { text: string }).text
}

test("tools/list exposes all mail tools", async () => {
	await withMcp(async (client) => {
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name).sort()
		assert.deepEqual(names, [
			"delete_message",
			"download_attachment",
			"get_message",
			"list_accounts",
			"list_folders",
			"list_messages",
			"mark_message",
			"move_message",
			"send_message",
		])
	})
})

test("list_accounts returns configured accounts enriched with health, no tokens", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({ name: "list_accounts", arguments: {} })) as CallToolResult
		assert.notEqual(res.isError, true)
		const body = JSON.parse(textOf(res)) as { accounts: Array<{ id: string; kind: string; mailOperationsReady: boolean }> }
		assert.deepEqual(
			body.accounts.map((a) => a.id),
			["work", "personal"],
		)
		assert.equal(body.accounts[0].kind, "http_bridge")
		assert.equal(body.accounts[1].kind, "dev_stub")
		assert.ok(!textOf(res).includes("tok-"))
	})
})

test("account routing: each account reaches its own mailbox via its token", async () => {
	await withMcp(async (client, rest) => {
		const work = (await client.callTool({ name: "list_folders", arguments: { account: "work" } })) as CallToolResult
		assert.match(textOf(work), /work-inbox/)
		const personal = (await client.callTool({ name: "list_folders", arguments: { account: "personal" } })) as CallToolResult
		assert.match(textOf(personal), /personal-inbox/)

		// The REST calls carried each account's own bearer token.
		const folderReqs = rest.requests.filter((r) => r.url === "/v1/folders")
		assert.deepEqual(folderReqs.map((r) => r.auth).sort(), ["Bearer tok-personal", "Bearer tok-work"])
	})
})

test("list_messages forwards filters and returns account-tagged data", async () => {
	await withMcp(async (client, rest) => {
		const res = (await client.callTool({ name: "list_messages", arguments: { account: "work", unread: true, limit: 10 } })) as CallToolResult
		assert.match(textOf(res), /hello work/)
		const req = rest.requests.find((r) => r.url.startsWith("/v1/messages?"))
		const url = new URL(`http://x${req?.url}`)
		assert.equal(url.searchParams.get("unread"), "true")
		assert.equal(url.searchParams.get("limit"), "10")
		// Kind alias `inbox` (the default) is resolved to the account's real folder id.
		assert.equal(url.searchParams.get("folder"), "work-inbox")
		assert.ok(rest.requests.some((r) => r.url === "/v1/folders"))
	})
})

test("get_message returns the full message for the account", async () => {
	await withMcp(async (client, rest) => {
		const res = (await client.callTool({ name: "get_message", arguments: { account: "work", id: "work/m1" } })) as CallToolResult
		const body = JSON.parse(textOf(res)) as { message: { subject: string } }
		assert.equal(body.message.subject, "detail work")
		assert.ok(rest.requests.some((r) => r.method === "GET" && r.url === "/v1/messages/work%2Fm1"))
	})
})

test("download_attachment returns base64 bytes and metadata", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({
			name: "download_attachment",
			arguments: { account: "personal", messageId: "m1", attachmentId: "a1" },
		})) as CallToolResult
		const body = JSON.parse(textOf(res)) as { filename: string; contentType: string; sizeBytes: number; contentBase64: string }
		assert.equal(body.filename, "personal.txt")
		assert.equal(body.contentType, "text/plain")
		assert.equal(Buffer.from(body.contentBase64, "base64").toString("utf8"), "bytes-personal")
		assert.equal(body.sizeBytes, "bytes-personal".length)
	})
})

test("mark_message sets unread flag", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({ name: "mark_message", arguments: { account: "work", id: "m1", unread: false } })) as CallToolResult
		const body = JSON.parse(textOf(res)) as { result: { unread: boolean } }
		assert.equal(body.result.unread, false)
	})
})

test("delete_message trashes the message", async () => {
	await withMcp(async (client, rest) => {
		const res = (await client.callTool({ name: "delete_message", arguments: { account: "work", id: "m1" } })) as CallToolResult
		const body = JSON.parse(textOf(res)) as { result: { trashed: boolean } }
		assert.equal(body.result.trashed, true)
		assert.ok(rest.requests.some((r) => r.method === "DELETE" && r.url === "/v1/messages/m1"))
	})
})

test("move_message forwards target folder and idempotency key", async () => {
	await withMcp(async (client, rest) => {
		const res = (await client.callTool({
			name: "move_message",
			arguments: { account: "work", id: "m1", targetFolderId: "trash", idempotencyKey: "k1" },
		})) as CallToolResult
		const body = JSON.parse(textOf(res)) as { result: { targetFolderId: string; moved: boolean } }
		assert.equal(body.result.targetFolderId, "work-trash")
		const moveReq = rest.requests.find((r) => r.url === "/v1/messages/m1/move")
		assert.equal((moveReq?.body as { idempotencyKey: string }).idempotencyKey, "k1")
	})
})

test("send_message routes to the selected account", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({
			name: "send_message",
			arguments: { account: "personal", to: [{ address: "a@b.com" }], subject: "hi", bodyText: "yo" },
		})) as CallToolResult
		const body = JSON.parse(textOf(res)) as { result: { messageId: string } }
		assert.equal(body.result.messageId, "sent-personal")
	})
})

test("omitting account with multiple configured is a tool error", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({ name: "list_folders", arguments: {} })) as CallToolResult
		assert.equal(res.isError, true)
		assert.match(textOf(res), /Multiple accounts configured/)
	})
})

test("unknown account is a tool error listing valid ids", async () => {
	await withMcp(async (client) => {
		const res = (await client.callTool({ name: "list_folders", arguments: { account: "ghost" } })) as CallToolResult
		assert.equal(res.isError, true)
		assert.match(textOf(res), /Unknown account 'ghost'/)
	})
})

test("REST auth failure surfaces as a tool error, not a crash", async () => {
	// Configure the MCP with a token the fake REST rejects.
	const rest = await startFakeRest(accountAwareHandler)
	const server = createMcpServer({ baseUrl: rest.baseUrl, timeoutMs: 60000, accounts: [{ id: "solo", label: null, token: "wrong-token" }] })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	const client = new Client({ name: "t", version: "1.0.0" })
	await client.connect(clientTransport)
	try {
		// Single account → no account arg needed.
		const res = (await client.callTool({ name: "list_folders", arguments: {} })) as CallToolResult
		assert.equal(res.isError, true)
		assert.match(textOf(res), /auth_error \(HTTP 401\)/)
	} finally {
		await client.close()
		await server.close()
		await rest.close()
	}
})
