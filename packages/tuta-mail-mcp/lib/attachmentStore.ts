import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"

/** Extensions for content types the agent typically converts, used when the filename has none. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/vnd.oasis.opendocument.text": ".odt",
	"application/rtf": ".rtf",
	"application/zip": ".zip",
	"text/plain": ".txt",
	"text/html": ".html",
	"text/csv": ".csv",
	"text/calendar": ".ics",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"message/rfc822": ".eml",
}

export interface AttachmentRef {
	accountId: string
	messageId: string
	attachmentId: string
}

/** Extension from our map only. A hostile Content-Type must not read Object.prototype. */
function extensionForContentType(contentType: string): string {
	const key = contentType.split(";")[0].trim().toLowerCase()
	return Object.hasOwn(EXTENSION_BY_CONTENT_TYPE, key) ? EXTENSION_BY_CONTENT_TYPE[key] : ""
}

/**
 * File name for a saved attachment: a key derived from account/message/attachment ids (so repeated
 * downloads reuse one file and different attachments never collide) plus a shell-safe version of the
 * original name. Only ASCII letters, digits, `.`, `_` and `-`, so the path is one shell word and
 * cannot contain a separator.
 */
export function attachmentFileName(ref: AttachmentRef, filename: string, contentType: string): string {
	const key = createHash("sha256").update(`${ref.accountId}\0${ref.messageId}\0${ref.attachmentId}`).digest("hex").slice(0, 16)
	const sanitized = filename.trim().replace(/[^A-Za-z0-9._-]+/g, "_")
	// Converters pick the format from the extension, so keep it when truncating and derive one when missing.
	let ext = extname(sanitized).slice(0, 16)
	const base = (ext ? sanitized.slice(0, -extname(sanitized).length) : sanitized) || "attachment"
	if (!ext) ext = extensionForContentType(contentType)
	return `${key}-${base.slice(0, 180 - ext.length)}${ext}`
}

/**
 * Write the attachment under `dir`, readable only by the owner. Writes to a temp file and renames, so
 * a failed write never leaves a truncated file under the final name. Returns the absolute path.
 */
export async function saveAttachment(dir: string, ref: AttachmentRef, filename: string, contentType: string, data: Buffer): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 })
	// mkdir does not change the mode of a directory that already exists.
	await chmod(dir, 0o700)
	const savedPath = join(dir, attachmentFileName(ref, filename, contentType))
	const tmpPath = `${savedPath}.${randomUUID()}.tmp`
	try {
		await writeFile(tmpPath, data, { mode: 0o600 })
		await rename(tmpPath, savedPath)
	} catch (e) {
		await unlink(tmpPath).catch(() => {})
		throw e
	}
	return savedPath
}
