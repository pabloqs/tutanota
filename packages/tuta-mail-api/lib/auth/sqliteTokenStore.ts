import Database from "better-sqlite3"
import type { Scope, TokenRecord } from "../dto/types.js"
import { hashToken, verifyTokenHash } from "./token.js"
import type { ITokenStore } from "./tokenStore.js"

type SqliteDb = InstanceType<typeof Database>

function rowToRecord(row: {
	token_id: string
	token_hash: string
	created_at_ms: number
	expires_at_ms: number
	scopes_json: string
	owner_label: string
	status: string
}): TokenRecord {
	return {
		tokenId: row.token_id,
		tokenHash: row.token_hash,
		createdAt: new Date(row.created_at_ms),
		expiresAt: new Date(row.expires_at_ms),
		scopes: JSON.parse(row.scopes_json) as Scope[],
		ownerLabel: row.owner_label,
		status: row.status as TokenRecord["status"],
	}
}

/** Persistent token store backed by SQLite (hashed tokens only). */
export class SqliteTokenStore implements ITokenStore {
	private readonly insertStmt: ReturnType<SqliteDb["prepare"]>
	private readonly selectByHashStmt: ReturnType<SqliteDb["prepare"]>
	private readonly selectByIdStmt: ReturnType<SqliteDb["prepare"]>
	private readonly updateRevokeStmt: ReturnType<SqliteDb["prepare"]>

	constructor(private readonly db: SqliteDb) {
		this.insertStmt = db.prepare(`
			INSERT INTO api_tokens (token_id, token_hash, created_at_ms, expires_at_ms, scopes_json, owner_label, status)
			VALUES (@token_id, @token_hash, @created_at_ms, @expires_at_ms, @scopes_json, @owner_label, @status)
			ON CONFLICT(token_hash) DO UPDATE SET
				expires_at_ms = excluded.expires_at_ms,
				scopes_json = excluded.scopes_json,
				owner_label = excluded.owner_label,
				status = excluded.status
		`)
		this.selectByHashStmt = db.prepare(`
			SELECT token_id, token_hash, created_at_ms, expires_at_ms, scopes_json, owner_label, status
			FROM api_tokens WHERE token_hash = ? AND status = 'active'
		`)
		this.selectByIdStmt = db.prepare(`
			SELECT token_id, token_hash, created_at_ms, expires_at_ms, scopes_json, owner_label, status
			FROM api_tokens WHERE token_id = ?
		`)
		this.updateRevokeStmt = db.prepare(`UPDATE api_tokens SET status = 'revoked' WHERE token_id = ?`)
	}

	add(record: TokenRecord): void {
		this.insertStmt.run({
			token_id: record.tokenId,
			token_hash: record.tokenHash,
			created_at_ms: record.createdAt.getTime(),
			expires_at_ms: record.expiresAt.getTime(),
			scopes_json: JSON.stringify(record.scopes),
			owner_label: record.ownerLabel,
			status: record.status,
		})
	}

	findByRawToken(rawToken: string): TokenRecord | null {
		const candidateHash = hashToken(rawToken)
		const row = this.selectByHashStmt.get(candidateHash) as
			| {
					token_id: string
					token_hash: string
					created_at_ms: number
					expires_at_ms: number
					scopes_json: string
					owner_label: string
					status: string
			  }
			| undefined
		if (!row) return null
		if (!verifyTokenHash(candidateHash, row.token_hash)) return null
		return rowToRecord(row)
	}

	revoke(tokenId: string): boolean {
		const info = this.updateRevokeStmt.run(tokenId)
		return info.changes > 0
	}

	getById(tokenId: string): TokenRecord | null {
		const row = this.selectByIdStmt.get(tokenId) as
			| {
					token_id: string
					token_hash: string
					created_at_ms: number
					expires_at_ms: number
					scopes_json: string
					owner_label: string
					status: string
			  }
			| undefined
		if (!row) return null
		return rowToRecord(row)
	}
}
