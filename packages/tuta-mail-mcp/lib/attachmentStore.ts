import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"

/** Extensions for content types the agent typically converts, used when the filename has none. A Map, so a hostile Content-Type cannot hit Object.prototype. */
const EXTENSION_BY_CONTENT_TYPE = new Map<string, string>([
	["application/pdf", ".pdf"],
	["application/msword", ".doc"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
	["application/vnd.ms-excel", ".xls"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
	["application/vnd.ms-powerpoint", ".ppt"],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
	["application/vnd.oasis.opendocument.text", ".odt"],
	["application/rtf", ".rtf"],
	["application/zip", ".zip"],
	["text/plain", ".txt"],
	["text/html", ".html"],
	["text/csv", ".csv"],
	["text/calendar", ".ics"],
	["image/png", ".png"],
	["image/jpeg", ".jpg"],
	["image/gif", ".gif"],
	["message/rfc822", ".eml"],
])

export interface AttachmentRef {
	accountId: string
	messageId: string
	attachmentId: string
}

/** Length of the `<16 hex>-` prefix every saved file name starts with. */
const KEY_PREFIX_LENGTH = 17

/**
 * File name for a saved attachment: a key derived from account/message/attachment ids (so repeated
 * downloads reuse one file and different attachments never collide) plus a sanitized version of the
 * original name. The name only contains ASCII letters, digits, `.`, `_` and `-`: it is one shell word
 * and cannot contain a separator. The directory part of the full path is not restricted.
 */
export function attachmentFileName(ref: AttachmentRef, filename: string, contentType: string): string {
	const key = createHash("sha256").update(`${ref.accountId}\0${ref.messageId}\0${ref.attachmentId}`).digest("hex").slice(0, 16)
	const sanitized = filename.trim().replace(/[^A-Za-z0-9._-]+/g, "_")
	// Converters pick the format from the extension, so keep it when truncating and derive one when missing.
	let ext = extname(sanitized).slice(0, 16)
	const base = (ext ? sanitized.slice(0, -extname(sanitized).length) : sanitized) || "attachment"
	if (!ext) ext = EXTENSION_BY_CONTENT_TYPE.get(contentType.split(";")[0].trim().toLowerCase()) ?? ""
	return `${key}-${base.slice(0, 180 - ext.length)}${ext}`
}

/** Saves downloaded attachments as owner-only files under one directory. */
export class AttachmentStore {
	private tightened = false

	/**
	 * @param dir absolute directory to save into
	 * @param ownsDir true for our default directory: an existing one is tightened to 0700. An
	 *   operator-chosen directory keeps its mode (it may be shared); the files are 0600 either way.
	 */
	constructor(
		readonly dir: string,
		private readonly ownsDir: boolean,
	) {}

	/**
	 * Write the attachment and return its absolute path. Writes to a temp file and renames, so a failed
	 * write never leaves a truncated file under the final name.
	 */
	async save(ref: AttachmentRef, filename: string, contentType: string, data: Buffer): Promise<string> {
		await this.prepareDir()
		const name = attachmentFileName(ref, filename, contentType)
		const savedPath = join(this.dir, name)
		const tmpPath = `${savedPath}.${randomUUID()}.tmp`
		try {
			await writeFile(tmpPath, data, { mode: 0o600 })
			await rename(tmpPath, savedPath)
		} catch (e) {
			await unlink(tmpPath).catch(() => {})
			throw e
		}
		await this.removeStaleCopies(name)
		return savedPath
	}

	private async prepareDir(): Promise<void> {
		// Every call, so a directory removed while the server runs is recreated. Created dirs are already 0700.
		const created = await mkdir(this.dir, { recursive: true, mode: 0o700 })
		if (created || !this.ownsDir || this.tightened) return
		try {
			await chmod(this.dir, 0o700)
		} catch (e) {
			// Not ours to change; files are still written 0600.
			if (e.code !== "EPERM") throw e
		}
		this.tightened = true
	}

	/** Drop files saved for the same attachment under an older name (e.g. before a sanitizer change). */
	private async removeStaleCopies(name: string): Promise<void> {
		const prefix = name.slice(0, KEY_PREFIX_LENGTH)
		for (const entry of await readdir(this.dir)) {
			// Skip temp files: a concurrent save of the same attachment may still be writing one.
			if (entry.startsWith(prefix) && entry !== name && !entry.endsWith(".tmp")) {
				await unlink(join(this.dir, entry)).catch(() => {})
			}
		}
	}
}
