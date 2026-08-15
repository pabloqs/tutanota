import type { AccountConfig, ApiConfig } from "../config/env.js"
import type { MailService } from "./mailService.js"
import { DevMailService } from "./devMailService.js"
import { HttpBridgeTutaClient } from "./httpBridgeTutaClient.js"
import { SdkUnavailableClient } from "./sdkUnavailableClient.js"
import { TutaMailService } from "./tutaMailService.js"

/** Maps each account id to the {@link MailService} that serves it. */
export type MailServiceRegistry = Map<string, MailService>

/** Build the mail service for a single account (its own bridge, or the dev stub). */
export function createMailServiceForAccount(account: AccountConfig): MailService {
	if (account.serviceMode === "tuta") {
		if (account.bridgeBaseUrl) {
			return new TutaMailService(
				new HttpBridgeTutaClient({
					tutaBridgeBaseUrl: account.bridgeBaseUrl,
					tutaBridgeAuthToken: account.bridgeAuthToken,
					tutaBridgeTimeoutMs: account.bridgeTimeoutMs,
				}),
			)
		}
		return new TutaMailService(new SdkUnavailableClient())
	}
	return new DevMailService()
}

/**
 * Build one {@link MailService} per configured account, keyed by account id.
 * Falls back to the legacy single-account fields when `config.accounts` is absent.
 */
export function createMailServiceRegistry(config: ApiConfig): MailServiceRegistry {
	const registry: MailServiceRegistry = new Map()
	const accounts: AccountConfig[] = config.accounts ?? [
		{
			id: "default",
			label: null,
			serviceMode: config.serviceMode,
			bridgeBaseUrl: config.tutaBridgeBaseUrl,
			bridgeAuthToken: config.tutaBridgeAuthToken,
			bridgeTimeoutMs: config.tutaBridgeTimeoutMs,
			tutaApiUrl: config.tutaApiUrl,
			bootstrapToken: null,
		},
	]
	for (const account of accounts) {
		registry.set(account.id, createMailServiceForAccount(account))
	}
	return registry
}

/**
 * Legacy single-account factory. Prefer {@link createMailServiceRegistry} for
 * multi-account deployments; retained for callers/tests that build one service.
 */
export function createMailService(config: ApiConfig): MailService {
	if (config.serviceMode === "tuta") {
		if (config.tutaBridgeBaseUrl) {
			return new TutaMailService(
				new HttpBridgeTutaClient({
					tutaBridgeBaseUrl: config.tutaBridgeBaseUrl,
					tutaBridgeAuthToken: config.tutaBridgeAuthToken,
					tutaBridgeTimeoutMs: config.tutaBridgeTimeoutMs,
				}),
			)
		}
		return new TutaMailService(new SdkUnavailableClient())
	}
	return new DevMailService()
}
