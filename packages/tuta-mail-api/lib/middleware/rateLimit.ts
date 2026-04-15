import type { Request, Response, NextFunction } from "express"
import type { ErrorEnvelope } from "../dto/types.js"

interface RateLimitEntry {
	count: number
	resetAt: number
}

/**
 * Simple in-memory sliding-window rate limiter keyed by token ID.
 * Production deployments should use Redis or similar.
 */
export function rateLimitMiddleware(maxRequests: number, windowMs: number) {
	const entries = new Map<string, RateLimitEntry>()

	// Periodic cleanup to avoid unbounded growth
	setInterval(() => {
		const now = Date.now()
		for (const [key, entry] of entries) {
			if (entry.resetAt <= now) {
				entries.delete(key)
			}
		}
	}, windowMs).unref()

	return (req: Request, res: Response, next: NextFunction): void => {
		const key = req.tokenRecord?.tokenId ?? req.ip ?? "unknown"
		const now = Date.now()
		let entry = entries.get(key)

		if (!entry || entry.resetAt <= now) {
			entry = { count: 0, resetAt: now + windowMs }
			entries.set(key, entry)
		}

		entry.count++

		res.setHeader("X-RateLimit-Limit", maxRequests)
		res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count))
		res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000))

		if (entry.count > maxRequests) {
			const error: ErrorEnvelope = {
				error: {
					code: "rate_limit_error",
					message: "Too many requests",
					requestId: req.requestId,
				},
			}
			res.status(429).json(error)
			return
		}

		next()
	}
}
