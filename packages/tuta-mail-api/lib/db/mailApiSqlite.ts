import Database from "better-sqlite3"

type OpenedSqliteDb = InstanceType<typeof Database>

export function openMailApiDatabase(path: string): OpenedSqliteDb {
	const db = new Database(path)
	db.pragma("journal_mode = WAL")
	db.pragma("foreign_keys = ON")
	migrate(db)
	return db
}

function migrate(db: InstanceType<typeof Database>): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS api_tokens (
			token_id TEXT PRIMARY KEY NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			scopes_json TEXT NOT NULL,
			owner_label TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
			account_id TEXT NOT NULL DEFAULT 'default'
		);

		CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens(expires_at_ms);

		CREATE TABLE IF NOT EXISTS idempotency_responses (
			cache_key TEXT PRIMARY KEY NOT NULL,
			response_json TEXT NOT NULL,
			expires_at_ms INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_responses(expires_at_ms);
	`)

	// Add account_id to pre-existing databases (tokens created before multi-account support default to 'default').
	const tokenColumns = db.prepare(`PRAGMA table_info(api_tokens)`).all() as Array<{ name: string }>
	if (!tokenColumns.some((c) => c.name === "account_id")) {
		db.exec(`ALTER TABLE api_tokens ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default'`)
	}
}
