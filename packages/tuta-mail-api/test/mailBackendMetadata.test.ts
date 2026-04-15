import test from "node:test"
import assert from "node:assert/strict"
import type { ApiConfig } from "../lib/config/env.js"
import { getMailBackendMetadata } from "../lib/config/mailBackendMetadata.js"

const base: ApiConfig = {
	port: 3100,
	host: "127.0.0.1",
	tutaApiUrl: "https://app.tuta.com",
	maxAttachmentBytes: 1,
	rateLimitMax: 1,
	rateLimitWindowMs: 1,
	serviceMode: "dev",
	idempotencyTtlMs: 1,
	dbPath: null,
	tutaBridgeBaseUrl: null,
	tutaBridgeAuthToken: null,
	tutaBridgeTimeoutMs: 1,
}

test("getMailBackendMetadata dev mode", () => {
	const m = getMailBackendMetadata(base)
	assert.equal(m.kind, "dev_stub")
	assert.equal(m.mailOperationsReady, true)
	assert.equal(m.bridgeBaseUrl, null)
})

test("getMailBackendMetadata tuta with bridge", () => {
	const m = getMailBackendMetadata({
		...base,
		serviceMode: "tuta",
		tutaBridgeBaseUrl: "http://127.0.0.1:9999",
	})
	assert.equal(m.kind, "http_bridge")
	assert.equal(m.mailOperationsReady, true)
	assert.equal(m.bridgeBaseUrl, "http://127.0.0.1:9999")
})

test("getMailBackendMetadata tuta without bridge", () => {
	const m = getMailBackendMetadata({ ...base, serviceMode: "tuta" })
	assert.equal(m.kind, "tuta_unconfigured")
	assert.equal(m.mailOperationsReady, false)
})
