import type { ListMessagesQuery, MoveMessageRequest, SendMessageRequest, UpdateMessageRequest } from "./dto/types.js"

export class ValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ValidationError"
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function parseListMessagesQuery(query: Record<string, unknown>): ListMessagesQuery {
	const parsed: ListMessagesQuery = {}

	if (typeof query.folder === "string") parsed.folder = query.folder
	if (typeof query.cursor === "string") parsed.cursor = query.cursor
	if (query.limit !== undefined) {
		const limit = Number(query.limit)
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			throw new ValidationError("limit must be an integer between 1 and 200")
		}
		parsed.limit = limit
	}
	if (typeof query.since === "string") parsed.since = query.since
	if (typeof query.before === "string") parsed.before = query.before
	if (query.unread !== undefined) parsed.unread = String(query.unread) === "true"
	if (typeof query.from === "string") parsed.from = query.from
	if (query.hasAttachments !== undefined) parsed.hasAttachments = String(query.hasAttachments) === "true"

	return parsed
}

export function validateUpdateMessageRequest(body: unknown): UpdateMessageRequest {
	const payload = body as Partial<UpdateMessageRequest>
	if (typeof payload?.unread !== "boolean") {
		throw new ValidationError("unread must be boolean")
	}
	return { unread: payload.unread }
}

export function validateMoveMessageRequest(body: unknown): MoveMessageRequest {
	const payload = body as Partial<MoveMessageRequest>
	if (!isNonEmptyString(payload?.targetFolderId)) {
		throw new ValidationError("targetFolderId is required")
	}
	if (payload.idempotencyKey !== undefined && !isNonEmptyString(payload.idempotencyKey)) {
		throw new ValidationError("idempotencyKey must be a non-empty string")
	}
	return {
		targetFolderId: payload.targetFolderId,
		idempotencyKey: payload.idempotencyKey,
	}
}

export function validateSendMessageRequest(body: unknown): SendMessageRequest {
	const payload = body as Partial<SendMessageRequest>
	if (!Array.isArray(payload?.to) || payload.to.length === 0) {
		throw new ValidationError("to must contain at least one recipient")
	}
	for (const recipient of payload.to) {
		if (!recipient || !isNonEmptyString(recipient.address) || !isEmail(recipient.address)) {
			throw new ValidationError("to contains invalid email address")
		}
	}
	if (!isNonEmptyString(payload.subject)) {
		throw new ValidationError("subject is required")
	}
	if (!isNonEmptyString(payload.bodyText) && !isNonEmptyString(payload.bodyHtml)) {
		throw new ValidationError("either bodyText or bodyHtml must be provided")
	}
	const validateList = (list: SendMessageRequest["cc"] | SendMessageRequest["bcc"] | SendMessageRequest["replyTo"], field: string) => {
		if (!Array.isArray(list)) return
		for (const recipient of list) {
			if (!recipient || !isNonEmptyString(recipient.address) || !isEmail(recipient.address)) {
				throw new ValidationError(`${field} contains invalid email address`)
			}
		}
	}
	validateList(payload.cc, "cc")
	validateList(payload.bcc, "bcc")
	validateList(payload.replyTo, "replyTo")
	if (payload.attachments !== undefined) {
		if (!Array.isArray(payload.attachments)) throw new ValidationError("attachments must be an array")
		if (payload.attachments.length > 20) throw new ValidationError("attachments exceeds maximum of 20")
		for (const attachment of payload.attachments) {
			if (
				!attachment ||
				!isNonEmptyString(attachment.filename) ||
				!isNonEmptyString(attachment.contentType) ||
				!isNonEmptyString(attachment.contentBase64)
			) {
				throw new ValidationError("attachments contain invalid entry")
			}
		}
	}
	return payload as SendMessageRequest
}
