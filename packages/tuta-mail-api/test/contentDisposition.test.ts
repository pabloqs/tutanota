import test from "node:test"
import assert from "node:assert/strict"
import { attachmentContentDisposition } from "../lib/contentDisposition.js"

test("attachment Content-Disposition stays ASCII and preserves the original name in filename*", () => {
	const header = attachmentContentDisposition("(borrador) Síntesis de la discusión — Sección Brasil, 15_10_2026.docx")
	assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/)
	assert.doesNotMatch(header, /[^\x20-\x7E]/)
	assert.match(header, /filename="\(borrador\) Sintesis de la discusion _ Seccion Brasil, 15_10_2026\.docx"/)
	const star = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1]
	assert.equal(decodeURIComponent(star ?? ""), "(borrador) Síntesis de la discusión — Sección Brasil, 15_10_2026.docx")
})
