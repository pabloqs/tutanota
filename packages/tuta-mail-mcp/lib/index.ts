#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { createMcpServer } from "./server.js"

async function main(): Promise<void> {
	const config = loadConfig()
	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	// Logs go to stderr so they never corrupt the stdio JSON-RPC stream on stdout.
	console.error(`[tuta-mail-mcp] connected | baseUrl=${config.baseUrl} | accounts=${config.accounts.map((a) => a.id).join(",")}`)
}

main().catch((e) => {
	console.error("[tuta-mail-mcp] fatal:", e instanceof Error ? e.message : e)
	process.exit(1)
})
