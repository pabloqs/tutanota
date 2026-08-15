import type { AccountConfig, ApiConfig } from "./env.js"

/** How this process fulfills mail operations relative to Tuta servers. */
export type MailBackendKind = "dev_stub" | "http_bridge" | "tuta_unconfigured"

export interface MailBackendMetadata {
	serviceMode: ApiConfig["serviceMode"]
	kind: MailBackendKind
	/** Intended Tuta REST host for the account (used by the SDK bridge, not called directly by this Node service today). */
	tutaApiUrl: string
	bridgeBaseUrl: string | null
	/** When false, folder/message endpoints that need Tuta will return `503 upstream_unconfigured` behavior (via stub client). */
	mailOperationsReady: boolean
	/** Human-readable deployment hint for operators. */
	detail: string
}

/**
 * Describes how the running API relates to Tuta infrastructure.
 * This process is always a standalone HTTP server; mail to real Tuta accounts requires a configured backend.
 */
export function getMailBackendMetadata(config: ApiConfig): MailBackendMetadata {
	if (config.serviceMode === "dev") {
		return {
			serviceMode: "dev",
			kind: "dev_stub",
			tutaApiUrl: config.tutaApiUrl,
			bridgeBaseUrl: null,
			mailOperationsReady: true,
			detail: "Demo in-memory mailbox only. No traffic to Tuta servers. Use MAIL_API_SERVICE_MODE=tuta for production mail.",
		}
	}
	if (config.tutaBridgeBaseUrl) {
		return {
			serviceMode: "tuta",
			kind: "http_bridge",
			tutaApiUrl: config.tutaApiUrl,
			bridgeBaseUrl: config.tutaBridgeBaseUrl,
			mailOperationsReady: true,
			detail: "Mail is implemented by the HTTP bridge (POST /invoke). Run the reference sidecar `packages/tuta-mail-api-bridge` (see its README) or another implementation; it must use tuta-sdk and reach Tuta servers (tutaApiUrl or TUTA_MAIL_BRIDGE_API_URL).",
		}
	}
	return {
		serviceMode: "tuta",
		kind: "tuta_unconfigured",
		tutaApiUrl: config.tutaApiUrl,
		bridgeBaseUrl: null,
		mailOperationsReady: false,
		detail: "Set TUTA_BRIDGE_BASE_URL to the SDK sidecar (see HttpBridgeTutaClient), or set MAIL_API_SERVICE_MODE=dev for local testing without Tuta.",
	}
}

/** Per-account health/reporting metadata (one entry per configured account). */
export interface AccountBackendMetadata extends MailBackendMetadata {
	id: string
	label: string | null
}

/**
 * Describe a single account's mail backend. Mirrors {@link getMailBackendMetadata}
 * but reads from an {@link AccountConfig} so `/v1/health` can report every account.
 */
export function getAccountBackendMetadata(account: AccountConfig): AccountBackendMetadata {
	if (account.serviceMode === "dev") {
		return {
			id: account.id,
			label: account.label,
			serviceMode: "dev",
			kind: "dev_stub",
			tutaApiUrl: account.tutaApiUrl,
			bridgeBaseUrl: null,
			mailOperationsReady: true,
			detail: "Demo in-memory mailbox only. No traffic to Tuta servers.",
		}
	}
	if (account.bridgeBaseUrl) {
		return {
			id: account.id,
			label: account.label,
			serviceMode: "tuta",
			kind: "http_bridge",
			tutaApiUrl: account.tutaApiUrl,
			bridgeBaseUrl: account.bridgeBaseUrl,
			mailOperationsReady: true,
			detail: "Mail is implemented by this account's HTTP bridge (POST /invoke).",
		}
	}
	return {
		id: account.id,
		label: account.label,
		serviceMode: "tuta",
		kind: "tuta_unconfigured",
		tutaApiUrl: account.tutaApiUrl,
		bridgeBaseUrl: null,
		mailOperationsReady: false,
		detail: "Set this account's bridgeBaseUrl to its SDK sidecar, or use serviceMode 'dev' for local testing.",
	}
}
