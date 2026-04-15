//! HTTP sidecar for `packages/tuta-mail-api` when `MAIL_API_SERVICE_MODE=tuta`.
//! Exposes `POST /invoke` matching `HttpBridgeTutaClient` in the Node service.
//!
//! Environment:
//! - `TUTA_MAIL_BRIDGE_API_URL` — Tuta REST base URL (default: `https://app.tuta.com`)
//! - `TUTA_MAIL_BRIDGE_MAIL` — login mail address
//! - `TUTA_MAIL_BRIDGE_PASSWORD` — account password (same process as desktop login)
//! - `TUTA_MAIL_BRIDGE_DATA_DIR` — persistent directory for SDK file cache (created if missing)
//! - `TUTA_MAIL_BRIDGE_LISTEN` — bind address (default `127.0.0.1:4711`)
//! - `TUTA_MAIL_BRIDGE_TOKEN` — optional; if set, require `Authorization: Bearer <token>` on `/invoke`

use std::convert::TryFrom;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header::AUTHORIZATION, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use log::info;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tutasdk::bindings::native_file_client::NativeFileClient;
use tutasdk::entities::generated::tutanota::{
	EncryptedMailAddress, Mail, MailAddress, MailDetails, MailSet, MailSetEntry, TutanotaFile,
};
use tutasdk::folder_system::{FolderSystem, MailSetKind};
use tutasdk::net::native_rest_client::NativeRestClient;
use tutasdk::crypto_entity_client::CryptoEntityClient;
use tutasdk::entities::DateTime;
use tutasdk::{
	ApiCallError, CustomId, GeneratedId, IdTupleGenerated, ListLoadDirection, LoggedInSdk,
	SendMailAddressInput, SendMailInput, Sdk,
};

const ERROR_CODE_EXTERNAL_SECURE_SEND_UNAVAILABLE: &str = "external_secure_send_unavailable";

/// Error returned from [`dispatch`]; optional `debug` is included in JSON for troubleshooting.
#[derive(Debug)]
struct BridgeFailure {
	message: String,
	debug: Option<String>,
	/// Optional machine-readable code for HTTP clients (mirrors mail API `error.code`).
	error_code: Option<String>,
}

impl From<String> for BridgeFailure {
	fn from(message: String) -> Self {
		BridgeFailure {
			message,
			debug: None,
			error_code: None,
		}
	}
}

impl From<&'static str> for BridgeFailure {
	fn from(message: &'static str) -> Self {
		BridgeFailure {
			message: message.to_string(),
			debug: None,
			error_code: None,
		}
	}
}

/// Snapshot fields that matter for attachment session keys / blob download (no secrets).
fn attachment_download_debug(mail: &Mail, file: &TutanotaFile) -> String {
	let bucket_keys = mail
		.bucketKey
		.as_ref()
		.map(|bk| bk.bucketEncSessionKeys.len())
		.unwrap_or(0);
	format!(
		"mail._id={:?} mail.bucketKey.some={} mail.bucketEncSessionKeys.len={} mail.attachments.len={} \
		 file._id={:?} file.blobs.len={} file._ownerEncSessionKey.bytes={} file._ownerKeyVersion={:?} file._ownerGroup.some={} confidential={}",
		mail._id.as_ref().map(|id| id.to_string()),
		mail.bucketKey.is_some(),
		bucket_keys,
		mail.attachments.len(),
		file._id.as_ref().map(|id| id.to_string()),
		file.blobs.len(),
		file._ownerEncSessionKey.as_ref().map(|b| b.len()).unwrap_or(0),
		file._ownerKeyVersion,
		file._ownerGroup.is_some(),
		mail.confidential,
	)
}

#[derive(Clone)]
struct AppState {
	sdk: Arc<LoggedInSdk>,
	bridge_token: Option<String>,
	login_mail: String,
}

#[derive(Deserialize)]
struct InvokeBody {
	method: String,
	#[serde(default)]
	params: Value,
}

#[derive(Deserialize, Clone)]
struct BridgeEmailAddress {
	name: Option<String>,
	address: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSendMessageRequest {
	from: Option<BridgeEmailAddress>,
	to: Vec<BridgeEmailAddress>,
	#[serde(default)]
	cc: Vec<BridgeEmailAddress>,
	#[serde(default)]
	bcc: Vec<BridgeEmailAddress>,
	subject: String,
	body_text: Option<String>,
	body_html: Option<String>,
	#[serde(default)]
	reply_to: Vec<BridgeEmailAddress>,
	external_password: Option<String>,
}

fn parse_send_request(params: &Value, login_mail: &str) -> Result<SendMailInput, BridgeFailure> {
	let request_value = params
		.get("request")
		.cloned()
		.ok_or_else(|| BridgeFailure::from("sendMail: missing request payload"))?;
	let req: BridgeSendMessageRequest = serde_json::from_value(request_value).map_err(|e| {
		BridgeFailure::from(format!(
			"sendMail: invalid request payload shape: {e}"
		))
	})?;
	if req.to.is_empty() {
		return Err(BridgeFailure::from("sendMail: to must include at least one recipient"));
	}
	let body = req
		.body_html
		.as_deref()
		.filter(|s| !s.trim().is_empty())
		.map(str::to_string)
		.or_else(|| {
			req.body_text
				.as_deref()
				.filter(|s| !s.trim().is_empty())
				.map(str::to_string)
		})
		.ok_or_else(|| BridgeFailure::from("sendMail: bodyText or bodyHtml is required"))?;
	let sender = req.from.unwrap_or(BridgeEmailAddress {
		name: None,
		address: login_mail.to_string(),
	});
	let map_addr = |a: BridgeEmailAddress| SendMailAddressInput {
		name: a.name,
		address: a.address,
	};
	Ok(SendMailInput {
		sender: map_addr(sender),
		to: req.to.into_iter().map(map_addr).collect(),
		cc: req.cc.into_iter().map(map_addr).collect(),
		bcc: req.bcc.into_iter().map(map_addr).collect(),
		reply_to: req.reply_to.into_iter().map(map_addr).collect(),
		subject: req.subject,
		body,
		language: "en".to_string(),
		external_password: req.external_password,
	})
}

fn send_input_debug(input: &SendMailInput) -> String {
	format!(
		"sender={} toCount={} ccCount={} bccCount={} replyToCount={} subjectLen={} bodyLen={} language={} externalPasswordProvided={}",
		input.sender.address,
		input.to.len(),
		input.cc.len(),
		input.bcc.len(),
		input.reply_to.len(),
		input.subject.len(),
		input.body.len(),
		input.language,
		input
			.external_password
			.as_ref()
			.map(|s| !s.trim().is_empty())
			.unwrap_or(false),
	)
}

/// Same wire value as `CUSTOM_MAX_ID` in the TS client (`repeat("_", 340)`), not base64-encoded.
fn default_mail_set_entry_start() -> CustomId {
	CustomId("_".repeat(340))
}

/// Resolve `loadMails` `start` for [`MailSetEntry`] [`load_range`](CryptoEntityClient::load_range).
/// Supports cursors that are either a raw MailSetEntry [`CustomId`] or a mail `listId/elementId`.
async fn resolve_mail_set_entry_start(
	crypto: &CryptoEntityClient,
	entries_list_id: &GeneratedId,
	cursor: Option<&str>,
) -> Result<CustomId, BridgeFailure> {
	let default_start = default_mail_set_entry_start();
	let Some(cursor) = cursor.filter(|s| !s.is_empty()) else {
		return Ok(default_start);
	};
	if !cursor.contains('/') {
		return Ok(CustomId(cursor.to_string()));
	}
	let mail_id = IdTupleGenerated::try_from(cursor.to_string())
		.map_err(|_| BridgeFailure::from("invalid mail id cursor"))?;
	let mut start = default_start;
	const BATCH: usize = 200;
	const MAX_BATCHES: usize = 50;
	for _ in 0..MAX_BATCHES {
		let batch: Vec<MailSetEntry> = crypto
			.load_range::<MailSetEntry, CustomId>(entries_list_id, &start, BATCH, ListLoadDirection::DESC)
			.await
			.map_err(|e| BridgeFailure::from(e.to_string()))?;
		if batch.is_empty() {
			return Err("cursor mail not found in this folder".into());
		}
		for e in &batch {
			if e.mail == mail_id {
				return e
					._id
					.as_ref()
					.map(|id| id.element_id.clone())
					.ok_or_else(|| BridgeFailure::from("MailSetEntry missing _id"));
			}
		}
		if batch.len() < BATCH {
			return Err("cursor mail not found in this folder".into());
		}
		start = batch
			.last()
			.and_then(|e| e._id.as_ref().map(|id| id.element_id.clone()))
			.ok_or_else(|| BridgeFailure::from("MailSetEntry batch missing _id".to_string()))?;
	}
	Err("cursor mail not found in this folder (search limit exceeded)".into())
}

fn datetime_iso(d: DateTime) -> String {
	let nanos = d.as_millis() as i128 * 1_000_000i128;
	OffsetDateTime::from_unix_timestamp_nanos(nanos)
		.ok()
		.and_then(|t| t.format(&Rfc3339).ok())
		.unwrap_or_else(|| d.as_millis().to_string())
}

fn mail_to_raw(m: &Mail) -> Value {
	let id = m._id.as_ref().map(ToString::to_string).unwrap_or_default();
	json!({
		"id": id,
		"subject": m.subject,
		"receivedDate": datetime_iso(m.receivedDate),
		"unread": m.unread,
		"confidential": m.confidential,
		"state": m.state,
		"sender": { "name": m.sender.name, "address": m.sender.address },
		"attachmentCount": m.attachments.len() as i64,
		"folderIds": m.sets.iter().map(ToString::to_string).collect::<Vec<String>>(),
		"differentEnvelopeSender": m.differentEnvelopeSender,
		"authStatus": m.authStatus,
		"phishingStatus": m.phishingStatus,
		"listUnsubscribe": m.listUnsubscribe,
		"replyType": m.replyType,
		"mailDetails": m.mailDetails.as_ref().map(ToString::to_string),
		"mailDetailsDraft": m.mailDetailsDraft.as_ref().map(ToString::to_string),
	})
}

async fn load_folder_system(sdk: &LoggedInSdk) -> Result<FolderSystem, ApiCallError> {
	let facade = sdk.mail_facade();
	let mailbox = facade.load_user_mailbox().await?;
	facade.load_folders_for_mailbox(&mailbox).await
}

fn mail_address_json(a: &MailAddress) -> Value {
	json!({ "name": a.name, "address": a.address })
}

fn enc_mail_address_json(a: &EncryptedMailAddress) -> Value {
	json!({ "name": a.name, "address": a.address })
}

fn mail_details_to_raw(d: &MailDetails) -> Value {
	let headers: Value = match &d.headers {
		Some(h) => match &h.headers {
			Some(raw) => {
				if let Ok(v) = serde_json::from_str::<Value>(raw) {
					v
				} else {
					json!({})
				}
			},
			None => json!({}),
		},
		None => json!({}),
	};
	json!({
		"sentDate": datetime_iso(d.sentDate),
		"recipients": {
			"toRecipients": d.recipients.toRecipients.iter().map(mail_address_json).collect::<Vec<_>>(),
			"ccRecipients": d.recipients.ccRecipients.iter().map(mail_address_json).collect::<Vec<_>>(),
			"bccRecipients": d.recipients.bccRecipients.iter().map(mail_address_json).collect::<Vec<_>>(),
		},
		"replyTos": d.replyTos.iter().map(enc_mail_address_json).collect::<Vec<_>>(),
		"body": { "text": d.body.text.clone().unwrap_or_default() },
		"headers": headers,
	})
}

fn resolve_mail_set<'a>(
	fs: &'a FolderSystem,
	folder_id: Option<&str>,
) -> Result<&'a MailSet, BridgeFailure> {
	let fid = folder_id.filter(|s| !s.is_empty());
	if let Some(s) = fid {
		if let Some(ms) = fs.mail_sets().iter().find(|ms| {
			ms.entries.to_string() == *s || ms._id.as_ref().map(ToString::to_string).as_deref() == Some(s)
		}) {
			return Ok(ms);
		}
		return Err(format!("Unknown folder id {s}").into());
	}
	fs.system_folder_by_type(MailSetKind::Inbox)
		.ok_or_else(|| BridgeFailure::from("Inbox folder not found".to_string()))
}

async fn handle_invoke(
	State(state): State<Arc<AppState>>,
	headers: axum::http::HeaderMap,
	Json(body): Json<InvokeBody>,
) -> (StatusCode, Json<Value>) {
	if let Some(ref expected) = state.bridge_token {
		let ok = headers
			.get(AUTHORIZATION)
			.and_then(|v| v.to_str().ok())
			.map(|s| s.strip_prefix("Bearer ").map(|t| t == expected.as_str()).unwrap_or(false))
			.unwrap_or(false);
		if !ok {
			return (
				StatusCode::UNAUTHORIZED,
				Json(json!({ "ok": false, "message": "missing or invalid Authorization bearer" })),
			);
		}
	}

	let res = dispatch(&state.sdk, &state.login_mail, &body.method, &body.params).await;
	match res {
		Ok(v) => (StatusCode::OK, Json(json!({ "ok": true, "data": v }))),
		Err(f) => {
			if let Some(ref d) = f.debug {
				log::warn!("invoke {} failed: {} | {}", body.method, f.message, d);
			} else {
				log::warn!("invoke {} failed: {}", body.method, f.message);
			}
			let mut out = json!({ "ok": false, "message": f.message });
			if let Some(d) = f.debug {
				out["debug"] = json!(d);
			}
			if let Some(ref c) = f.error_code {
				out["errorCode"] = json!(c);
			}
			(StatusCode::OK, Json(out))
		},
	}
}

async fn dispatch(
	sdk: &LoggedInSdk,
	login_mail: &str,
	method: &str,
	params: &Value,
) -> Result<Value, BridgeFailure> {
	let crypto = sdk.mail_facade().get_crypto_entity_client();
	match method {
		"loadFolders" => {
			let fs = load_folder_system(sdk).await.map_err(|e| BridgeFailure::from(e.to_string()))?;
			let out: Vec<Value> = fs.mail_sets().iter().map(folder_to_json).collect();
			Ok(Value::Array(out))
		}
		"loadMails" => {
			let fs = load_folder_system(sdk).await.map_err(|e| BridgeFailure::from(e.to_string()))?;
			let folder_id = params.get("folderId").and_then(|v| v.as_str());
			let count = params
				.get("count")
				.and_then(|v| v.as_u64())
				.unwrap_or(50)
				.min(200) as usize;
			let cursor = params.get("cursor").and_then(|v| v.as_str());
			let mail_set = resolve_mail_set(&fs, folder_id)?;
			let start = resolve_mail_set_entry_start(crypto.as_ref(), &mail_set.entries, cursor)
				.await?;
			let entries: Vec<MailSetEntry> = crypto
				.load_range::<MailSetEntry, CustomId>(&mail_set.entries, &start, count + 1, ListLoadDirection::DESC)
				.await
				.map_err(|e| BridgeFailure::from(e.to_string()))?;
			let mut raw_mails = Vec::with_capacity(entries.len());
			for e in entries.iter().take(count + 1) {
				let mail_id = e.mail.clone();
				match crypto.load::<Mail, _>(&mail_id).await {
					Ok(mail) => raw_mails.push(mail_to_raw(&mail)),
					Err(err) => {
						log::warn!("loadMails: skipping undecryptable mail {}: {}", mail_id, err);
					},
				}
			}
			Ok(Value::Array(raw_mails))
		}
		"loadMail" => {
			let id = params.get("id").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing id"))?;
			let tid = IdTupleGenerated::try_from(id.to_string()).map_err(|_| BridgeFailure::from("invalid mail id"))?;
			let mail: Option<Mail> = crypto.load(&tid).await.ok();
			match mail {
				Some(m) => Ok(mail_to_raw(&m)),
				None => Ok(Value::Null),
			}
		}
		"loadMailDetails" => {
			let mail_id_str =
				params.get("mailId").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing mailId"))?;
			let tid =
				IdTupleGenerated::try_from(mail_id_str.to_string()).map_err(|_| BridgeFailure::from("invalid mailId"))?;
			let mail: Mail = crypto.load(&tid).await.map_err(|e| BridgeFailure::from(e.to_string()))?;
			let details = sdk
				.load_mail_details_for_mail(&mail)
				.await
				.map_err(|e| BridgeFailure::from(e.to_string()))?;
			Ok(mail_details_to_raw(&details))
		}
		"loadAttachmentMeta" => {
			let mail_id_str =
				params.get("mailId").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing mailId"))?;
			let tid =
				IdTupleGenerated::try_from(mail_id_str.to_string()).map_err(|_| BridgeFailure::from("invalid mailId"))?;
			let mail: Mail = crypto.load(&tid).await.map_err(|e| BridgeFailure::from(e.to_string()))?;
			let mut out = Vec::new();
			for att_id in &mail.attachments {
				let f: TutanotaFile = crypto.load(att_id).await.map_err(|e| BridgeFailure::from(e.to_string()))?;
				let id = f._id.as_ref().map(ToString::to_string).unwrap_or_default();
				out.push(json!({
					"id": id,
					"name": f.name,
					"mimeType": f.mimeType.unwrap_or_else(|| "application/octet-stream".to_string()),
					"size": f.size,
					"cid": f.cid,
				}));
			}
			Ok(Value::Array(out))
		}
		"downloadAttachment" => {
			let message_id = params
				.get("messageId")
				.and_then(|v| v.as_str())
				.ok_or_else(|| BridgeFailure::from("missing messageId"))?;
			let attachment_id = params
				.get("attachmentId")
				.and_then(|v| v.as_str())
				.ok_or_else(|| BridgeFailure::from("missing attachmentId"))?;
			let mail_tid = IdTupleGenerated::try_from(message_id.to_string())
				.map_err(|_| BridgeFailure::from("invalid messageId"))?;
			let file_tid = IdTupleGenerated::try_from(attachment_id.to_string())
				.map_err(|_| BridgeFailure::from("invalid attachmentId"))?;
			let mail: Mail = crypto.load(&mail_tid).await.map_err(|e| BridgeFailure {
				message: format!("downloadAttachment: load Mail failed: {e}"),
				debug: Some(format!("messageId={message_id}")),
				error_code: None,
			})?;
			if !mail.attachments.iter().any(|a| a == &file_tid) {
				return Err(BridgeFailure {
					message: "attachment does not belong to the given message".to_string(),
					debug: Some(format!(
						"messageId={message_id} attachmentId={attachment_id} mail.attachments.ids={:?}",
						mail.attachments.iter().map(|a| a.to_string()).collect::<Vec<_>>()
					)),
					error_code: None,
				});
			}
			let file: TutanotaFile = crypto.load(&file_tid).await.map_err(|e| BridgeFailure {
				message: format!("downloadAttachment: load TutanotaFile failed: {e}"),
				debug: Some(format!(
					"messageId={message_id} attachmentId={attachment_id} mail.bucketKey.some={} mail.bucketEncSessionKeys.len={}",
					mail.bucketKey.is_some(),
					mail.bucketKey.as_ref().map(|b| b.bucketEncSessionKeys.len()).unwrap_or(0),
				)),
				error_code: None,
			})?;
			let bytes = sdk
				.download_tutanota_file_attachment_for_mail(&mail, &file)
				.await
				.map_err(|e| BridgeFailure {
					message: format!("downloadAttachment: decrypt or blob download failed: {e}"),
					debug: Some(attachment_download_debug(&mail, &file)),
					error_code: None,
				})?;
			Ok(json!({
				"contentBase64": BASE64_STANDARD.encode(&bytes),
				"filename": file.name,
				"contentType": file.mimeType.unwrap_or_else(|| "application/octet-stream".to_string()),
			}))
		}
		"setUnread" => {
			let id = params.get("id").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing id"))?;
			let unread = params
				.get("unread")
				.and_then(|v| v.as_bool())
				.ok_or_else(|| BridgeFailure::from("missing unread"))?;
			let tid = IdTupleGenerated::try_from(id.to_string()).map_err(|_| BridgeFailure::from("invalid mail id"))?;
			sdk.mail_facade()
				.set_unread_status_for_mails(vec![tid], unread)
				.await
				.map_err(|e| BridgeFailure::from(e.to_string()))?;
			Ok(Value::Bool(true))
		}
		"trashMail" => {
			let id = params.get("id").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing id"))?;
			let tid = IdTupleGenerated::try_from(id.to_string()).map_err(|_| BridgeFailure::from("invalid mail id"))?;
			sdk.mail_facade()
				.trash_mails(vec![tid])
				.await
				.map_err(|e| BridgeFailure::from(e.to_string()))?;
			Ok(Value::Bool(true))
		}
		"moveMail" => {
			let id = params.get("id").and_then(|v| v.as_str()).ok_or_else(|| BridgeFailure::from("missing id"))?;
			let target = params
				.get("targetFolderId")
				.and_then(|v| v.as_str())
				.ok_or_else(|| BridgeFailure::from("missing targetFolderId"))?;
			let tid = IdTupleGenerated::try_from(id.to_string()).map_err(|_| BridgeFailure::from("invalid mail id"))?;
			if !is_trash_folder_target(target) {
				return Err(BridgeFailure::from(format!(
					"moveMail: only trash is supported by the SDK simple move service (got {target})"
				)));
			}
			sdk.mail_facade()
				.simple_move_mail(vec![tid], MailSetKind::Trash)
				.await
				.map_err(|e| BridgeFailure::from(e.to_string()))?;
			Ok(Value::Bool(true))
		}
		"sendMail" => {
			let input = parse_send_request(params, login_mail)?;
			let input_debug = send_input_debug(&input);
			let sent = sdk.send_mail_standard(input).await.map_err(|e| match e {
				ApiCallError::ExternalSecureSendUnavailable { message } => BridgeFailure {
					message,
					debug: Some(format!("send flow (password-protected external) | {input_debug}")),
					error_code: Some(ERROR_CODE_EXTERNAL_SECURE_SEND_UNAVAILABLE.to_string()),
				},
				e => BridgeFailure {
					message: format!("sendMail failed: {e}"),
					debug: Some(format!(
						"send flow: DraftService -> SendDraftService | {input_debug}"
					)),
					error_code: None,
				},
			})?;
			Ok(json!({ "messageId": sent.messageId }))
		}
		_ => Err(BridgeFailure::from(format!("Unknown method {method}"))),
	}
}

fn folder_to_json(ms: &MailSet) -> Value {
	json!({
		"id": ms.entries.to_string(),
		"name": ms.name,
		"folderType": ms.folderType,
	})
}

fn is_trash_folder_target(target: &str) -> bool {
	let lower = target.to_ascii_lowercase();
	lower == "trash" || target == "3"
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
	let api_url = std::env::var("TUTA_MAIL_BRIDGE_API_URL")
		.or_else(|_| std::env::var("TUTA_API_URL"))
		.unwrap_or_else(|_| "https://app.tuta.com".to_string());
	let mail = std::env::var("TUTA_MAIL_BRIDGE_MAIL").map_err(|_| "TUTA_MAIL_BRIDGE_MAIL is required")?;
	let password =
		std::env::var("TUTA_MAIL_BRIDGE_PASSWORD").map_err(|_| "TUTA_MAIL_BRIDGE_PASSWORD is required")?;
	let data_dir: PathBuf = std::env::var("TUTA_MAIL_BRIDGE_DATA_DIR")
		.map(PathBuf::from)
		.unwrap_or_else(|_| std::env::temp_dir().join("tuta-mail-api-bridge-data"));
	std::fs::create_dir_all(&data_dir)?;
	let listen = std::env::var("TUTA_MAIL_BRIDGE_LISTEN").unwrap_or_else(|_| "127.0.0.1:4711".to_string());
	let bridge_token = std::env::var("TUTA_MAIL_BRIDGE_TOKEN").ok().filter(|s| !s.is_empty());

	let rest = Arc::new(NativeRestClient::try_new()?);
	let file = Arc::new(NativeFileClient::try_new(data_dir)?);
	// `Sdk::new` installs the global logger (`tuta-sdk` + `simple_logger`); do not call `simple_logger` here or init panics.
	let sdk = Sdk::new(api_url.clone(), rest, file);
	log::set_max_level(log::LevelFilter::Info);
	info!("Logging in to {api_url} as {mail} …");
	let logged_in = sdk.create_session(&mail, &password).await.map_err(|e| format!("login: {e}"))?;
	let state = Arc::new(AppState {
		sdk: logged_in,
		bridge_token,
		login_mail: mail,
	});

	let app = Router::new()
		.route("/invoke", post(handle_invoke))
		.with_state(state);

	info!("tuta-mail-api-bridge listening on http://{listen} (API {api_url})");
	let listener = tokio::net::TcpListener::bind(&listen).await?;
	axum::serve(listener, app).await?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	// ── BridgeFailure conversions ──

	#[test]
	fn bridge_failure_from_string_owns_message_and_clears_optional_fields() {
		let f = BridgeFailure::from("boom".to_string());
		assert_eq!(f.message, "boom");
		assert!(f.debug.is_none());
		assert!(f.error_code.is_none());
	}

	#[test]
	fn bridge_failure_from_static_str() {
		let f = BridgeFailure::from("static");
		assert_eq!(f.message, "static");
	}

	// ── is_trash_folder_target ──

	#[test]
	fn is_trash_folder_target_accepts_trash_aliases_and_numeric_kind() {
		assert!(is_trash_folder_target("trash"));
		assert!(is_trash_folder_target("TRASH"));
		assert!(is_trash_folder_target("Trash"));
		assert!(is_trash_folder_target("3"));
	}

	#[test]
	fn is_trash_folder_target_rejects_other_targets() {
		assert!(!is_trash_folder_target("inbox"));
		assert!(!is_trash_folder_target("archive"));
		assert!(!is_trash_folder_target("4"));
		assert!(!is_trash_folder_target(""));
	}

	// ── default_mail_set_entry_start ──

	#[test]
	fn default_mail_set_entry_start_is_340_underscores() {
		let id = default_mail_set_entry_start();
		assert_eq!(id.0.len(), 340);
		assert!(id.0.chars().all(|c| c == '_'));
	}

	// ── datetime_iso ──

	#[test]
	fn datetime_iso_formats_unix_epoch_as_rfc3339() {
		let s = datetime_iso(DateTime::from_millis(0));
		assert_eq!(s, "1970-01-01T00:00:00Z");
	}

	#[test]
	fn datetime_iso_formats_known_instant() {
		// 2024-01-02T03:04:05Z = 1_704_164_645_000 ms
		let s = datetime_iso(DateTime::from_millis(1_704_164_645_000));
		assert_eq!(s, "2024-01-02T03:04:05Z");
	}

	// ── parse_send_request ──

	fn make_send_params(req: Value) -> Value {
		json!({ "request": req })
	}

	// Helper: SendMailInput does not implement Debug, so unwrap_err is unavailable.
	fn expect_err(r: Result<SendMailInput, BridgeFailure>) -> BridgeFailure {
		match r {
			Ok(_) => panic!("expected parse_send_request to fail"),
			Err(e) => e,
		}
	}

	#[test]
	fn parse_send_request_requires_request_field() {
		let err = expect_err(parse_send_request(&json!({}), "me@x.com"));
		assert!(err.message.contains("missing request payload"));
	}

	#[test]
	fn parse_send_request_rejects_invalid_shape() {
		let params = make_send_params(json!({ "to": "not-an-array", "subject": "s" }));
		let err = expect_err(parse_send_request(&params, "me@x.com"));
		assert!(err.message.contains("invalid request payload shape"));
	}

	#[test]
	fn parse_send_request_rejects_empty_to() {
		let params = make_send_params(json!({ "to": [], "subject": "s", "bodyText": "hi" }));
		let err = expect_err(parse_send_request(&params, "me@x.com"));
		assert!(err.message.contains("at least one recipient"));
	}

	#[test]
	fn parse_send_request_requires_a_body() {
		let params = make_send_params(json!({
			"to": [{ "address": "a@b.com" }],
			"subject": "s"
		}));
		let err = expect_err(parse_send_request(&params, "me@x.com"));
		assert!(err.message.contains("bodyText or bodyHtml is required"));
	}

	#[test]
	fn parse_send_request_rejects_blank_bodies() {
		let params = make_send_params(json!({
			"to": [{ "address": "a@b.com" }],
			"subject": "s",
			"bodyText": "   ",
			"bodyHtml": "\n\t"
		}));
		let err = expect_err(parse_send_request(&params, "me@x.com"));
		assert!(err.message.contains("bodyText or bodyHtml is required"));
	}

	#[test]
	fn parse_send_request_prefers_html_body_when_present() {
		let params = make_send_params(json!({
			"to": [{ "address": "a@b.com" }],
			"subject": "Hi",
			"bodyText": "plaintext",
			"bodyHtml": "<p>html</p>"
		}));
		let input = parse_send_request(&params, "me@x.com").unwrap();
		assert_eq!(input.body, "<p>html</p>");
	}

	#[test]
	fn parse_send_request_falls_back_to_plain_text_body_when_html_blank() {
		let params = make_send_params(json!({
			"to": [{ "address": "a@b.com" }],
			"subject": "Hi",
			"bodyText": "plaintext-only",
			"bodyHtml": "   "
		}));
		let input = parse_send_request(&params, "me@x.com").unwrap();
		assert_eq!(input.body, "plaintext-only");
	}

	#[test]
	fn parse_send_request_uses_login_mail_when_from_missing() {
		let params = make_send_params(json!({
			"to": [{ "address": "a@b.com" }],
			"subject": "s",
			"bodyText": "hello"
		}));
		let input = parse_send_request(&params, "service@tuta.com").unwrap();
		assert_eq!(input.sender.address, "service@tuta.com");
		assert!(input.sender.name.is_none());
	}

	#[test]
	fn parse_send_request_maps_full_address_set_and_external_password() {
		let params = make_send_params(json!({
			"from": { "name": "Me", "address": "me@x.com" },
			"to": [{ "name": "T1", "address": "t1@x.com" }, { "address": "t2@x.com" }],
			"cc": [{ "address": "c@x.com" }],
			"bcc": [{ "address": "b@x.com" }],
			"replyTo": [{ "address": "r@x.com" }],
			"subject": "Subject!",
			"bodyText": "body",
			"externalPassword": "S3cret"
		}));
		let input = parse_send_request(&params, "fallback@x.com").unwrap();
		assert_eq!(input.sender.address, "me@x.com");
		assert_eq!(input.sender.name.as_deref(), Some("Me"));
		assert_eq!(input.to.len(), 2);
		assert_eq!(input.to[0].name.as_deref(), Some("T1"));
		assert_eq!(input.to[1].address, "t2@x.com");
		assert_eq!(input.cc.len(), 1);
		assert_eq!(input.bcc.len(), 1);
		assert_eq!(input.reply_to.len(), 1);
		assert_eq!(input.subject, "Subject!");
		assert_eq!(input.language, "en");
		assert_eq!(input.external_password.as_deref(), Some("S3cret"));
	}

	#[test]
	fn send_input_debug_contains_counts_and_no_password_value() {
		let params = make_send_params(json!({
			"to": [{ "address": "t@x.com" }],
			"subject": "S",
			"bodyText": "hello",
			"externalPassword": "DO_NOT_LEAK"
		}));
		let input = parse_send_request(&params, "me@x.com").unwrap();
		let dbg = send_input_debug(&input);
		assert!(dbg.contains("toCount=1"));
		assert!(dbg.contains("ccCount=0"));
		assert!(dbg.contains("subjectLen=1"));
		assert!(dbg.contains("bodyLen=5"));
		assert!(dbg.contains("language=en"));
		assert!(dbg.contains("externalPasswordProvided=true"));
		assert!(!dbg.contains("DO_NOT_LEAK"));
	}

	#[test]
	fn send_input_debug_marks_password_as_not_provided_when_blank() {
		let params = make_send_params(json!({
			"to": [{ "address": "t@x.com" }],
			"subject": "S",
			"bodyText": "hi",
			"externalPassword": "   "
		}));
		let input = parse_send_request(&params, "me@x.com").unwrap();
		assert!(send_input_debug(&input).contains("externalPasswordProvided=false"));
	}
}

