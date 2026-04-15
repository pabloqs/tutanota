import type { Request, Response, NextFunction } from "express"
import { randomBytes } from "node:crypto"

/** Attach a unique request ID to each request for tracing and error responses. */
export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
	req.requestId = (req.headers["x-request-id"] as string) ?? randomBytes(12).toString("hex")
	next()
}
