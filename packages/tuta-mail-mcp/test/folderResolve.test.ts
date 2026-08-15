import test from "node:test"
import assert from "node:assert/strict"
import { looksLikeFolderKind, resolveFolderKind, resolveFolderRef } from "../lib/folderResolve.js"
import { McpUserError } from "../lib/accounts.js"
import { RestClient } from "../lib/restClient.js"
import { startFakeRest } from "./fakeRestServer.js"

test("looksLikeFolderKind recognizes aliases, not opaque ids", () => {
	assert.equal(looksLikeFolderKind("inbox"), true)
	assert.equal(looksLikeFolderKind("Drafts"), true)
	assert.equal(looksLikeFolderKind("OEGl6DZ--F-9"), false)
})

test("resolveFolderKind maps kind and name; unknown throws", () => {
	const folders = [
		{ id: "id-in", name: "Inbox", kind: "inbox" },
		{ id: "id-proj", name: "Project", kind: "custom" },
	]
	assert.equal(resolveFolderKind(folders, "inbox"), "id-in")
	assert.equal(resolveFolderKind(folders, "INBOX"), "id-in")
	assert.equal(resolveFolderKind(folders, "project"), "id-proj")
	assert.throws(() => resolveFolderKind(folders, "sent"), McpUserError)
})

test("resolveFolderRef defaults omitted folder to inbox id", async () => {
	const rest = await startFakeRest((req) => {
		if (req.url === "/v1/folders") {
			return { json: { data: [{ id: "real-inbox", name: "Inbox", kind: "inbox" }] } }
		}
		return { status: 404, json: {} }
	})
	try {
		const client = new RestClient(rest.baseUrl, 5000)
		assert.equal(await resolveFolderRef(client, "tok", undefined, { defaultInbox: true }), "real-inbox")
		assert.equal(await resolveFolderRef(client, "tok", "inbox", { defaultInbox: true }), "real-inbox")
		assert.equal(await resolveFolderRef(client, "tok", "OEGl6DZ--F-9"), "OEGl6DZ--F-9")
	} finally {
		await rest.close()
	}
})
