import express, { type Request, type Response } from "express"
import bodyParser from "body-parser"
import type { ApiConfig } from "./config/env.js"
import { getMailBackendMetadata } from "./config/mailBackendMetadata.js"
import type { ErrorEnvelope } from "./dto/types.js"
import { authMiddleware, requireScope } from "./middleware/auth.js"
import { rateLimitMiddleware } from "./middleware/rateLimit.js"
import { requestIdMiddleware } from "./middleware/requestId.js"
import type { MailService } from "./services/mailService.js"
import type { ITokenStore } from "./auth/tokenStore.js"
import { parseListMessagesQuery, validateMoveMessageRequest, validateSendMessageRequest, validateUpdateMessageRequest, ValidationError } from "./validation.js"
import { ApiServiceError } from "./errors.js"
import { MemoryIdempotencyStore, type ResponseCache } from "./idempotency/idempotencyStore.js"
import type { MoveMessageResponse, SendMessageResponse } from "./dto/types.js"

function sendError(res: Response, code: ErrorEnvelope["error"]["code"], message: string, requestId?: string, status = 400) {
	res.status(status).json({ error: { code, message, requestId } })
}

export interface AppStoreOptions {
	sendIdempotency?: ResponseCache<SendMessageResponse>
	moveIdempotency?: ResponseCache<MoveMessageResponse>
}

export function createApp(mailService: MailService, tokenStore: ITokenStore, config: ApiConfig, storeOptions?: AppStoreOptions) {
	const app = express()
	const sendIdempotencyStore =
		storeOptions?.sendIdempotency ?? new MemoryIdempotencyStore<SendMessageResponse>(config.idempotencyTtlMs)
	const moveIdempotencyStore =
		storeOptions?.moveIdempotency ?? new MemoryIdempotencyStore<MoveMessageResponse>(config.idempotencyTtlMs)
	app.disable("x-powered-by")
	app.use(bodyParser.json({ limit: "10mb" }))
	app.use(requestIdMiddleware)

	app.get("/v1/health", (_req, res) => {
		res.status(200).json({
			status: "ok",
			mail: getMailBackendMetadata(config),
		})
	})

	app.use(authMiddleware(tokenStore))
	app.use(rateLimitMiddleware(config.rateLimitMax, config.rateLimitWindowMs))

	app.get("/v1/folders", requireScope("mail:read:folders"), async (req, res) => {
		const data = await mailService.listFolders()
		res.status(200).json({ data })
	})

	app.get("/v1/messages", requireScope("mail:read:messages"), async (req, res) => {
		const query = parseListMessagesQuery(req.query as Record<string, unknown>)
		const result = await mailService.listMessages(query)
		res.status(200).json(result)
	})

	app.get("/v1/messages/:id", requireScope("mail:read:messages"), async (req, res) => {
		const message = await mailService.getMessage(req.params.id)
		if (!message) {
			return sendError(res, "validation_error", "Message not found", req.requestId, 404)
		}
		res.status(200).json({ data: message })
	})

	app.get("/v1/messages/:id/attachments/:attachmentId", requireScope("mail:read:messages"), async (req, res) => {
		const attachment = await mailService.downloadAttachment(req.params.id, req.params.attachmentId)
		if (!attachment) {
			return sendError(res, "validation_error", "Attachment not found", req.requestId, 404)
		}
		if (attachment.data.byteLength > config.maxAttachmentBytes) {
			return sendError(res, "validation_error", "Attachment exceeds max allowed size", req.requestId, 413)
		}
		res.setHeader("Content-Type", attachment.contentType || "application/octet-stream")
		res.setHeader("Content-Disposition", `attachment; filename="${attachment.filename}"`)
		res.setHeader("Content-Length", attachment.data.byteLength)
		res.status(200).send(attachment.data)
	})

	app.patch("/v1/messages/:id", requireScope("mail:write"), async (req, res) => {
		const payload = validateUpdateMessageRequest(req.body)
		const result = await mailService.updateMessage(req.params.id, payload.unread)
		if (!result) {
			return sendError(res, "validation_error", "Message not found", req.requestId, 404)
		}
		res.status(200).json({ data: result })
	})

	app.delete("/v1/messages/:id", requireScope("mail:delete"), async (req, res) => {
		const result = await mailService.deleteMessage(req.params.id)
		if (!result) {
			return sendError(res, "validation_error", "Message not found", req.requestId, 404)
		}
		res.status(200).json({ data: result })
	})

	app.post("/v1/messages/send", requireScope("mail:send"), async (req, res) => {
		const payload = validateSendMessageRequest(req.body)
		const idempotencyKey = req.header("idempotency-key")
		if (idempotencyKey) {
			const scopedKey = `${req.tokenRecord?.tokenId ?? "anon"}:send:${idempotencyKey}`
			const existing = sendIdempotencyStore.get(scopedKey)
			if (existing) {
				res.status(200).json({ data: existing })
				return
			}
			const data = await mailService.sendMessage(payload)
			sendIdempotencyStore.set(scopedKey, data)
			res.status(200).json({ data })
			return
		}
		const data = await mailService.sendMessage(payload)
		res.status(200).json({ data })
	})

	app.post("/v1/messages/:id/move", requireScope("mail:move"), async (req, res) => {
		const payload = validateMoveMessageRequest(req.body)
		const idempotencyKey = payload.idempotencyKey ?? req.header("idempotency-key")
		if (idempotencyKey) {
			const scopedKey = `${req.tokenRecord?.tokenId ?? "anon"}:move:${req.params.id}:${idempotencyKey}`
			const existing = moveIdempotencyStore.get(scopedKey)
			if (existing) {
				res.status(200).json({ data: existing })
				return
			}
			const data = await mailService.moveMessage(req.params.id, payload)
			if (!data) {
				sendError(res, "validation_error", "Message or folder not found", req.requestId, 404)
				return
			}
			moveIdempotencyStore.set(scopedKey, data)
			res.status(200).json({ data })
			return
		}
		const data = await mailService.moveMessage(req.params.id, payload)
		if (!data) {
			return sendError(res, "validation_error", "Message or folder not found", req.requestId, 404)
		}
		res.status(200).json({ data })
	})

	app.use((err: unknown, req: Request, res: Response, _next: () => void) => {
		if (err instanceof ValidationError) {
			return sendError(res, "validation_error", err.message, req.requestId, 400)
		}
		if (err instanceof ApiServiceError) {
			return sendError(res, err.code, err.message, req.requestId, err.status)
		}
		if (err instanceof SyntaxError) {
			return sendError(res, "validation_error", "Invalid JSON payload", req.requestId, 400)
		}
		return sendError(res, "internal_error", "Internal server error", req.requestId, 500)
	})

	return app
}
