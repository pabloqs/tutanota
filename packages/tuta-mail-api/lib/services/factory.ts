import type { ApiConfig } from "../config/env.js"
import type { MailService } from "./mailService.js"
import { DevMailService } from "./devMailService.js"
import { HttpBridgeTutaClient } from "./httpBridgeTutaClient.js"
import { SdkUnavailableClient } from "./sdkUnavailableClient.js"
import { TutaMailService } from "./tutaMailService.js"

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
