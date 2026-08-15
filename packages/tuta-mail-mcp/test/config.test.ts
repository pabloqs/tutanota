import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"

test("loadConfig: single-account fallback from MAIL_API_TOKEN", () => {
	const cfg = loadConfig({ MAIL_API_TOKEN: "tok" })
	assert.equal(cfg.baseUrl, "http://127.0.0.1:3100")
	assert.equal(cfg.timeoutMs, 60000)
	assert.equal(cfg.accounts.length, 1)
	assert.deepEqual(cfg.accounts[0], { id: "default", label: null, token: "tok" })
})

test("loadConfig: single-account fallback honors MAIL_API_ACCOUNT_ID", () => {
	const cfg = loadConfig({ MAIL_API_TOKEN: "tok", MAIL_API_ACCOUNT_ID: "work" })
	assert.equal(cfg.accounts[0].id, "work")
})

test("loadConfig: base URL trailing slash trimmed; custom timeout parsed", () => {
	const cfg = loadConfig({ MAIL_API_TOKEN: "tok", MAIL_API_BASE_URL: "http://host:9/", MAIL_API_TIMEOUT_MS: "1234" })
	assert.equal(cfg.baseUrl, "http://host:9")
	assert.equal(cfg.timeoutMs, 1234)
})

test("loadConfig: invalid timeout falls back to default", () => {
	const cfg = loadConfig({ MAIL_API_TOKEN: "tok", MAIL_API_TIMEOUT_MS: "0" })
	assert.equal(cfg.timeoutMs, 60000)
})

test("loadConfig: inline accounts array", () => {
	const cfg = loadConfig({
		MAIL_API_MCP_ACCOUNTS: JSON.stringify([
			{ id: "work", label: "Work", token: "tw" },
			{ id: "personal", token: "tp" },
		]),
	})
	assert.deepEqual(
		cfg.accounts.map((a) => a.id),
		["work", "personal"],
	)
	assert.equal(cfg.accounts[0].label, "Work")
	assert.equal(cfg.accounts[1].label, null)
})

test("loadConfig: { accounts: [...] } wrapper from file", () => {
	const dir = mkdtempSync(join(tmpdir(), "mcp-accounts-"))
	const file = join(dir, "accounts.json")
	writeFileSync(file, JSON.stringify({ accounts: [{ id: "a", token: "ta" }] }))
	const cfg = loadConfig({ MAIL_API_MCP_ACCOUNTS_FILE: file })
	assert.equal(cfg.accounts.length, 1)
	assert.equal(cfg.accounts[0].id, "a")
})

test("loadConfig: no accounts configured throws", () => {
	assert.throws(() => loadConfig({}), /no accounts configured/)
})

test("loadConfig: account without token throws", () => {
	assert.throws(() => loadConfig({ MAIL_API_MCP_ACCOUNTS: JSON.stringify([{ id: "x" }]) }), /requires a non-empty 'token'/)
})

test("loadConfig: invalid account id slug throws", () => {
	assert.throws(() => loadConfig({ MAIL_API_MCP_ACCOUNTS: JSON.stringify([{ id: "Bad Id", token: "t" }]) }), /invalid account id/)
})

test("loadConfig: duplicate account ids throw", () => {
	assert.throws(
		() =>
			loadConfig({
				MAIL_API_MCP_ACCOUNTS: JSON.stringify([
					{ id: "dup", token: "a" },
					{ id: "dup", token: "b" },
				]),
			}),
		/duplicate account id 'dup'/,
	)
})

test("loadConfig: malformed JSON throws", () => {
	assert.throws(() => loadConfig({ MAIL_API_MCP_ACCOUNTS: "{not json" }), /failed to parse/)
})

test("loadConfig: empty accounts array throws", () => {
	assert.throws(() => loadConfig({ MAIL_API_MCP_ACCOUNTS: "[]" }), /non-empty array/)
})
