import type {
	Folder,
	MessageSummary,
	MessageDetail,
	MessageAttachment,
	ListMessagesQuery,
	UpdateMessageResponse,
	DeleteMessageResponse,
	SendMessageRequest,
	SendMessageResponse,
	MoveMessageRequest,
	MoveMessageResponse,
	EmailAddress,
	FolderKind,
	Pagination,
} from "../dto/types.js"

/** Binary content returned for attachment downloads. */
export interface AttachmentContent {
	data: Buffer
	filename: string
	contentType: string
}

/**
 * Abstract mail service interface. Decouples API routes from the
 * underlying Tuta SDK implementation.
 *
 * Each method corresponds to one API endpoint's business logic.
 */
export interface MailService {
	listFolders(): Promise<Folder[]>

	listMessages(query: ListMessagesQuery): Promise<{ data: MessageSummary[]; pagination: Pagination }>

	getMessage(id: string): Promise<MessageDetail | null>

	downloadAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent | null>

	updateMessage(id: string, unread: boolean): Promise<UpdateMessageResponse | null>

	deleteMessage(id: string): Promise<DeleteMessageResponse | null>

	sendMessage(request: SendMessageRequest): Promise<SendMessageResponse>

	moveMessage(id: string, request: MoveMessageRequest): Promise<MoveMessageResponse | null>
}

// ── Helpers for mapping Tuta internal values to API DTOs ──

const FOLDER_KIND_MAP: Record<number, FolderKind> = {
	0: "custom",
	1: "inbox",
	2: "sent",
	3: "trash",
	4: "archive",
	5: "spam",
	6: "draft",
	7: "all",
}

const MAIL_STATE_MAP: Record<number, MessageSummary["state"]> = {
	0: "received",
	1: "draft",
	2: "sent",
}

const REPLY_TYPE_MAP: Record<number, MessageDetail["replyType"]> = {
	0: "none",
	1: "reply",
	2: "reply_all",
	3: "forward",
}

const AUTH_STATUS_MAP: Record<number, MessageDetail["authStatus"]> = {
	0: "unknown",
	1: "pass",
	2: "soft_fail",
	3: "fail",
	4: "none",
}

const PHISHING_STATUS_MAP: Record<number, MessageDetail["phishingStatus"]> = {
	0: "unknown",
	1: "suspicious",
	2: "phishing",
}

export function mapFolderKind(kind: number): FolderKind {
	return FOLDER_KIND_MAP[kind] ?? "custom"
}

export function mapMailState(state: number): MessageSummary["state"] {
	return MAIL_STATE_MAP[state] ?? "received"
}

export function mapReplyType(replyType: number): MessageDetail["replyType"] {
	return REPLY_TYPE_MAP[replyType] ?? "none"
}

export function mapAuthStatus(status: number | null): MessageDetail["authStatus"] {
	if (status == null) return null
	return AUTH_STATUS_MAP[status] ?? "unknown"
}

export function mapPhishingStatus(status: number): MessageDetail["phishingStatus"] {
	return PHISHING_STATUS_MAP[status] ?? "unknown"
}

export function mapEmailAddress(addr: { name: string; address: string }): EmailAddress {
	return {
		name: addr.name || null,
		address: addr.address,
	}
}
