import type { TokenRecord } from "../dto/types.js"
import { hashToken, verifyTokenHash } from "./token.js"

export interface ITokenStore {
	add(record: TokenRecord): void
	findByRawToken(rawToken: string): TokenRecord | null
	revoke(tokenId: string): boolean
	getById(tokenId: string): TokenRecord | null
}

/**
 * In-memory token store. For production persistence use {@link SqliteTokenStore}
 * with `MAIL_API_DB_PATH` set.
 *
 * Tokens are looked up by hash equality after computing the candidate hash.
 */
export class TokenStore implements ITokenStore {
	private readonly records: Map<string, TokenRecord> = new Map()

	add(record: TokenRecord): void {
		this.records.set(record.tokenId, record)
	}

	/** Find a token record by raw token (constant-time hash compare). */
	findByRawToken(rawToken: string): TokenRecord | null {
		const candidateHash = hashToken(rawToken)
		for (const record of this.records.values()) {
			if (record.status !== "active") continue
			if (verifyTokenHash(candidateHash, record.tokenHash)) {
				return record
			}
		}
		return null
	}

	revoke(tokenId: string): boolean {
		const record = this.records.get(tokenId)
		if (!record) return false
		record.status = "revoked"
		return true
	}

	getById(tokenId: string): TokenRecord | null {
		return this.records.get(tokenId) ?? null
	}
}
