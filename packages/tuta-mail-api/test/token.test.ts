import test from "node:test"
import assert from "node:assert/strict"
import { generateToken, hashToken, verifyTokenHash, validateTokenRecord } from "../lib/auth/token.js"

test("generateToken returns raw token and active record", () => {
	const { rawToken, record } = generateToken(["mail:read:folders"], "owner", 1000)
	assert.ok(rawToken.length > 10)
	assert.equal(record.ownerLabel, "owner")
	assert.equal(record.status, "active")
	assert.ok(record.expiresAt.getTime() > record.createdAt.getTime())
})

test("hash and verify token hash", () => {
	const raw = "abc123"
	const hash = hashToken(raw)
	assert.equal(verifyTokenHash(hashToken(raw), hash), true)
	assert.equal(verifyTokenHash(hashToken("wrong"), hash), false)
})

test("validate token record rejects expired and revoked", () => {
	const base = generateToken(["mail:read:folders"], "owner", 1000).record
	base.status = "revoked"
	assert.equal(validateTokenRecord(base).valid, false)

	const expired = generateToken(["mail:read:folders"], "owner", -1000).record
	assert.equal(validateTokenRecord(expired).valid, false)
})
