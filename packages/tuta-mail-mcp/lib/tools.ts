import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { AccountResolver, McpUserError } from "./accounts.js"
import { resolveFolderRef } from "./folderResolve.js"
import { RestClient, RestError } from "./restClient.js"
import type { HealthAccount, SendMessageRequest } from "./restTypes.js"

export interface ToolDeps {
	client: RestClient
	resolver: AccountResolver
}

const emailAddressSchema = z.object({
	address: z.string().describe("Email address"),
	name: z.string().nullable().optional().describe("Display name"),
})

const accountArg = {
	account: z
		.string()
		.optional()
		.describe("Account id to act on. Optional when only one account is configured; required otherwise. Use list_accounts to discover ids."),
}

function jsonResult(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true }
}

/** Run a tool body, mapping user/REST/unknown errors to MCP tool errors instead of throwing. */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await run()
	} catch (e) {
		if (e instanceof McpUserError) return errorResult(e.message)
		if (e instanceof RestError) return errorResult(`${e.code} (HTTP ${e.status}): ${e.message}`)
		return errorResult(e instanceof Error ? e.message : "Unknown error")
	}
}

/** Register every mail tool on the server. All account-scoped tools accept an `account` argument. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
	const { client, resolver } = deps

	server.registerTool(
		"list_accounts",
		{
			title: "List accounts",
			description: "List the Tuta accounts this server manages, with each account's backend readiness. Tokens are never returned.",
			inputSchema: {},
		},
		async () =>
			guard(async () => {
				let health: HealthAccount[] = []
				try {
					const res = await client.health()
					health = res.accounts ?? []
				} catch {
					// Health is best-effort enrichment; still return the configured accounts.
				}
				const healthById = new Map(health.map((h) => [h.id, h]))
				const accounts = resolver.list().map((a) => {
					const h = healthById.get(a.id)
					return {
						id: a.id,
						label: a.label,
						kind: h?.kind ?? "unknown",
						mailOperationsReady: h?.mailOperationsReady ?? null,
					}
				})
				return jsonResult({ accounts })
			}),
	)

	server.registerTool(
		"list_folders",
		{
			title: "List folders",
			description: "List mail folders (inbox, sent, trash, archive, spam, drafts, custom) for an account.",
			inputSchema: { ...accountArg },
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				return jsonResult({ account: account.id, folders: await client.listFolders(account.token) })
			}),
	)

	server.registerTool(
		"list_messages",
		{
			title: "List messages",
			description: "List message summaries in a folder with pagination and filters (unread, sender, date range, attachments).",
			inputSchema: {
				...accountArg,
				folder: z.string().optional().describe("Folder id or kind (e.g. inbox, sent). Defaults to inbox."),
				cursor: z.string().optional().describe("Pagination cursor from a previous response's nextCursor."),
				limit: z.number().int().positive().max(200).optional().describe("Max messages to return (default server-side)."),
				since: z.string().optional().describe("ISO date/time lower bound on received date."),
				before: z.string().optional().describe("ISO date/time upper bound on received date."),
				unread: z.boolean().optional().describe("Filter by unread state."),
				from: z.string().optional().describe("Case-insensitive substring match on sender address."),
				hasAttachments: z.boolean().optional().describe("Filter to messages with attachments."),
			},
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				const folder = await resolveFolderRef(client, account.token, args.folder, { defaultInbox: true })
				const result = await client.listMessages(account.token, {
					folder,
					cursor: args.cursor,
					limit: args.limit,
					since: args.since,
					before: args.before,
					unread: args.unread,
					from: args.from,
					hasAttachments: args.hasAttachments,
				})
				return jsonResult({ account: account.id, ...result })
			}),
	)

	server.registerTool(
		"get_message",
		{
			title: "Get message",
			description: "Fetch a full message: headers, recipients, body (text + html), and attachment metadata.",
			inputSchema: { ...accountArg, id: z.string().describe("Message id (listId/elementId).") },
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				return jsonResult({ account: account.id, message: await client.getMessage(account.token, args.id) })
			}),
	)

	server.registerTool(
		"download_attachment",
		{
			title: "Download attachment",
			description: "Download an attachment's bytes (returned base64-encoded) along with its filename and content type.",
			inputSchema: {
				...accountArg,
				messageId: z.string().describe("Message id owning the attachment."),
				attachmentId: z.string().describe("Attachment id from get_message."),
			},
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				const att = await client.downloadAttachment(account.token, args.messageId, args.attachmentId)
				return jsonResult({
					account: account.id,
					filename: att.filename,
					contentType: att.contentType,
					sizeBytes: att.data.byteLength,
					contentBase64: att.data.toString("base64"),
				})
			}),
	)

	server.registerTool(
		"mark_message",
		{
			title: "Mark message read/unread",
			description: "Set a message's unread flag (IMAP \\Seen equivalent).",
			inputSchema: { ...accountArg, id: z.string().describe("Message id."), unread: z.boolean().describe("true = unread, false = read.") },
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				return jsonResult({ account: account.id, result: await client.updateMessage(account.token, args.id, args.unread) })
			}),
	)

	server.registerTool(
		"delete_message",
		{
			title: "Delete (trash) message",
			description: "Move a message to trash (IMAP \\Deleted equivalent). Not a permanent delete.",
			inputSchema: { ...accountArg, id: z.string().describe("Message id.") },
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				return jsonResult({ account: account.id, result: await client.deleteMessage(account.token, args.id) })
			}),
	)

	server.registerTool(
		"send_message",
		{
			title: "Send message",
			description:
				"Send an email from the account. For external (non-Tuta) recipients, provide externalPassword to send password-protected mail. Pass idempotencyKey to make retries safe.",
			inputSchema: {
				...accountArg,
				to: z.array(emailAddressSchema).min(1).describe("Recipients."),
				subject: z.string().describe("Subject line."),
				cc: z.array(emailAddressSchema).optional(),
				bcc: z.array(emailAddressSchema).optional(),
				bodyText: z.string().optional().describe("Plain-text body."),
				bodyHtml: z.string().optional().describe("HTML body."),
				replyTo: z.array(emailAddressSchema).optional(),
				from: emailAddressSchema.optional().describe("Override sender address (must belong to the account)."),
				externalPassword: z.string().optional().describe("Password for secure external send to non-Tuta recipients."),
				attachments: z
					.array(
						z.object({
							filename: z.string(),
							contentType: z.string(),
							contentBase64: z.string(),
						}),
					)
					.optional(),
				idempotencyKey: z.string().optional().describe("Client-supplied key; identical retries return the first result."),
			},
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				const request: SendMessageRequest = {
					to: args.to,
					subject: args.subject,
					cc: args.cc,
					bcc: args.bcc,
					bodyText: args.bodyText,
					bodyHtml: args.bodyHtml,
					replyTo: args.replyTo,
					from: args.from,
					externalPassword: args.externalPassword,
					attachments: args.attachments,
				}
				return jsonResult({ account: account.id, result: await client.sendMessage(account.token, request, args.idempotencyKey) })
			}),
	)

	server.registerTool(
		"move_message",
		{
			title: "Move message",
			description: "Move a message to another folder. Bridge support is currently trash-only; pass idempotencyKey to make retries safe.",
			inputSchema: {
				...accountArg,
				id: z.string().describe("Message id."),
				targetFolderId: z.string().describe("Destination folder id or kind."),
				idempotencyKey: z.string().optional(),
			},
		},
		async (args) =>
			guard(async () => {
				const account = resolver.resolve(args.account)
				const targetFolderId = await resolveFolderRef(client, account.token, args.targetFolderId)
				if (!targetFolderId) {
					throw new McpUserError("targetFolderId is required")
				}
				return jsonResult({
					account: account.id,
					result: await client.moveMessage(account.token, args.id, targetFolderId, args.idempotencyKey),
				})
			}),
	)
}
