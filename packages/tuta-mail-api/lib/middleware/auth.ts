import type { Request, Response, NextFunction } from "express"
import type { Scope, ErrorEnvelope, TokenRecord } from "../dto/types.js"
import { validateTokenRecord, hasScope } from "../auth/token.js"
import type { ITokenStore } from "../auth/tokenStore.js"

declare global {
	namespace Express {
		interface Request {
			tokenRecord?: TokenRecord
			requestId?: string
		}
	}
}

function errorResponse(code: ErrorEnvelope["error"]["code"], message: string, requestId?: string): ErrorEnvelope {
	return { error: { code, message, requestId } }
}

/**
 * Extract bearer token from Authorization header, validate it, and attach
 * the token record to the request.
 */
export function authMiddleware(tokenStore: ITokenStore) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const authHeader = req.headers.authorization
		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			res.status(401).json(errorResponse("auth_error", "Missing or malformed Authorization header", req.requestId))
			return
		}

		const rawToken = authHeader.slice(7)
		if (!rawToken) {
			res.status(401).json(errorResponse("auth_error", "Empty bearer token", req.requestId))
			return
		}

		const record = tokenStore.findByRawToken(rawToken)
		const validation = validateTokenRecord(record)

		if (!validation.valid) {
			res.status(401).json(errorResponse("auth_error", validation.reason, req.requestId))
			return
		}

		req.tokenRecord = validation.record
		next()
	}
}

/**
 * Middleware factory that checks the authenticated token has a required scope.
 */
export function requireScope(scope: Scope) {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (!req.tokenRecord) {
			res.status(401).json(errorResponse("auth_error", "Not authenticated", req.requestId))
			return
		}
		if (!hasScope(req.tokenRecord, scope)) {
			res.status(403).json(errorResponse("permission_error", `Missing required scope: ${scope}`, req.requestId))
			return
		}
		next()
	}
}
