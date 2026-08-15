import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface CapturedRequest {
	method: string
	url: string
	auth: string | null
	idempotencyKey: string | null
	body: unknown
}

export interface FakeResponse {
	status?: number
	json?: unknown
	buffer?: Buffer
	headers?: Record<string, string>
}

export interface FakeRest {
	baseUrl: string
	requests: CapturedRequest[]
	close: () => Promise<void>
}

/**
 * Minimal HTTP server that hands each request to `handler` and returns the
 * response spec it produces. Used to drive the REST client and the MCP server
 * in tests without a real `tuta-mail-api` process.
 */
export async function startFakeRest(handler: (req: CapturedRequest) => FakeResponse): Promise<FakeRest> {
	const requests: CapturedRequest[] = []
	const server: Server = createServer((req, res) => {
		let raw = ""
		req.on("data", (c) => {
			raw += c
		})
		req.on("end", () => {
			const captured: CapturedRequest = {
				method: req.method ?? "GET",
				url: req.url ?? "",
				auth: req.headers.authorization ?? null,
				idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
				body: raw ? JSON.parse(raw) : undefined,
			}
			requests.push(captured)
			const out = handler(captured)
			const status = out.status ?? 200
			if (out.buffer) {
				res.writeHead(status, { "Content-Type": "application/octet-stream", ...out.headers })
				res.end(out.buffer)
				return
			}
			res.writeHead(status, { "Content-Type": "application/json", ...out.headers })
			res.end(JSON.stringify(out.json ?? {}))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const { port } = server.address() as AddressInfo
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}
