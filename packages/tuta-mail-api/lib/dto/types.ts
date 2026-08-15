/** Matches OpenAPI ErrorEnvelope schema. */
export interface ErrorEnvelope {
	error: {
		code: ErrorCode
		message: string
		requestId?: string
	}
}

export type ErrorCode =
	| "auth_error"
	| "external_secure_send_unavailable"
	| "permission_error"
	| "rate_limit_error"
	| "upstream_unavailable"
	| "validation_error"
	| "internal_error"

export interface Pagination {
	limit: number
	nextCursor: string | null
	hasMore: boolean
}

export interface EmailAddress {
	name: string | null
	address: string
}

export interface Folder {
	id: string
	name: string
	kind: FolderKind
}

export type FolderKind = "inbox" | "sent" | "trash" | "archive" | "spam" | "draft" | "custom" | "all"

export interface MessageSummary {
	id: string
	subject: string
	receivedAt: string
	sentAt: string | null
	unread: boolean
	confidential: boolean
	state: "received" | "draft" | "sent"
	hasAttachments: boolean
	folderIds: string[]
	from: EmailAddress
}

export interface MessageAttachment {
	id: string
	filename: string
	contentType: string
	sizeBytes: number
	contentId: string | null
}

export interface MessageDetail extends MessageSummary {
	to: EmailAddress[]
	cc: EmailAddress[]
	bcc: EmailAddress[]
	replyTo: EmailAddress[]
	envelopeSender: string | null
	authStatus: "pass" | "fail" | "soft_fail" | "none" | "unknown" | null
	phishingStatus: "unknown" | "suspicious" | "phishing"
	listUnsubscribe: boolean
	replyType: "none" | "reply" | "reply_all" | "forward"
	bodyHtml: string
	bodyText: string
	headers: Record<string, string>
	attachments: MessageAttachment[]
}

export interface UpdateMessageRequest {
	unread: boolean
}

export interface UpdateMessageResponse {
	messageId: string
	unread: boolean
}

export interface DeleteMessageResponse {
	messageId: string
	trashed: boolean
}

export interface SendMessageRequest {
	from?: EmailAddress
	to: EmailAddress[]
	cc?: EmailAddress[]
	bcc?: EmailAddress[]
	subject: string
	bodyText?: string
	bodyHtml?: string
	replyTo?: EmailAddress[]
	/** When set with a non-empty value, the bridge sends password-protected mail to non-Tuta addresses (Argon2id + external user provisioning). */
	externalPassword?: string
	attachments?: SendAttachment[]
}

export interface SendAttachment {
	filename: string
	contentType: string
	contentBase64: string
}

export interface SendMessageResponse {
	messageId: string
	status: "queued" | "sent"
}

export interface MoveMessageRequest {
	targetFolderId: string
	idempotencyKey?: string
}

export interface MoveMessageResponse {
	messageId: string
	moved: boolean
	targetFolderId: string
}

/** Query params for GET /v1/messages */
export interface ListMessagesQuery {
	folder?: string
	cursor?: string
	limit?: number
	since?: string
	before?: string
	unread?: boolean
	from?: string
	hasAttachments?: boolean
}

/** Token metadata stored alongside hashed token. */
export interface TokenRecord {
	tokenId: string
	tokenHash: string
	createdAt: Date
	expiresAt: Date
	scopes: Scope[]
	ownerLabel: string
	status: "active" | "revoked"
	/** Account this token is bound to (see {@link AccountConfig.id}). Defaults to `"default"` for single-account deployments. */
	accountId: string
}

export type Scope = "mail:read:folders" | "mail:read:messages" | "mail:write" | "mail:send" | "mail:move" | "mail:delete"
