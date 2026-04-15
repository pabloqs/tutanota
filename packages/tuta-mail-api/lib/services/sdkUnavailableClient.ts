import type { SendMessageRequest } from "../dto/types.js"
import { upstreamUnavailable } from "../errors.js"
import type { AttachmentContent } from "./mailService.js"
import type { RawAttachment, RawFolder, RawMail, RawMailDetails, TutaSdkClient } from "./tutaMailService.js"

/**
 * Placeholder adapter until the real Tuta SDK integration is wired.
 * Keeps the service boundaries stable while failing explicitly.
 */
export class SdkUnavailableClient implements TutaSdkClient {
	private fail(): never {
		throw upstreamUnavailable(
			"Tuta mail backend is not configured: set TUTA_BRIDGE_BASE_URL to your SDK sidecar (POST /invoke), or use MAIL_API_SERVICE_MODE=dev for the stub mail service.",
		)
	}

	async loadFolders(): Promise<RawFolder[]> {
		this.fail()
	}
	async loadMails(_opts: { folderId?: string; cursor?: string; count: number }): Promise<RawMail[]> {
		this.fail()
	}
	async loadMail(_id: string): Promise<RawMail | null> {
		this.fail()
	}
	async loadMailDetails(_mail: RawMail): Promise<RawMailDetails | null> {
		this.fail()
	}
	async loadAttachmentMeta(_mail: RawMail): Promise<RawAttachment[]> {
		this.fail()
	}
	async downloadAttachment(_messageId: string, _attachmentId: string): Promise<AttachmentContent | null> {
		this.fail()
	}
	async setUnread(_id: string, _unread: boolean): Promise<boolean> {
		this.fail()
	}
	async trashMail(_id: string): Promise<boolean> {
		this.fail()
	}
	async sendMail(_request: SendMessageRequest): Promise<string> {
		this.fail()
	}
	async moveMail(_id: string, _targetFolderId: string): Promise<boolean> {
		this.fail()
	}
}
