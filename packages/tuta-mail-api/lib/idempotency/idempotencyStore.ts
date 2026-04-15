/** Key-value cache for idempotent write responses (send/move). */
export interface ResponseCache<T> {
	get(key: string): T | null
	set(key: string, value: T): void
}

type Entry<T> = {
	expiresAt: number
	value: T
}

/** In-memory TTL cache (lost on restart). */
export class MemoryIdempotencyStore<T> implements ResponseCache<T> {
	private readonly entries = new Map<string, Entry<T>>()

	constructor(private readonly ttlMs: number) {}

	get(key: string): T | null {
		this.pruneExpired()
		const entry = this.entries.get(key)
		if (!entry) return null
		return entry.value
	}

	set(key: string, value: T): void {
		this.pruneExpired()
		this.entries.set(key, {
			expiresAt: Date.now() + this.ttlMs,
			value,
		})
	}

	private pruneExpired(): void {
		const now = Date.now()
		for (const [k, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(k)
		}
	}
}

/** @deprecated Use MemoryIdempotencyStore */
export class IdempotencyStore<T> extends MemoryIdempotencyStore<T> {}
