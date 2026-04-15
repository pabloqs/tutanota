import type {
	DeleteMessageResponse,
	Folder,
	ListMessagesQuery,
	MessageDetail,
	MessageSummary,
	MoveMessageRequest,
	MoveMessageResponse,
	Pagination,
	SendMessageRequest,
	SendMessageResponse,
	UpdateMessageResponse,
} from "../dto/types.js"
import type { AttachmentContent, MailService } from "./mailService.js"

const folderData: Folder[] = [
	{ id: "inbox", name: "Inbox", kind: "inbox" },
	{ id: "archive", name: "Archive", kind: "archive" },
]

const mailData: MessageDetail[] = [
	{
		id: "msg-1",
		subject: "Welcome",
		receivedAt: new Date().toISOString(),
		sentAt: null,
		unread: true,
		confidential: false,
		state: "received",
		hasAttachments: false,
		folderIds: ["inbox"],
		from: { name: "Tuta", address: "hello@tuta.com" },
		to: [{ name: "Automation", address: "bot@example.com" }],
		cc: [],
		bcc: [],
		replyTo: [],
		envelopeSender: null,
		authStatus: "pass",
		phishingStatus: "unknown",
		listUnsubscribe: false,
		replyType: "none",
		bodyHtml: "<p>Welcome</p>",
		bodyText: "Welcome",
		headers: {},
		attachments: [
			{
				id: "att-1",
				filename: "welcome.txt",
				contentType: "text/plain",
				sizeBytes: 7,
				contentId: null,
			},
		],
	},
]

export class DevMailService implements MailService {
	async listFolders(): Promise<Folder[]> {
		return folderData
	}

	async listMessages(_query: ListMessagesQuery): Promise<{ data: MessageSummary[]; pagination: Pagination }> {
		return {
			data: mailData.map((m) => ({ ...m })),
			pagination: { limit: 50, hasMore: false, nextCursor: null },
		}
	}

	async getMessage(id: string): Promise<MessageDetail | null> {
		return mailData.find((m) => m.id === id) ?? null
	}

	async downloadAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent | null> {
		if (messageId !== "msg-1" || attachmentId !== "att-1") return null
		return {
			data: Buffer.from("welcome"),
			filename: "welcome.txt",
			contentType: "text/plain",
		}
	}

	async updateMessage(id: string, unread: boolean): Promise<UpdateMessageResponse | null> {
		const found = mailData.find((m) => m.id === id)
		if (!found) return null
		found.unread = unread
		return { messageId: id, unread }
	}

	async deleteMessage(id: string): Promise<DeleteMessageResponse | null> {
		const found = mailData.find((m) => m.id === id)
		if (!found) return null
		found.folderIds = ["archive"]
		return { messageId: id, trashed: true }
	}

	async sendMessage(_request: SendMessageRequest): Promise<SendMessageResponse> {
		return { messageId: `msg-${Date.now()}`, status: "sent" }
	}

	async moveMessage(id: string, request: MoveMessageRequest): Promise<MoveMessageResponse | null> {
		const found = mailData.find((m) => m.id === id)
		if (!found) return null
		found.folderIds = [request.targetFolderId]
		return { messageId: id, moved: true, targetFolderId: request.targetFolderId }
	}
}
