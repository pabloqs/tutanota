import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
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

/**
 * File name for a saved attachment: a key derived from account/message/attachment ids (so repeated
 * downloads reuse one file and different attachments never collide) plus a path-safe version of the
 * original name. The result never contains a path separator.
 */
export function attachmentFileName(ref: AttachmentRef, filename: string, contentType: string): string {
	const key = createHash("sha256").update(`${ref.accountId}\0${ref.messageId}\0${ref.attachmentId}`).digest("hex").slice(0, 16)
	const sanitized = filename.replace(/[^\w.\- ()[\]]+/g, "_")
	// Converters pick the format from the extension, so keep it when truncating and derive one when missing.
	let ext = extname(sanitized).slice(0, 16)
	const base = (ext ? sanitized.slice(0, -extname(sanitized).length) : sanitized) || "attachment"
	if (!ext) ext = EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0].trim().toLowerCase()] ?? ""
	return `${key}-${base.slice(0, 180 - ext.length)}${ext}`
}

/**
 * Write the attachment under `dir`, readable only by the owner. Writes to a temp file and renames, so
 * a failed write never leaves a truncated file under the final name. Returns the absolute path.
 */
export async function saveAttachment(dir: string, ref: AttachmentRef, filename: string, contentType: string, data: Buffer): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 })
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
