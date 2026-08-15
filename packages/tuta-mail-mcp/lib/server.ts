import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { McpConfig } from "./config.js"
import { AccountResolver } from "./accounts.js"
import { RestClient } from "./restClient.js"
import { registerTools } from "./tools.js"

export const SERVER_NAME = "tuta-mail-mcp"
export const SERVER_VERSION = "341.260409.1"

/** Build a configured MCP server (transport not yet connected). */
export function createMcpServer(config: McpConfig): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				"Tools for Tuta mailboxes across one or more accounts. Each account-scoped tool takes an 'account' id; call list_accounts first to discover ids when several are configured.",
		},
	)
	const client = new RestClient(config.baseUrl, config.timeoutMs)
	const resolver = new AccountResolver(config.accounts)
	registerTools(server, { client, resolver })
	return server
}
