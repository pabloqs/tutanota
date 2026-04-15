import test from "node:test"
import assert from "node:assert/strict"
import { parseListMessagesQuery, validateMoveMessageRequest, validateSendMessageRequest, validateUpdateMessageRequest } from "../lib/validation.js"

test("parseListMessagesQuery parses typed fields", () => {
	const query = parseListMessagesQuery({
		limit: "20",
		unread: "true",
		hasAttachments: "false",
		from: "a@b.com",
	})
	assert.equal(query.limit, 20)
	assert.equal(query.unread, true)
	assert.equal(query.hasAttachments, false)
	assert.equal(query.from, "a@b.com")
})

test("validateUpdateMessageRequest requires boolean unread", () => {
	assert.deepEqual(validateUpdateMessageRequest({ unread: true }), { unread: true })
	assert.throws(() => validateUpdateMessageRequest({ unread: "x" }))
})

test("validateMoveMessageRequest validates required targetFolderId", () => {
	assert.deepEqual(validateMoveMessageRequest({ targetFolderId: "archive" }), { targetFolderId: "archive", idempotencyKey: undefined })
	assert.throws(() => validateMoveMessageRequest({}))
})

test("validateSendMessageRequest validates recipients and subject", () => {
	const valid = validateSendMessageRequest({
		to: [{ address: "foo@example.com", name: "Foo" }],
		subject: "hello",
		bodyText: "body",
	})
	assert.equal(valid.subject, "hello")
	assert.throws(() => validateSendMessageRequest({ to: [], subject: "x" }))
	assert.throws(() => validateSendMessageRequest({ to: [{ address: "nope" }], subject: "x" }))
	assert.throws(() => validateSendMessageRequest({ to: [{ address: "foo@example.com" }], subject: "x" }))
})
