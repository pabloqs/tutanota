import type {
	Folder,
	MessageSummary,
	MessageDetail,
	ListMessagesQuery,
	UpdateMessageResponse,
	DeleteMessageResponse,
	SendMessageRequest,
	SendMessageResponse,
	MoveMessageRequest,
	MoveMessageResponse,
	Pagination,
} from "../dto/types.js"
import type { MailService, AttachmentContent } from "./mailService.js"
import { mapFolderKind, mapMailState, mapReplyType, mapAuthStatus, mapPhishingStatus, mapEmailAddress } from "./mailService.js"
import { ApiServiceError } from "../errors.js"

const FOLDER_KIND_ALIASES = new Set(["inbox", "sent", "trash", "archive", "spam", "draft", "drafts", "custom", "all"])

/**
 * Tuta SDK wrapper that implements the MailService interface.
 *
 * This is a placeholder implementation that defines the contract.
 * The actual SDK binding (via NAPI/Rust or TypeScript worker facade)
 * will be wired in during Phase 4 integration.
 *
 * Each method documents exactly which SDK calls it wraps.
 */
export class TutaMailService implements MailService {
	constructor(private readonly sdkClient: TutaSdkClient) {}

	/**
	 * SDK calls: MailFacade.loadUserMailbox() → MailFacade.loadFoldersForMailbox()
	 */
	async listFolders(): Promise<Folder[]> {
		const rawFolders = await this.sdkClient.loadFolders()
		return rawFolders.map((f) => ({
			id: f.id,
			name: f.name,
			kind: mapFolderKind(f.folderType),
		}))
	}

	/**
	 * SDK calls: CryptoEntityClient.loadRange() on mail list with pagination.
	 * Filtering applied post-load (date range, sender, unread, hasAttachments).
	 */
	async listMessages(query: ListMessagesQuery): Promise<{ data: MessageSummary[]; pagination: Pagination }> {
		const limit = query.limit ?? 50
		const rawMails = await this.sdkClient.loadMails({
			folderId: await this.resolveFolderId(query.folder),
			cursor: query.cursor,
			count: limit + 1, // fetch one extra to determine hasMore
		})

		let mails = rawMails.map((m) => this.mapToSummary(m))

		// Apply filters
		if (query.since) {
			const since = new Date(query.since).getTime()
			mails = mails.filter((m) => new Date(m.receivedAt).getTime() >= since)
		}
		if (query.before) {
			const before = new Date(query.before).getTime()
			mails = mails.filter((m) => new Date(m.receivedAt).getTime() < before)
		}
		if (query.unread !== undefined) {
			mails = mails.filter((m) => m.unread === query.unread)
		}
		if (query.from) {
			const fromLower = query.from.toLowerCase()
			mails = mails.filter((m) => m.from.address.toLowerCase().includes(fromLower))
		}
		if (query.hasAttachments !== undefined) {
			mails = mails.filter((m) => m.hasAttachments === query.hasAttachments)
		}

		const hasMore = mails.length > limit
		const data = mails.slice(0, limit)
		const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null

		return {
			data,
			pagination: { limit, hasMore, nextCursor },
		}
	}

	/**
	 * SDK calls: CryptoEntityClient.load(MailTypeRef, id) → MailFacade.loadMailDetailsBlob()
	 */
	async getMessage(id: string): Promise<MessageDetail | null> {
		const raw = await this.sdkClient.loadMail(id)
		if (!raw) return null

		const details = await this.sdkClient.loadMailDetails(raw)
		if (!details) return null

		const attachments = await this.sdkClient.loadAttachmentMeta(raw)

		return {
			...this.mapToSummary(raw),
			to: (details.recipients?.toRecipients ?? []).map(mapEmailAddress),
			cc: (details.recipients?.ccRecipients ?? []).map(mapEmailAddress),
			bcc: (details.recipients?.bccRecipients ?? []).map(mapEmailAddress),
			replyTo: (details.replyTos ?? []).map(mapEmailAddress),
			envelopeSender: raw.differentEnvelopeSender || null,
			authStatus: mapAuthStatus(raw.authStatus),
			phishingStatus: mapPhishingStatus(raw.phishingStatus),
			listUnsubscribe: raw.listUnsubscribe ?? false,
			replyType: mapReplyType(raw.replyType),
			bodyHtml: details.body?.text ?? "",
			bodyText: details.body?.text ?? "",
			headers: details.headers ?? {},
			attachments: attachments.map((a) => ({
				id: a.id,
				filename: a.name,
				contentType: a.mimeType,
				sizeBytes: a.size,
				contentId: a.cid || null,
			})),
		}
	}

	/**
	 * SDK calls: BlobFacade.downloadAttachment()
	 */
	async downloadAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent | null> {
		return this.sdkClient.downloadAttachment(messageId, attachmentId)
	}

	/**
	 * SDK calls: MailFacade.markMails() / setUnreadStatusForMails()
	 */
	async updateMessage(id: string, unread: boolean): Promise<UpdateMessageResponse | null> {
		const success = await this.sdkClient.setUnread(id, unread)
		if (!success) return null
		return { messageId: id, unread }
	}

	/**
	 * SDK calls: MailFacade.trashMails()
	 */
	async deleteMessage(id: string): Promise<DeleteMessageResponse | null> {
		const success = await this.sdkClient.trashMail(id)
		if (!success) return null
		return { messageId: id, trashed: true }
	}

	/**
	 * SDK calls: MailFacade.createDraft() → MailFacade.sendDraft()
	 */
	async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
		const messageId = await this.sdkClient.sendMail(request)
		return { messageId, status: "sent" }
	}

	/**
	 * SDK calls: MailFacade.simpleMoveMaill()
	 */
	async moveMessage(id: string, request: MoveMessageRequest): Promise<MoveMessageResponse | null> {
		const targetFolderId = await this.resolveFolderId(request.targetFolderId)
		if (!targetFolderId) return null
		const success = await this.sdkClient.moveMail(id, targetFolderId)
		if (!success) return null
		return { messageId: id, moved: true, targetFolderId }
	}

	/**
	 * Accept kind aliases (`inbox`, `sent`, …) in addition to opaque Tuta folder ids.
	 * The SDK bridge only understands ids; without this, `folder=inbox` becomes
	 * `Unknown folder id inbox`.
	 */
	private async resolveFolderId(folder: string | undefined): Promise<string | undefined> {
		const raw = folder?.trim()
		if (!raw) return undefined
		if (!FOLDER_KIND_ALIASES.has(raw.toLowerCase())) return raw
		const want = raw.toLowerCase() === "drafts" ? "draft" : raw.toLowerCase()
		const folders = await this.listFolders()
		const byKind = folders.find((f) => f.kind === want)
		if (byKind) return byKind.id
		const byName = folders.find((f) => f.name.toLowerCase() === raw.toLowerCase() || f.name.toLowerCase() === want)
		if (byName) return byName.id
		throw new ApiServiceError("validation_error", 400, `Unknown folder kind/name '${folder}'`)
	}

	private mapToSummary(raw: RawMail): MessageSummary {
		return {
			id: raw.id,
			subject: raw.subject,
			receivedAt: raw.receivedDate,
			sentAt: raw.sentDate ?? null,
			unread: raw.unread,
			confidential: raw.confidential,
			state: mapMailState(raw.state),
			hasAttachments: (raw.attachmentCount ?? 0) > 0,
			folderIds: raw.folderIds ?? [],
			from: mapEmailAddress(raw.sender),
		}
	}
}

// ── SDK Client Interface ──
// This abstracts the actual Tuta SDK calls so TutaMailService stays testable.

export interface TutaSdkClient {
	loadFolders(): Promise<RawFolder[]>
	loadMails(opts: { folderId?: string; cursor?: string; count: number }): Promise<RawMail[]>
	loadMail(id: string): Promise<RawMail | null>
	loadMailDetails(mail: RawMail): Promise<RawMailDetails | null>
	loadAttachmentMeta(mail: RawMail): Promise<RawAttachment[]>
	downloadAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent | null>
	setUnread(id: string, unread: boolean): Promise<boolean>
	trashMail(id: string): Promise<boolean>
	sendMail(request: SendMessageRequest): Promise<string>
	moveMail(id: string, targetFolderId: string): Promise<boolean>
}

export interface RawFolder {
	id: string
	name: string
	folderType: number
}

export interface RawMail {
	id: string
	subject: string
	receivedDate: string
	sentDate?: string
	unread: boolean
	confidential: boolean
	state: number
	sender: { name: string; address: string }
	attachmentCount?: number
	folderIds?: string[]
	differentEnvelopeSender?: string
	authStatus: number | null
	phishingStatus: number
	listUnsubscribe?: boolean
	replyType: number
	mailDetails?: string
	mailDetailsDraft?: string
}

export interface RawMailDetails {
	sentDate?: string
	recipients?: {
		toRecipients: { name: string; address: string }[]
		ccRecipients: { name: string; address: string }[]
		bccRecipients: { name: string; address: string }[]
	}
	replyTos?: { name: string; address: string }[]
	body?: { text: string }
	headers?: Record<string, string>
}

export interface RawAttachment {
	id: string
	name: string
	mimeType: string
	size: number
	cid?: string
}
