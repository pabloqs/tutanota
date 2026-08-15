import type {
	DeleteMessageResponse,
	DownloadedAttachment,
	Folder,
	HealthResponse,
	ListMessagesParams,
	MessageDetail,
	MessageSummary,
	MoveMessageResponse,
	Pagination,
	SendMessageRequest,
	SendMessageResponse,
	UpdateMessageResponse,
} from "./restTypes.js"

/** Error raised when the REST API returns a non-2xx response or is unreachable. */
export class RestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
		readonly requestId?: string,
	) {
		super(message)
		this.name = "RestError"
	}
}

interface ErrorEnvelope {
	error?: { code?: string; message?: string; requestId?: string }
}

function parseFilename(contentDisposition: string | null, fallback: string): string {
	if (!contentDisposition) return fallback
	const match = /filename="?([^"]+)"?/.exec(contentDisposition)
	return match?.[1] ?? fallback
}

/**
 * Typed client for the `tuta-mail-api` REST service. Every call is made on behalf
 * of one account: the caller passes that account's bearer `token`, which the REST
 * API maps back to the account (see `X-Tuta-Account`).
 */
export class RestClient {
	constructor(
		private readonly baseUrl: string,
		private readonly timeoutMs: number,
	) {}

	private async request<T>(token: string | null, method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const headers: Record<string, string> = { ...extraHeaders }
			if (token) headers.Authorization = `Bearer ${token}`
			if (body !== undefined) headers["Content-Type"] = "application/json"
			const res = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			})
			if (!res.ok) {
				throw await this.toError(res)
			}
			return (await res.json()) as T
		} catch (e) {
			throw this.normalizeError(e)
		} finally {
			clearTimeout(timeout)
		}
	}

	private async toError(res: Response): Promise<RestError> {
		let code = "http_error"
		let message = `HTTP ${res.status}`
		let requestId: string | undefined
		try {
			const json = (await res.json()) as ErrorEnvelope
			if (json.error) {
				code = json.error.code ?? code
				message = json.error.message ?? message
				requestId = json.error.requestId
			}
		} catch {
			// Non-JSON error body; keep the generic message.
		}
		return new RestError(message, res.status, code, requestId)
	}

	private normalizeError(e: unknown): RestError {
		if (e instanceof RestError) return e
		if (e instanceof Error && e.name === "AbortError") {
			return new RestError("REST request timed out", 504, "timeout")
		}
		return new RestError(e instanceof Error ? e.message : "REST request failed", 502, "network_error")
	}

	/** `GET /v1/health` (no auth) — lists configured accounts and their backend readiness. */
	async health(): Promise<HealthResponse> {
		return await this.request<HealthResponse>(null, "GET", "/v1/health")
	}

	async listFolders(token: string): Promise<Folder[]> {
		const out = await this.request<{ data: Folder[] }>(token, "GET", "/v1/folders")
		return out.data
	}

	async listMessages(token: string, params: ListMessagesParams): Promise<{ data: MessageSummary[]; pagination: Pagination }> {
		const query = new URLSearchParams()
		if (params.folder != null) query.set("folder", params.folder)
		if (params.cursor != null) query.set("cursor", params.cursor)
		if (params.limit != null) query.set("limit", String(params.limit))
		if (params.since != null) query.set("since", params.since)
		if (params.before != null) query.set("before", params.before)
		if (params.unread != null) query.set("unread", String(params.unread))
		if (params.from != null) query.set("from", params.from)
		if (params.hasAttachments != null) query.set("hasAttachments", String(params.hasAttachments))
		const qs = query.toString()
		return await this.request<{ data: MessageSummary[]; pagination: Pagination }>(token, "GET", `/v1/messages${qs ? `?${qs}` : ""}`)
	}

	async getMessage(token: string, id: string): Promise<MessageDetail> {
		const out = await this.request<{ data: MessageDetail }>(token, "GET", `/v1/messages/${encodeURIComponent(id)}`)
		return out.data
	}

	async downloadAttachment(token: string, messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const res = await fetch(`${this.baseUrl}/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				signal: controller.signal,
			})
			if (!res.ok) {
				throw await this.toError(res)
			}
			const data = Buffer.from(await res.arrayBuffer())
			return {
				data,
				filename: parseFilename(res.headers.get("content-disposition"), attachmentId),
				contentType: res.headers.get("content-type") ?? "application/octet-stream",
			}
		} catch (e) {
			throw this.normalizeError(e)
		} finally {
			clearTimeout(timeout)
		}
	}

	async updateMessage(token: string, id: string, unread: boolean): Promise<UpdateMessageResponse> {
		const out = await this.request<{ data: UpdateMessageResponse }>(token, "PATCH", `/v1/messages/${encodeURIComponent(id)}`, { unread })
		return out.data
	}

	async deleteMessage(token: string, id: string): Promise<DeleteMessageResponse> {
		const out = await this.request<{ data: DeleteMessageResponse }>(token, "DELETE", `/v1/messages/${encodeURIComponent(id)}`)
		return out.data
	}

	async sendMessage(token: string, request: SendMessageRequest, idempotencyKey?: string): Promise<SendMessageResponse> {
		const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
		const out = await this.request<{ data: SendMessageResponse }>(token, "POST", "/v1/messages/send", request, headers)
		return out.data
	}

	async moveMessage(token: string, id: string, targetFolderId: string, idempotencyKey?: string): Promise<MoveMessageResponse> {
		const out = await this.request<{ data: MoveMessageResponse }>(token, "POST", `/v1/messages/${encodeURIComponent(id)}/move`, {
			targetFolderId,
			idempotencyKey,
		})
		return out.data
	}
}
