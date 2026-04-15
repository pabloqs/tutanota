import type { SendMessageRequest } from "../dto/types.js"
import { ApiServiceError, externalSecureSendUnavailable, upstreamUnavailable } from "../errors.js"
import type { ApiConfig } from "../config/env.js"
import type { AttachmentContent } from "./mailService.js"
import type { RawAttachment, RawFolder, RawMail, RawMailDetails, TutaSdkClient } from "./tutaMailService.js"

/**
 * Calls a small HTTP sidecar that wraps the Rust Tuta SDK (or equivalent).
 *
 * Protocol: `POST {baseUrl}/invoke` with JSON body `{ "method": string, "params": object }`
 * and JSON response `{ "ok": true, "data": T }` or `{ "ok": false, "message": string, "debug"?: string, "errorCode"?: string }`
 * (`debug` is optional troubleshooting context from the bridge; `errorCode` maps to the mail API `error.code` when present).
 *
 * Methods and params (sidecar must implement):
 * - `loadFolders` → `data`: {@link RawFolder}[]
 * - `loadMails` → params `{ folderId?: string, cursor?: string, count: number }` → `data`: {@link RawMail}[].
 *   `cursor` may be a mail id (`listId/elementId`, same as {@link RawMail.id}) or a legacy MailSetEntry CustomId.
 * - `loadMail` → params `{ id: string }` → `data`: {@link RawMail} | null
 * - `loadMailDetails` → params `{ mailId: string }` → `data`: {@link RawMailDetails} | null
 * - `loadAttachmentMeta` → params `{ mailId: string }` → `data`: {@link RawAttachment}[]
 * - `downloadAttachment` → params `{ messageId: string, attachmentId: string }` → `data`:
 *   `{ contentBase64: string, filename: string, contentType: string }` | null
 * - `setUnread` → params `{ id: string, unread: boolean }` → `data`: boolean
 * - `trashMail` → params `{ id: string }` → `data`: boolean
 * - `sendMail` → params `{ request: SendMessageRequest }` → `data`: `{ messageId: string }`
 * - `moveMail` → params `{ id: string, targetFolderId: string }` → `data`: boolean
 */
export class HttpBridgeTutaClient implements TutaSdkClient {
	private readonly invokeUrl: string

	constructor(private readonly config: Pick<ApiConfig, "tutaBridgeBaseUrl" | "tutaBridgeAuthToken" | "tutaBridgeTimeoutMs">) {
		const base = (config.tutaBridgeBaseUrl ?? "").replace(/\/$/, "")
		this.invokeUrl = `${base}/invoke`
	}

	private async invoke<T>(method: string, params: unknown): Promise<T> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.tutaBridgeTimeoutMs)
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" }
			if (this.config.tutaBridgeAuthToken) {
				headers.Authorization = `Bearer ${this.config.tutaBridgeAuthToken}`
			}
			const res = await fetch(this.invokeUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({ method, params }),
				signal: controller.signal,
			})
			if (!res.ok) {
				throw upstreamUnavailable(`Tuta bridge HTTP ${res.status}`)
			}
			const json = (await res.json()) as {
				ok: boolean
				data?: T
				message?: string
				debug?: string
				errorCode?: string
			}
			if (!json.ok) {
				const base = json.message ?? "Tuta bridge returned error"
				const detail = json.debug ? `${base} | debug: ${json.debug}` : base
				if (json.errorCode === "external_secure_send_unavailable") {
					throw externalSecureSendUnavailable(base)
				}
				throw upstreamUnavailable(detail)
			}
			return json.data as T
		} catch (e) {
			if (e instanceof ApiServiceError) {
				throw e
			}
			if (e instanceof Error && e.name === "AbortError") {
				throw upstreamUnavailable("Tuta bridge request timed out")
			}
			throw upstreamUnavailable(e instanceof Error ? e.message : "Tuta bridge request failed")
		} finally {
			clearTimeout(timeout)
		}
	}

	async loadFolders(): Promise<RawFolder[]> {
		return await this.invoke<RawFolder[]>("loadFolders", {})
	}

	async loadMails(opts: { folderId?: string; cursor?: string; count: number }): Promise<RawMail[]> {
		return await this.invoke<RawMail[]>("loadMails", opts)
	}

	async loadMail(id: string): Promise<RawMail | null> {
		return await this.invoke<RawMail | null>("loadMail", { id })
	}

	async loadMailDetails(mail: RawMail): Promise<RawMailDetails | null> {
		return await this.invoke<RawMailDetails | null>("loadMailDetails", { mailId: mail.id })
	}

	async loadAttachmentMeta(mail: RawMail): Promise<RawAttachment[]> {
		return await this.invoke<RawAttachment[]>("loadAttachmentMeta", { mailId: mail.id })
	}

	async downloadAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent | null> {
		const data = await this.invoke<{
			contentBase64: string
			filename: string
			contentType: string
		} | null>("downloadAttachment", { messageId, attachmentId })
		if (!data) return null
		return {
			data: Buffer.from(data.contentBase64, "base64"),
			filename: data.filename,
			contentType: data.contentType,
		}
	}

	async setUnread(id: string, unread: boolean): Promise<boolean> {
		return await this.invoke<boolean>("setUnread", { id, unread })
	}

	async trashMail(id: string): Promise<boolean> {
		return await this.invoke<boolean>("trashMail", { id })
	}

	async sendMail(request: SendMessageRequest): Promise<string> {
		const out = await this.invoke<{ messageId: string }>("sendMail", { request })
		return out.messageId
	}

	async moveMail(id: string, targetFolderId: string): Promise<boolean> {
		return await this.invoke<boolean>("moveMail", { id, targetFolderId })
	}
}
