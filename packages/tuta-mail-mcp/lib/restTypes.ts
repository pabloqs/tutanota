/**
 * Minimal mirror of the `tuta-mail-api` response DTOs the MCP server consumes.
 * Defined locally (not imported from `@tutao/tuta-mail-api`) because that
 * package's entrypoint starts an HTTP server on import.
 */

export interface EmailAddress {
	name: string | null
	address: string
}

export interface Folder {
	id: string
	name: string
	kind: string
}

export interface Pagination {
	limit: number
	nextCursor: string | null
	hasMore: boolean
}

export interface MessageSummary {
	id: string
	subject: string
	receivedAt: string
	sentAt: string | null
	unread: boolean
	confidential: boolean
	state: string
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
	authStatus: string | null
	phishingStatus: string
	listUnsubscribe: boolean
	replyType: string
	bodyHtml: string
	bodyText: string
	headers: Record<string, string>
	attachments: MessageAttachment[]
}

export interface UpdateMessageResponse {
	messageId: string
	unread: boolean
}

export interface DeleteMessageResponse {
	messageId: string
	trashed: boolean
}

export interface SendMessageResponse {
	messageId: string
	status: "queued" | "sent"
}

export interface MoveMessageResponse {
	messageId: string
	moved: boolean
	targetFolderId: string
}

export interface SendAttachment {
	filename: string
	contentType: string
	contentBase64: string
}

/** Recipient shape accepted on send: `name` may be omitted, null, or a string. */
export interface SendEmailAddress {
	address: string
	name?: string | null
}

export interface SendMessageRequest {
	from?: SendEmailAddress
	to: SendEmailAddress[]
	cc?: SendEmailAddress[]
	bcc?: SendEmailAddress[]
	subject: string
	bodyText?: string
	bodyHtml?: string
	replyTo?: SendEmailAddress[]
	externalPassword?: string
	attachments?: SendAttachment[]
}

export interface ListMessagesParams {
	folder?: string
	cursor?: string
	limit?: number
	since?: string
	before?: string
	unread?: boolean
	from?: string
	hasAttachments?: boolean
}

/** One account entry from `GET /v1/health`. */
export interface HealthAccount {
	id: string
	label: string | null
	kind: string
	serviceMode: string
	mailOperationsReady: boolean
}

export interface HealthResponse {
	status: string
	accounts?: HealthAccount[]
}

export interface DownloadedAttachment {
	data: Buffer
	filename: string
	contentType: string
}
