import type { McpAccount } from "./config.js"

/** User-facing error (bad account, missing selection) — surfaced as an MCP tool error, not a crash. */
export class McpUserError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "McpUserError"
	}
}

/** Resolves the `account` tool argument to a configured account (and its token). */
export class AccountResolver {
	private readonly byId = new Map<string, McpAccount>()

	constructor(private readonly accounts: McpAccount[]) {
		for (const account of accounts) {
			this.byId.set(account.id, account)
		}
	}

	ids(): string[] {
		return [...this.byId.keys()]
	}

	list(): McpAccount[] {
		return this.accounts
	}

	/**
	 * Resolve the account to act on. When omitted and exactly one account is
	 * configured, that account is used; otherwise a selection is required.
	 */
	resolve(account?: string): McpAccount {
		if (!account) {
			if (this.accounts.length === 1) return this.accounts[0]
			throw new McpUserError(`Multiple accounts configured (${this.ids().join(", ")}); pass 'account' to choose one.`)
		}
		const found = this.byId.get(account)
		if (!found) {
			throw new McpUserError(`Unknown account '${account}'. Configured accounts: ${this.ids().join(", ")}.`)
		}
		return found
	}
}
