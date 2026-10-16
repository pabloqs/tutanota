/**
 * `Content-Disposition` for a downloaded attachment.
 *
 * Node rejects non-ASCII bytes in header values (`ERR_INVALID_CHAR`), which
 * turned every mail with an accented or punctuation-rich filename into HTTP 500
 * after the bridge had already decrypted the file. `filename` is an ASCII
 * fallback; `filename*` carries the original UTF-8 name (RFC 6266 / RFC 5987).
 */
export function attachmentContentDisposition(filename: string): string {
	const fallback = asciiFilename(filename)
	const encoded = encodeRfc5987(filename)
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function asciiFilename(filename: string): string {
	const stripped = filename
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^\x20-\x7E]/g, "_")
		.replace(/["\\]/g, "_")
		.trim()
	return stripped || "attachment"
}

function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}
