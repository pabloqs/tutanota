import test from "node:test"
import assert from "node:assert/strict"
import type { Request, Response, NextFunction } from "express"
import { rateLimitMiddleware } from "../lib/middleware/rateLimit.js"
import { requestIdMiddleware } from "../lib/middleware/requestId.js"
import { authMiddleware, requireScope } from "../lib/middleware/auth.js"
import { TokenStore } from "../lib/auth/tokenStore.js"
import { generateToken } from "../lib/auth/token.js"
import type { TokenRecord } from "../lib/dto/types.js"

interface MockRes {
	statusCode: number
	headers: Record<string, string | number>
	body: unknown
	status(code: number): MockRes
	json(payload: unknown): MockRes
	setHeader(name: string, value: string | number): void
}

function makeRes(): MockRes {
	const res: MockRes = {
		statusCode: 200,
		headers: {},
		body: undefined,
		status(code) {
			this.statusCode = code
			return this
		},
		json(payload) {
			this.body = payload
			return this
		},
		setHeader(name, value) {
			this.headers[name] = value
		},
	}
	return res
}

function makeReq(overrides: Partial<Request> = {}): Request {
	return { headers: {}, ...overrides } as unknown as Request
}

function nextSpy(): NextFunction & { called: number } {
	const fn = (() => {
		fn.called++
	}) as NextFunction & { called: number }
	fn.called = 0
	return fn
}

// ── requestId middleware ──

test("requestId: generates hex id when header absent", () => {
	const req = makeReq()
	const res = makeRes() as unknown as Response
	const next = nextSpy()
	requestIdMiddleware(req, res, next)
	assert.equal(next.called, 1)
	assert.match(req.requestId ?? "", /^[0-9a-f]{24}$/)
})

test("requestId: uses incoming x-request-id header verbatim", () => {
	const req = makeReq({ headers: { "x-request-id": "trace-123" } as any })
	const res = makeRes() as unknown as Response
	const next = nextSpy()
	requestIdMiddleware(req, res, next)
	assert.equal(req.requestId, "trace-123")
	assert.equal(next.called, 1)
})

// ── rateLimit middleware ──

test("rateLimit: allows requests under the cap and sets headers", () => {
	const mw = rateLimitMiddleware(3, 60_000)
	const req = makeReq({ ip: "1.2.3.4" } as any)
	const res = makeRes()
	const next = nextSpy()
	mw(req, res as unknown as Response, next)
	assert.equal(next.called, 1)
	assert.equal(res.headers["X-RateLimit-Limit"], 3)
	assert.equal(res.headers["X-RateLimit-Remaining"], 2)
	assert.ok(typeof res.headers["X-RateLimit-Reset"] === "number")
})

test("rateLimit: blocks with 429 once cap exceeded", () => {
	const mw = rateLimitMiddleware(2, 60_000)
	const req = makeReq({ ip: "9.9.9.9" } as any)
	const next = nextSpy()
	for (let i = 0; i < 2; i++) mw(req, makeRes() as unknown as Response, next)
	const res = makeRes()
	mw(req, res as unknown as Response, next)
	assert.equal(next.called, 2, "third call should NOT pass through")
	assert.equal(res.statusCode, 429)
	assert.deepEqual((res.body as any).error.code, "rate_limit_error")
	assert.equal(res.headers["X-RateLimit-Remaining"], 0)
})

test("rateLimit: resets after window expires", async () => {
	const mw = rateLimitMiddleware(1, 20)
	const req = makeReq({ ip: "5.5.5.5" } as any)
	const next = nextSpy()
	mw(req, makeRes() as unknown as Response, next)
	const blocked = makeRes()
	mw(req, blocked as unknown as Response, next)
	assert.equal(blocked.statusCode, 429)
	await new Promise((r) => setTimeout(r, 30))
	const allowed = makeRes()
	mw(req, allowed as unknown as Response, next)
	assert.equal(allowed.statusCode, 200)
})

test("rateLimit: keys per token ID when present", () => {
	const mw = rateLimitMiddleware(1, 60_000)
	const tokenA = { tokenId: "tok-A" } as TokenRecord
	const tokenB = { tokenId: "tok-B" } as TokenRecord
	const next = nextSpy()
	mw(makeReq({ tokenRecord: tokenA, ip: "shared" } as any), makeRes() as unknown as Response, next)
	const blocked = makeRes()
	mw(makeReq({ tokenRecord: tokenA, ip: "shared" } as any), blocked as unknown as Response, next)
	assert.equal(blocked.statusCode, 429)
	const allowed = makeRes()
	mw(makeReq({ tokenRecord: tokenB, ip: "shared" } as any), allowed as unknown as Response, next)
	assert.equal(allowed.statusCode, 200)
})

test("rateLimit: falls back to 'unknown' key when no token and no ip", () => {
	const mw = rateLimitMiddleware(5, 60_000)
	const next = nextSpy()
	const res = makeRes()
	mw(makeReq(), res as unknown as Response, next)
	assert.equal(next.called, 1)
	assert.equal(res.headers["X-RateLimit-Remaining"], 4)
})

// ── auth middleware ──

function setupStoreWithToken(scopes: any = ["mail:read:folders"]) {
	const store = new TokenStore()
	const { rawToken, record } = generateToken(scopes, "test", 60_000)
	store.add(record)
	return { store, rawToken, record }
}

test("authMiddleware: 401 when Authorization header missing", () => {
	const { store } = setupStoreWithToken()
	const mw = authMiddleware(store)
	const req = makeReq()
	const res = makeRes()
	const next = nextSpy()
	mw(req, res as unknown as Response, next)
	assert.equal(res.statusCode, 401)
	assert.equal((res.body as any).error.code, "auth_error")
	assert.match((res.body as any).error.message, /Missing or malformed/)
	assert.equal(next.called, 0)
})

test("authMiddleware: 401 when scheme is not Bearer", () => {
	const { store } = setupStoreWithToken()
	const mw = authMiddleware(store)
	const req = makeReq({ headers: { authorization: "Basic abcd" } as any })
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 401)
})

test("authMiddleware: 401 when bearer token is empty", () => {
	const { store } = setupStoreWithToken()
	const mw = authMiddleware(store)
	const req = makeReq({ headers: { authorization: "Bearer " } as any })
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 401)
	assert.match((res.body as any).error.message, /Empty bearer token/)
})

test("authMiddleware: 401 when token unknown", () => {
	const { store } = setupStoreWithToken()
	const mw = authMiddleware(store)
	const req = makeReq({ headers: { authorization: "Bearer not-a-real-token" } as any })
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 401)
})

test("authMiddleware: 401 when token revoked", () => {
	const { store, rawToken, record } = setupStoreWithToken()
	store.revoke(record.tokenId)
	const mw = authMiddleware(store)
	const req = makeReq({ headers: { authorization: `Bearer ${rawToken}` } as any })
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 401)
})

test("authMiddleware: attaches tokenRecord and calls next when valid", () => {
	const { store, rawToken } = setupStoreWithToken(["mail:read:folders"])
	const mw = authMiddleware(store)
	const req = makeReq({ headers: { authorization: `Bearer ${rawToken}` } as any })
	const res = makeRes()
	const next = nextSpy()
	mw(req, res as unknown as Response, next)
	assert.equal(next.called, 1)
	assert.equal(req.tokenRecord?.ownerLabel, "test")
})

test("authMiddleware: propagates requestId into error envelope", () => {
	const { store } = setupStoreWithToken()
	const mw = authMiddleware(store)
	const req = makeReq({ headers: {}, requestId: "req-99" } as any)
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal((res.body as any).error.requestId, "req-99")
})

// ── requireScope ──

test("requireScope: 401 when no tokenRecord on request", () => {
	const mw = requireScope("mail:send")
	const req = makeReq()
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 401)
})

test("requireScope: 403 when scope is missing", () => {
	const { record } = setupStoreWithToken(["mail:read:folders"])
	const mw = requireScope("mail:send")
	const req = makeReq({ tokenRecord: record } as any)
	const res = makeRes()
	mw(req, res as unknown as Response, nextSpy())
	assert.equal(res.statusCode, 403)
	assert.equal((res.body as any).error.code, "permission_error")
	assert.match((res.body as any).error.message, /mail:send/)
})

test("requireScope: passes when scope present", () => {
	const { record } = setupStoreWithToken(["mail:send"])
	const mw = requireScope("mail:send")
	const req = makeReq({ tokenRecord: record } as any)
	const res = makeRes()
	const next = nextSpy()
	mw(req, res as unknown as Response, next)
	assert.equal(next.called, 1)
	assert.equal(res.statusCode, 200)
})
