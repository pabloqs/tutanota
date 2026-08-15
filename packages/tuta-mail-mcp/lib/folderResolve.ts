import { McpUserError } from "./accounts.js"
import type { RestClient } from "./restClient.js"
import type { Folder } from "./restTypes.js"

/** Kind aliases accepted by list_messages / move_message in addition to raw Tuta folder ids. */
const FOLDER_KINDS = new Set(["inbox", "sent", "trash", "archive", "spam", "draft", "drafts", "custom", "all"])

export function looksLikeFolderKind(folder: string): boolean {
	return FOLDER_KINDS.has(folder.trim().toLowerCase())
}

function normalizeKind(folder: string): string {
	const want = folder.trim().toLowerCase()
	return want === "drafts" ? "draft" : want
}

/** Map a kind/name alias to a folder id from `/v1/folders`. */
export function resolveFolderKind(folders: Folder[], folder: string): string {
	const want = normalizeKind(folder)
	const byKind = folders.find((f) => f.kind.toLowerCase() === want)
	if (byKind?.id) return byKind.id
	const byName = folders.find((f) => f.name.toLowerCase() === folder.trim().toLowerCase() || f.name.toLowerCase() === want)
	if (byName?.id) return byName.id
	throw new McpUserError(`Unknown folder kind/name '${folder}'. Call list_folders to see ids.`)
}

/**
 * Resolve a tool `folder` argument to a Tuta folder id.
 * Kind aliases (`inbox`, `sent`, …) are looked up via `/v1/folders`.
 * When `folder` is omitted and `defaultInbox` is true (list_messages), uses inbox.
 */
export async function resolveFolderRef(
	client: RestClient,
	token: string,
	folder: string | undefined,
	opts: { defaultInbox?: boolean } = {},
): Promise<string | undefined> {
	const raw = folder?.trim()
	const effective = raw || (opts.defaultInbox ? "inbox" : undefined)
	if (!effective) return undefined
	if (!looksLikeFolderKind(effective)) return effective
	const folders = await client.listFolders(token)
	return resolveFolderKind(folders, effective)
}
