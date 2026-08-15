import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { TokenRecord, Scope } from "../dto/types.js"

/**
 * Generate a strong bearer token with 256-bit random entropy.
 * Returns the raw token string (to be given to the client once)
 * and the hashed form (to be stored).
 */
export function generateToken(scopes: Scope[], ownerLabel: string, ttlMs: number, accountId: string = "default"): { rawToken: string; record: TokenRecord } {
	const raw = randomBytes(32)
	const tokenId = randomBytes(16).toString("hex")
	const rawToken = raw.toString("base64url")
	const tokenHash = hashToken(rawToken)
	const now = new Date()

	return {
		rawToken,
		record: {
			tokenId,
			tokenHash,
			createdAt: now,
			expiresAt: new Date(now.getTime() + ttlMs),
			scopes,
			ownerLabel,
			status: "active",
			accountId,
		},
	}
}

/** SHA-256 hash a raw token for storage. */
export function hashToken(rawToken: string): string {
	return createHash("sha256").update(rawToken).digest("hex")
}

/**
 * Constant-time comparison of two token hashes.
 * Both inputs must be hex-encoded SHA-256 hashes (64 chars).
 */
export function verifyTokenHash(candidateHash: string, storedHash: string): boolean {
	const a = Buffer.from(candidateHash, "hex")
	const b = Buffer.from(storedHash, "hex")
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

/** Check that a token record is valid (active, not expired). */
export function validateTokenRecord(record: TokenRecord | null): { valid: true; record: TokenRecord } | { valid: false; reason: string } {
	if (!record) {
		return { valid: false, reason: "Token not found" }
	}
	if (record.status === "revoked") {
		return { valid: false, reason: "Token has been revoked" }
	}
	if (record.expiresAt.getTime() < Date.now()) {
		return { valid: false, reason: "Token has expired" }
	}
	return { valid: true, record }
}

/** Check whether a token's scopes include the required scope. */
export function hasScope(record: TokenRecord, requiredScope: Scope): boolean {
	return record.scopes.includes(requiredScope)
}
