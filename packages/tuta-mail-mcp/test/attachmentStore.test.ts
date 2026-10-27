import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attachmentFileName, saveAttachment } from "../lib/attachmentStore.js"

const REF = { accountId: "work", messageId: "m1", attachmentId: "a1" }

/** Strip the 16-hex id key and its dash. */
const nameOf = (fileName: string) => fileName.slice(17)

test("attachmentFileName: non-ASCII characters become underscores", () => {
	assert.equal(nameOf(attachmentFileName(REF, "Mandat secrétariat UT.docx", "application/octet-stream")), "Mandat secr_tariat UT.docx")
})

test("attachmentFileName: path separators and traversal cannot escape the directory", () => {
	for (const filename of ["../../.bashrc", "a/b\\c.txt", "/etc/passwd", ".."]) {
		const name = attachmentFileName(REF, filename, "text/plain")
		assert.ok(!name.includes("/") && !name.includes("\\"), name)
		assert.match(name, /^[0-9a-f]{16}-/)
	}
})

test("attachmentFileName: empty name falls back to 'attachment' and long names are capped", () => {
	assert.equal(nameOf(attachmentFileName(REF, "", "application/octet-stream")), "attachment")
	const long = nameOf(attachmentFileName(REF, `${"x".repeat(300)}.pdf`, "application/octet-stream"))
	assert.equal(long.length, 180)
	assert.ok(long.endsWith("x.pdf"), long)
})

test("attachmentFileName: missing extension is derived from the content type", () => {
	const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	assert.equal(nameOf(attachmentFileName(REF, "abc123", docx)), "abc123.docx")
	assert.equal(nameOf(attachmentFileName(REF, "notes", "text/plain; charset=utf-8")), "notes.txt")
	assert.equal(nameOf(attachmentFileName(REF, "report.PDF", "application/octet-stream")), "report.PDF")
	assert.equal(nameOf(attachmentFileName(REF, "blob", "application/x-unknown")), "blob")
})

test("attachmentFileName: same attachment maps to one name, different attachments never collide", () => {
	assert.equal(attachmentFileName(REF, "invoice.pdf", "application/pdf"), attachmentFileName(REF, "invoice.pdf", "application/pdf"))
	const names = new Set(
		[REF, { ...REF, accountId: "personal" }, { ...REF, messageId: "m2" }, { ...REF, attachmentId: "a2" }].map((r) =>
			attachmentFileName(r, "invoice.pdf", "application/pdf"),
		),
	)
	assert.equal(names.size, 4)
})

test("saveAttachment: writes owner-only file and directory, leaves no temp files", async () => {
	const root = await mkdtemp(join(tmpdir(), "tuta-mail-att-"))
	try {
		const dir = join(root, "attachments")
		const savedPath = await saveAttachment(dir, REF, "a.txt", "text/plain", Buffer.from("hello"))
		assert.equal(await readFile(savedPath, "utf8"), "hello")
		assert.equal((await stat(savedPath)).mode & 0o777, 0o600)
		assert.equal((await stat(dir)).mode & 0o777, 0o700)
		assert.deepEqual(await readdir(dir), [attachmentFileName(REF, "a.txt", "text/plain")])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test("saveAttachment: a failed write leaves nothing behind", async () => {
	const root = await mkdtemp(join(tmpdir(), "tuta-mail-att-"))
	try {
		// A directory at the final path makes the rename fail after the temp file was written.
		await mkdir(join(root, attachmentFileName(REF, "a.txt", "text/plain")))
		await assert.rejects(saveAttachment(root, REF, "a.txt", "text/plain", Buffer.from("hello")))
		assert.deepEqual(await readdir(root), [attachmentFileName(REF, "a.txt", "text/plain")])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
