import test from "node:test"
import assert from "node:assert/strict"
import { TutaMailService, type RawAttachment, type RawFolder, type RawMail, type RawMailDetails, type TutaSdkClient } from "../lib/services/tutaMailService.js"
import { mapAuthStatus, mapEmailAddress, mapFolderKind, mapMailState, mapPhishingStatus, mapReplyType } from "../lib/services/mailService.js"
import type { SendMessageRequest } from "../lib/dto/types.js"

// ── Pure mapping helpers (SMTP parity table) ──

test("mapFolderKind covers all known codes and falls back to custom", () => {
	assert.equal(mapFolderKind(0), "custom")
	assert.equal(mapFolderKind(1), "inbox")
	assert.equal(mapFolderKind(2), "sent")
	assert.equal(mapFolderKind(3), "trash")
	assert.equal(mapFolderKind(4), "archive")
	assert.equal(mapFolderKind(5), "spam")
	assert.equal(mapFolderKind(6), "draft")
	assert.equal(mapFolderKind(7), "all")
	assert.equal(mapFolderKind(99), "custom")
})

test("mapMailState covers received/draft/sent and falls back to received", () => {
	assert.equal(mapMailState(0), "received")
	assert.equal(mapMailState(1), "draft")
	assert.equal(mapMailState(2), "sent")
	assert.equal(mapMailState(7), "received")
})

test("mapReplyType covers all variants and falls back to none", () => {
	assert.equal(mapReplyType(0), "none")
	assert.equal(mapReplyType(1), "reply")
	assert.equal(mapReplyType(2), "reply_all")
	assert.equal(mapReplyType(3), "forward")
	assert.equal(mapReplyType(99), "none")
})

test("mapAuthStatus covers SPF/DKIM/DMARC numerics; null stays null", () => {
	assert.equal(mapAuthStatus(null), null)
	assert.equal(mapAuthStatus(0), "unknown")
	assert.equal(mapAuthStatus(1), "pass")
	assert.equal(mapAuthStatus(2), "soft_fail")
	assert.equal(mapAuthStatus(3), "fail")
	assert.equal(mapAuthStatus(4), "none")
	assert.equal(mapAuthStatus(99), "unknown")
})

test("mapPhishingStatus covers known codes and falls back to unknown", () => {
	assert.equal(mapPhishingStatus(0), "unknown")
	assert.equal(mapPhishingStatus(1), "suspicious")
	assert.equal(mapPhishingStatus(2), "phishing")
	assert.equal(mapPhishingStatus(99), "unknown")
})

test("mapEmailAddress: empty name normalized to null", () => {
	assert.deepEqual(mapEmailAddress({ name: "", address: "a@b.com" }), { name: null, address: "a@b.com" })
	assert.deepEqual(mapEmailAddress({ name: "Alice", address: "a@b.com" }), { name: "Alice", address: "a@b.com" })
})

// ── Fake TutaSdkClient + service tests ──

class FakeClient implements TutaSdkClient {
	folders: RawFolder[] = []
	mails: RawMail[] = []
	mail: RawMail | null = null
	details: RawMailDetails | null = null
	attachments: RawAttachment[] = []
	loadMailsCalls: any[] = []
	setUnreadResult = true
	trashResult = true
	moveResult = true
	sendId = "sent-1"
	lastSendRequest: SendMessageRequest | null = null

	async loadFolders() {
		return this.folders
	}
	async loadMails(opts: any) {
		this.loadMailsCalls.push(opts)
		return this.mails
	}
	async loadMail(_id: string) {
		return this.mail
	}
	async loadMailDetails(_mail: RawMail) {
		return this.details
	}
	async loadAttachmentMeta(_mail: RawMail) {
		return this.attachments
	}
	async downloadAttachment(_m: string, _a: string) {
		return null
	}
	async setUnread(_id: string, _u: boolean) {
		return this.setUnreadResult
	}
	async trashMail(_id: string) {
		return this.trashResult
	}
	async sendMail(req: SendMessageRequest) {
		this.lastSendRequest = req
		return this.sendId
	}
	async moveMail(_id: string, _t: string) {
		return this.moveResult
	}
}

function rawMail(over: Partial<RawMail> = {}): RawMail {
	return {
		id: "m1",
		subject: "Hi",
		receivedDate: "2026-01-15T10:00:00.000Z",
		unread: false,
		confidential: false,
		state: 0,
		sender: { name: "Alice", address: "alice@example.com" },
		attachmentCount: 0,
		folderIds: ["inbox"],
		authStatus: 1,
		phishingStatus: 0,
		listUnsubscribe: false,
		replyType: 0,
		...over,
	}
}

test("listFolders maps folderType to kind", async () => {
	const c = new FakeClient()
	c.folders = [
		{ id: "f1", name: "Inbox", folderType: 1 },
		{ id: "f2", name: "Sent", folderType: 2 },
		{ id: "f3", name: "Project", folderType: 0 },
	]
	const out = await new TutaMailService(c).listFolders()
	assert.deepEqual(out, [
		{ id: "f1", name: "Inbox", kind: "inbox" },
		{ id: "f2", name: "Sent", kind: "sent" },
		{ id: "f3", name: "Project", kind: "custom" },
	])
})

test("listMessages: folder kind alias inbox is resolved to the folder id", async () => {
	const c = new FakeClient()
	c.folders = [{ id: "f-inbox", name: "Inbox", folderType: 1 }]
	c.mails = [rawMail({ id: "m1" })]
	await new TutaMailService(c).listMessages({ folder: "inbox", limit: 10 })
	assert.deepEqual(c.loadMailsCalls[0].folderId, "f-inbox")
})

test("listMessages: unknown folder kind yields validation_error", async () => {
	const c = new FakeClient()
	c.folders = [{ id: "f-inbox", name: "Inbox", folderType: 1 }]
	await assert.rejects(
		() => new TutaMailService(c).listMessages({ folder: "sent" }),
		(err: Error) => {
			assert.equal(err.name, "ApiServiceError")
			assert.match(err.message, /Unknown folder/)
			return true
		},
	)
})

test("listMessages: passes count = limit + 1 and computes pagination.hasMore + nextCursor", async () => {
	const c = new FakeClient()
	c.mails = [rawMail({ id: "a" }), rawMail({ id: "b" }), rawMail({ id: "c" })]
	const svc = new TutaMailService(c)
	const out = await svc.listMessages({ limit: 2 })
	assert.deepEqual(c.loadMailsCalls[0], { folderId: undefined, cursor: undefined, count: 3 })
	assert.equal(out.data.length, 2)
	assert.equal(out.pagination.hasMore, true)
	assert.equal(out.pagination.nextCursor, "b")
})

test("listMessages: hasMore false when result fits in limit; nextCursor null", async () => {
	const c = new FakeClient()
	c.mails = [rawMail({ id: "a" })]
	const out = await new TutaMailService(c).listMessages({ limit: 50 })
	assert.equal(out.pagination.hasMore, false)
	assert.equal(out.pagination.nextCursor, null)
})

test("listMessages applies since/before date filters", async () => {
	const c = new FakeClient()
	c.mails = [
		rawMail({ id: "old", receivedDate: "2025-01-01T00:00:00.000Z" }),
		rawMail({ id: "mid", receivedDate: "2026-01-15T00:00:00.000Z" }),
		rawMail({ id: "new", receivedDate: "2026-06-01T00:00:00.000Z" }),
	]
	const out = await new TutaMailService(c).listMessages({
		since: "2026-01-01T00:00:00.000Z",
		before: "2026-05-01T00:00:00.000Z",
		limit: 50,
	})
	assert.deepEqual(
		out.data.map((m) => m.id),
		["mid"],
	)
})

test("listMessages applies unread filter true and false", async () => {
	const c = new FakeClient()
	c.mails = [rawMail({ id: "r", unread: false }), rawMail({ id: "u", unread: true })]
	const svc = new TutaMailService(c)
	assert.deepEqual(
		(await svc.listMessages({ unread: true })).data.map((m) => m.id),
		["u"],
	)
	assert.deepEqual(
		(await svc.listMessages({ unread: false })).data.map((m) => m.id),
		["r"],
	)
})

test("listMessages applies sender substring filter case-insensitively", async () => {
	const c = new FakeClient()
	c.mails = [rawMail({ id: "1", sender: { name: "", address: "Bob@Example.com" } }), rawMail({ id: "2", sender: { name: "", address: "carol@example.com" } })]
	const out = await new TutaMailService(c).listMessages({ from: "BOB" })
	assert.deepEqual(
		out.data.map((m) => m.id),
		["1"],
	)
})

test("listMessages applies hasAttachments filter", async () => {
	const c = new FakeClient()
	c.mails = [rawMail({ id: "noatt", attachmentCount: 0 }), rawMail({ id: "att", attachmentCount: 2 })]
	const svc = new TutaMailService(c)
	assert.deepEqual(
		(await svc.listMessages({ hasAttachments: true })).data.map((m) => m.id),
		["att"],
	)
	assert.deepEqual(
		(await svc.listMessages({ hasAttachments: false })).data.map((m) => m.id),
		["noatt"],
	)
})

test("getMessage returns null when mail or details missing", async () => {
	const c = new FakeClient()
	c.mail = null
	assert.equal(await new TutaMailService(c).getMessage("x"), null)

	c.mail = rawMail()
	c.details = null
	assert.equal(await new TutaMailService(c).getMessage("x"), null)
})

test("getMessage maps full SMTP-parity fields", async () => {
	const c = new FakeClient()
	c.mail = rawMail({
		id: "m1",
		differentEnvelopeSender: "envelope@x.com",
		authStatus: 3,
		phishingStatus: 2,
		listUnsubscribe: true,
		replyType: 2,
		attachmentCount: 1,
	})
	c.details = {
		recipients: {
			toRecipients: [{ name: "To", address: "to@x.com" }],
			ccRecipients: [{ name: "", address: "cc@x.com" }],
			bccRecipients: [],
		},
		replyTos: [{ name: "RT", address: "rt@x.com" }],
		body: { text: "hello body" },
		headers: { "Message-ID": "<abc@x>", "X-Custom": "1" },
	}
	c.attachments = [
		{ id: "a1", name: "logo.png", mimeType: "image/png", size: 99, cid: "logo-cid" },
		{ id: "a2", name: "doc.pdf", mimeType: "application/pdf", size: 1024 },
	]
	const out = await new TutaMailService(c).getMessage("m1")
	assert.ok(out)
	assert.equal(out!.envelopeSender, "envelope@x.com")
	assert.equal(out!.authStatus, "fail")
	assert.equal(out!.phishingStatus, "phishing")
	assert.equal(out!.listUnsubscribe, true)
	assert.equal(out!.replyType, "reply_all")
	assert.deepEqual(out!.to, [{ name: "To", address: "to@x.com" }])
	assert.deepEqual(out!.cc, [{ name: null, address: "cc@x.com" }])
	assert.deepEqual(out!.bcc, [])
	assert.deepEqual(out!.replyTo, [{ name: "RT", address: "rt@x.com" }])
	assert.equal(out!.bodyText, "hello body")
	assert.equal(out!.bodyHtml, "hello body")
	assert.equal(out!.headers["Message-ID"], "<abc@x>")
	assert.equal(out!.attachments[0].contentId, "logo-cid")
	assert.equal(out!.attachments[1].contentId, null)
	assert.equal(out!.hasAttachments, true)
})

test("getMessage: envelopeSender null when blank string", async () => {
	const c = new FakeClient()
	c.mail = rawMail({ differentEnvelopeSender: "" })
	c.details = { recipients: { toRecipients: [], ccRecipients: [], bccRecipients: [] }, replyTos: [], body: { text: "" }, headers: {} }
	const out = await new TutaMailService(c).getMessage("m1")
	assert.equal(out!.envelopeSender, null)
})

test("updateMessage returns null when SDK reports failure; success returns DTO", async () => {
	const c = new FakeClient()
	c.setUnreadResult = false
	assert.equal(await new TutaMailService(c).updateMessage("id", true), null)
	c.setUnreadResult = true
	assert.deepEqual(await new TutaMailService(c).updateMessage("id", true), { messageId: "id", unread: true })
})

test("deleteMessage returns null on failure; trashed:true on success", async () => {
	const c = new FakeClient()
	c.trashResult = false
	assert.equal(await new TutaMailService(c).deleteMessage("x"), null)
	c.trashResult = true
	assert.deepEqual(await new TutaMailService(c).deleteMessage("x"), { messageId: "x", trashed: true })
})

test("sendMessage returns 'sent' status with messageId from SDK", async () => {
	const c = new FakeClient()
	c.sendId = "ABC"
	const out = await new TutaMailService(c).sendMessage({ to: [{ name: null, address: "a@b.com" }], subject: "s" })
	assert.deepEqual(out, { messageId: "ABC", status: "sent" })
	assert.equal(c.lastSendRequest?.subject, "s")
})

test("moveMessage returns null on failure; success echoes target", async () => {
	const c = new FakeClient()
	c.moveResult = false
	assert.equal(await new TutaMailService(c).moveMessage("id", { targetFolderId: "T" }), null)
	c.moveResult = true
	assert.deepEqual(await new TutaMailService(c).moveMessage("id", { targetFolderId: "T" }), {
		messageId: "id",
		moved: true,
		targetFolderId: "T",
	})
})
