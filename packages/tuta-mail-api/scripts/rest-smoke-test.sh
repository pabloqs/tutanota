#!/usr/bin/env bash
#
# Smoke-test all tuta-mail-api REST routes against a running server.
#
# Usage:
#   export TUTA_MAIL_API_TOKEN='your-bearer-token'
#   ./scripts/rest-smoke-test.sh
#
# Optional:
#   export TUTA_MAIL_API_BASE='http://127.0.0.1:3100'
#   export REST_SMOKE_DESTRUCTIVE=1   # also run DELETE (trash) + POST move on FIRST listed message
#   export REST_SMOKE_SEND_TO='paqs140482@gmail.com'  # recipient for send smoke step
#
set -euo pipefail

BASE="${TUTA_MAIL_API_BASE:-http://127.0.0.1:3100}"
TOKEN="${TUTA_MAIL_API_TOKEN:-}"
SEND_TO="${REST_SMOKE_SEND_TO:-paqs140482@gmail.com}"
EXTERNAL_PASSWORD="${REST_SMOKE_EXTERNAL_PASSWORD:-}"

if [[ -z "$TOKEN" ]]; then
	echo "Set TUTA_MAIL_API_TOKEN to a valid bearer token (e.g. bootstrap token)." >&2
	exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
	echo "curl is required." >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "jq is required." >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "node is required (for URL-encoding message ids)." >&2
	exit 1
fi

encode_msg_id() {
	node -e "console.log(encodeURIComponent(process.argv[1]))" "$1"
}

hdr_auth=(-H "Authorization: Bearer ${TOKEN}")

step() {
	echo ""
	echo "==> $*"
}

# Usage: expect_http "label" EXPECTED_CODE curl-args...
# Example: expect_http "detail" 200 -sS "${hdr_auth[@]}" "$BASE/v1/messages/$id"
expect_http() {
	local label="$1"
	local expected="$2"
	shift 2
	local tmp code
	tmp="$(mktemp)"
	code="$(curl -sS -o "$tmp" -w '%{http_code}' "$@")"
	echo "    HTTP $code"
	if [[ "$code" != "$expected" ]]; then
		echo "    FAIL: expected HTTP $expected for $label" >&2
		cat "$tmp" >&2 || true
		rm -f "$tmp"
		exit 1
	fi
	jq . "$tmp" 2>/dev/null || cat "$tmp"
	rm -f "$tmp"
}

step "GET /v1/health (no auth)"
curl -sS "${BASE}/v1/health" | jq '{status, mail: {kind: .mail.kind, mailOperationsReady: .mail.mailOperationsReady}}'

step "GET /v1/folders"
FOLDERS_JSON="$(curl -sS "${hdr_auth[@]}" "${BASE}/v1/folders")"
echo "$FOLDERS_JSON" | jq .
INBOX_ID="$(echo "$FOLDERS_JSON" | jq -r '.data[] | select(.kind=="inbox") | .id' | head -1)"
if [[ -z "$INBOX_ID" || "$INBOX_ID" == "null" ]]; then
	INBOX_ID="$(echo "$FOLDERS_JSON" | jq -r '.data[0].id')"
fi
echo "    Using folder id (inbox or first): $INBOX_ID"

step "GET /v1/messages?folder=…&limit=3"
LIST_JSON="$(curl -sS "${hdr_auth[@]}" "${BASE}/v1/messages?folder=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$INBOX_ID")&limit=3")"
echo "$LIST_JSON" | jq .
MSG_ID="$(echo "$LIST_JSON" | jq -r '.data[0].id // empty')"
if [[ -z "$MSG_ID" || "$MSG_ID" == "null" ]]; then
	echo "    No messages in folder; skipping message-specific steps."
	MSG_ID=""
else
	echo "    First message id: $MSG_ID"
	ENC_ID="$(encode_msg_id "$MSG_ID")"

	step "GET /v1/messages/:id (detail)"
	expect_http "message detail" 200 -sS "${hdr_auth[@]}" "${BASE}/v1/messages/${ENC_ID}"

	step "GET /v1/messages/:id/attachments/:attachmentId (first attachment, if any)"
	ATT_ID="$(curl -sS "${hdr_auth[@]}" "${BASE}/v1/messages/${ENC_ID}" | jq -r '.data.attachments[0].id // empty')"
	if [[ -n "$ATT_ID" && "$ATT_ID" != "null" ]]; then
		ENC_ATT="$(encode_msg_id "$ATT_ID")"
		TMP_BIN="$(mktemp)"
		code="$(curl -sS -o "$TMP_BIN" -w '%{http_code}' "${hdr_auth[@]}" "${BASE}/v1/messages/${ENC_ID}/attachments/${ENC_ATT}")"
		echo "    HTTP $code, bytes: $(wc -c <"$TMP_BIN")"
		rm -f "$TMP_BIN"
		if [[ "$code" != "200" ]]; then
			echo "    FAIL: expected 200 for attachment download" >&2
			exit 1
		fi
	else
		echo "    (no attachments on first message; skip download)"
	fi

	step "PATCH /v1/messages/:id (toggle unread twice)"
	CUR_UNREAD="$(curl -sS "${hdr_auth[@]}" "${BASE}/v1/messages/${ENC_ID}" | jq -r '.data.unread')"
	if [[ "$CUR_UNREAD" == "true" ]]; then
		NEXT=false
	else
		NEXT=true
	fi
	expect_http "patch unread" 200 -sS "${hdr_auth[@]}" -X PATCH "${BASE}/v1/messages/${ENC_ID}" \
		-H "Content-Type: application/json" -d "{\"unread\":$NEXT}"
	expect_http "patch restore unread" 200 -sS "${hdr_auth[@]}" -X PATCH "${BASE}/v1/messages/${ENC_ID}" \
		-H "Content-Type: application/json" -d "{\"unread\":$CUR_UNREAD}"

	NEXT_CURSOR="$(echo "$LIST_JSON" | jq -r '.pagination.nextCursor // empty')"
	if [[ -n "$NEXT_CURSOR" && "$NEXT_CURSOR" != "null" ]]; then
		step "GET /v1/messages (second page with cursor)"
		ENC_CURSOR="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$NEXT_CURSOR")"
		P2="$(curl -sS "${hdr_auth[@]}" "${BASE}/v1/messages?folder=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$INBOX_ID")&limit=2&cursor=${ENC_CURSOR}")"
		echo "$P2" | jq '{pagination, firstId: .data[0].id}'
	fi
fi

step "GET /v1/messages (invalid limit → 400)"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${hdr_auth[@]}" "${BASE}/v1/messages?limit=0")"
echo "    HTTP $code (expect 400)"
if [[ "$code" != "400" ]]; then
	echo "    FAIL: expected 400 for limit=0" >&2
	exit 1
fi

step "GET /v1/messages/:id (unknown id → 404)"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${hdr_auth[@]}" "${BASE}/v1/messages/$(encode_msg_id 'zzzzzzzzzzzz/zzzzzzzzzzzz')")"
echo "    HTTP $code (expect 404)"
if [[ "$code" != "404" ]]; then
	echo "    FAIL: expected 404 for fake message id" >&2
	exit 1
fi

step "PATCH /v1/messages/:id (invalid body → 400)"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${hdr_auth[@]}" -X PATCH "${BASE}/v1/messages/$(encode_msg_id 'a/b')" \
	-H "Content-Type: application/json" -d '{"unread":"nope"}')"
echo "    HTTP $code (expect 400)"
if [[ "$code" != "400" ]]; then
	echo "    FAIL: expected 400 for invalid body" >&2
	exit 1
fi

step "POST /v1/messages/send (expect 200)"
if [[ -n "$EXTERNAL_PASSWORD" ]]; then
	SEND_BODY="$(jq -cn --arg to "$SEND_TO" --arg p "$EXTERNAL_PASSWORD" '{"to":[{"name":null,"address":$to}],"subject":"smoke","bodyText":"hi from rest smoke","externalPassword":$p}')"
else
	SEND_BODY="$(jq -cn --arg to "$SEND_TO" '{"to":[{"name":null,"address":$to}],"subject":"smoke","bodyText":"hi from rest smoke"}')"
fi
SEND_TMP="$(mktemp)"
code="$(curl -sS -o "$SEND_TMP" -w '%{http_code}' "${hdr_auth[@]}" -X POST "${BASE}/v1/messages/send" \
	-H "Content-Type: application/json" -d "$SEND_BODY")"
echo "    HTTP $code"
jq . "$SEND_TMP" 2>/dev/null || cat "$SEND_TMP"
rm -f "$SEND_TMP"
if [[ "$code" != "200" ]]; then
	echo "    FAIL: expected 200 for sendMail (recipient: $SEND_TO)" >&2
	exit 1
fi

if [[ -n "$MSG_ID" && "${REST_SMOKE_DESTRUCTIVE:-}" == "1" ]]; then
	ENC_ID="$(encode_msg_id "$MSG_ID")"
	step "POST /v1/messages/:id/move (REST_SMOKE_DESTRUCTIVE=1 → trash first listed message)"
	expect_http "move to trash" 200 -sS "${hdr_auth[@]}" -X POST "${BASE}/v1/messages/${ENC_ID}/move" \
		-H "Content-Type: application/json" -d '{"targetFolderId":"trash"}'

	step "DELETE /v1/messages/:id (already trashed; idempotent trash)"
	expect_http "delete" 200 -sS "${hdr_auth[@]}" -X DELETE "${BASE}/v1/messages/${ENC_ID}"
else
	step "POST move + DELETE (skipped; set REST_SMOKE_DESTRUCTIVE=1 to trash first inbox message)"
fi

step "GET /v1/folders without Authorization (expect 401)"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/v1/folders")"
echo "    HTTP $code"
if [[ "$code" != "401" ]]; then
	echo "    FAIL: expected 401 without bearer" >&2
	exit 1
fi

echo ""
echo "Smoke test finished OK."
