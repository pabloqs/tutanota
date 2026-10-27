import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttachmentStore, attachmentFileName } from "../lib/attachmentStore.js"

const REF = { accountId: "work", messageId: "m1", attachmentId: "a1" }

/** Strip the 16-hex id key and its dash. */
const nameOf = (fileName: string) => fileName.slice(17)

test("attachmentFileName: disallowed characters become underscores, and the result is one shell word", () => {
	assert.equal(nameOf(attachmentFileName(REF, "Mandat secrétariat UT.docx", "application/octet-stream")), "Mandat_secr_tariat_UT.docx")
	assert.equal(nameOf(attachmentFileName(REF, "Informe (final).pdf", "application/pdf")), "Informe_final_.pdf")
	assert.equal(nameOf(attachmentFileName(REF, "foo.docx ", "application/octet-stream")), "foo.docx")
	for (const filename of ["Mandat secrétariat UT.docx", "Informe (final).pdf", "a[b].txt"]) {
		assert.match(attachmentFileName(REF, filename, "application/octet-stream"), /^[0-9a-f]{16}-[A-Za-z0-9._-]+$/)
	}
})

test("attachmentFileName: a hostile content type cannot leak Object.prototype into the name", () => {
	for (const contentType of ["__proto__", "constructor", "toString"]) {
		assert.equal(nameOf(attachmentFileName(REF, "blob", contentType)), "blob")
	}
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

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "tuta-mail-att-"))
	try {
		await run(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

test("AttachmentStore.save: writes owner-only file and directory, leaves no temp files", async () => {
	await withTempRoot(async (root) => {
		const dir = join(root, "attachments")
		const savedPath = await new AttachmentStore(dir, false).save(REF, "a.txt", "text/plain", Buffer.from("hello"))
		assert.equal(await readFile(savedPath, "utf8"), "hello")
		assert.equal((await stat(savedPath)).mode & 0o777, 0o600)
		assert.equal((await stat(dir)).mode & 0o777, 0o700)
		assert.deepEqual(await readdir(dir), [attachmentFileName(REF, "a.txt", "text/plain")])
	})
})

test("AttachmentStore.save: tightens an existing directory only when it owns it", async () => {
	await withTempRoot(async (root) => {
		const owned = join(root, "owned")
		const configured = join(root, "configured")
		for (const dir of [owned, configured]) {
			await mkdir(dir)
			await chmod(dir, 0o755)
		}
		await new AttachmentStore(owned, true).save(REF, "a.txt", "text/plain", Buffer.from("hello"))
		await new AttachmentStore(configured, false).save(REF, "a.txt", "text/plain", Buffer.from("hello"))
		assert.equal((await stat(owned)).mode & 0o777, 0o700)
		assert.equal((await stat(configured)).mode & 0o777, 0o755)
	})
})

test("AttachmentStore.save: re-saving replaces copies stored under an older name", async () => {
	await withTempRoot(async (root) => {
		const store = new AttachmentStore(root, false)
		const name = attachmentFileName(REF, "Informe (final).pdf", "application/pdf")
		const prefix = name.slice(0, 17)
		// A copy of the same attachment under an older sanitizer's name, one of another attachment, and an in-flight temp file.
		await writeFile(join(root, `${prefix}Informe (final).pdf`), "old")
		await writeFile(join(root, `${prefix}x.pdf.1234.tmp`), "tmp")
		const other = attachmentFileName({ ...REF, attachmentId: "a2" }, "b.pdf", "application/pdf")
		await writeFile(join(root, other), "other")
		await store.save(REF, "Informe (final).pdf", "application/pdf", Buffer.from("new"))
		assert.deepEqual((await readdir(root)).sort(), [name, `${prefix}x.pdf.1234.tmp`, other].sort())
	})
})

test("AttachmentStore.save: a failed write leaves nothing behind", async () => {
	await withTempRoot(async (root) => {
		// A directory at the final path makes the rename fail after the temp file was written.
		await mkdir(join(root, attachmentFileName(REF, "a.txt", "text/plain")))
		await assert.rejects(new AttachmentStore(root, false).save(REF, "a.txt", "text/plain", Buffer.from("hello")))
		assert.deepEqual(await readdir(root), [attachmentFileName(REF, "a.txt", "text/plain")])
	})
})
