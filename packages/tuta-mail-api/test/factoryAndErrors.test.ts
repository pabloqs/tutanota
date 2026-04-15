import test from "node:test"
import assert from "node:assert/strict"
import { createMailService } from "../lib/services/factory.js"
import { DevMailService } from "../lib/services/devMailService.js"
import { TutaMailService } from "../lib/services/tutaMailService.js"
import { SdkUnavailableClient } from "../lib/services/sdkUnavailableClient.js"
import { ApiServiceError, externalSecureSendUnavailable, upstreamUnavailable } from "../lib/errors.js"
import type { ApiConfig } from "../lib/config/env.js"

const baseCfg: ApiConfig = {
	port: 0,
	host: "127.0.0.1",
	tutaApiUrl: "https://app.tuta.com",
	maxAttachmentBytes: 10_000_000,
	rateLimitMax: 100,
	rateLimitWindowMs: 60_000,
	serviceMode: "dev",
	idempotencyTtlMs: 60_000,
	dbPath: null,
	tutaBridgeBaseUrl: null,
	tutaBridgeAuthToken: null,
	tutaBridgeTimeoutMs: 60_000,
}

test("factory: dev mode returns DevMailService", () => {
	const svc = createMailService({ ...baseCfg, serviceMode: "dev" })
	assert.ok(svc instanceof DevMailService)
})

test("factory: tuta mode + bridge url returns TutaMailService", () => {
	const svc = createMailService({ ...baseCfg, serviceMode: "tuta", tutaBridgeBaseUrl: "http://localhost:4711" })
	assert.ok(svc instanceof TutaMailService)
})

test("factory: tuta mode without bridge url returns TutaMailService backed by SdkUnavailableClient", async () => {
	const svc = createMailService({ ...baseCfg, serviceMode: "tuta", tutaBridgeBaseUrl: null })
	assert.ok(svc instanceof TutaMailService)
	await assert.rejects(svc.listFolders(), (err: any) => {
		assert.ok(err instanceof ApiServiceError)
		assert.equal(err.code, "upstream_unavailable")
		return true
	})
})

test("ApiServiceError carries code, status, message", () => {
	const e = new ApiServiceError("validation_error", 400, "bad input")
	assert.equal(e.code, "validation_error")
	assert.equal(e.status, 400)
	assert.equal(e.message, "bad input")
	assert.equal(e.name, "ApiServiceError")
	assert.ok(e instanceof Error)
})

test("upstreamUnavailable factory defaults message and sets status 503", () => {
	const e = upstreamUnavailable()
	assert.equal(e.code, "upstream_unavailable")
	assert.equal(e.status, 503)
	assert.equal(e.message, "Upstream service unavailable")
	const e2 = upstreamUnavailable("custom")
	assert.equal(e2.message, "custom")
})

test("externalSecureSendUnavailable factory yields code+status 422", () => {
	const e = externalSecureSendUnavailable("need password")
	assert.equal(e.code, "external_secure_send_unavailable")
	assert.equal(e.status, 422)
	assert.equal(e.message, "need password")
})

test("SdkUnavailableClient: every method rejects with upstream_unavailable", async () => {
	const c = new SdkUnavailableClient()
	const calls: Array<Promise<unknown>> = [
		c.loadFolders(),
		c.loadMails({ count: 1 }),
		c.loadMail("x"),
		c.loadMailDetails({ id: "x" } as any),
		c.loadAttachmentMeta({ id: "x" } as any),
		c.downloadAttachment("m", "a"),
		c.setUnread("x", true),
		c.trashMail("x"),
		c.sendMail({ to: [{ name: null, address: "a@b.com" }], subject: "s" } as any),
		c.moveMail("x", "y"),
	]
	for (const p of calls) {
		await assert.rejects(p, (err: any) => {
			assert.equal(err.code, "upstream_unavailable")
			assert.match(err.message, /TUTA_BRIDGE_BASE_URL|MAIL_API_SERVICE_MODE/)
			return true
		})
	}
})
