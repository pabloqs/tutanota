import Database from "better-sqlite3"
import type { ResponseCache } from "./idempotencyStore.js"

type SqliteDb = InstanceType<typeof Database>

/** Persists idempotent API responses until TTL expires (survives process restarts). */
export class SqliteIdempotencyStore<T> implements ResponseCache<T> {
	private readonly selectStmt: ReturnType<SqliteDb["prepare"]>
	private readonly upsertStmt: ReturnType<SqliteDb["prepare"]>
	private readonly deleteExpiredStmt: ReturnType<SqliteDb["prepare"]>

	constructor(
		private readonly db: SqliteDb,
		private readonly ttlMs: number,
	) {
		this.deleteExpiredStmt = db.prepare(`DELETE FROM idempotency_responses WHERE expires_at_ms < ?`)
		this.selectStmt = db.prepare(`
			SELECT response_json FROM idempotency_responses
			WHERE cache_key = @cache_key AND expires_at_ms >= @now
		`)
		this.upsertStmt = db.prepare(`
			INSERT INTO idempotency_responses (cache_key, response_json, expires_at_ms)
			VALUES (@cache_key, @response_json, @expires_at_ms)
			ON CONFLICT(cache_key) DO UPDATE SET
				response_json = excluded.response_json,
				expires_at_ms = excluded.expires_at_ms
		`)
	}

	get(key: string): T | null {
		const now = Date.now()
		this.deleteExpiredStmt.run(now)
		const row = this.selectStmt.get({ cache_key: key, now }) as { response_json: string } | undefined
		if (!row) return null
		try {
			return JSON.parse(row.response_json) as T
		} catch {
			return null
		}
	}

	set(key: string, value: T): void {
		const now = Date.now()
		this.deleteExpiredStmt.run(now)
		this.upsertStmt.run({
			cache_key: key,
			response_json: JSON.stringify(value),
			expires_at_ms: now + this.ttlMs,
		})
	}
}
