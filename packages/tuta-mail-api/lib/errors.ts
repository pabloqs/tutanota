import type { ErrorCode } from "./dto/types.js"

export class ApiServiceError extends Error {
	constructor(
		public readonly code: ErrorCode,
		public readonly status: number,
		message: string,
	) {
		super(message)
		this.name = "ApiServiceError"
	}
}

export function upstreamUnavailable(message = "Upstream service unavailable"): ApiServiceError {
	return new ApiServiceError("upstream_unavailable", 503, message)
}

/** Password-protected external send prerequisites are not met (bridge/SDK). */
export function externalSecureSendUnavailable(message: string): ApiServiceError {
	return new ApiServiceError("external_secure_send_unavailable", 422, message)
}
