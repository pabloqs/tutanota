#![macro_use]

use std::collections::HashMap;
use std::error::Error;
use std::fmt::{Debug, Display, Formatter};
use std::sync::Arc;

use minicbor::encode::Write;
use minicbor::{Encode, Encoder};
use serde::Serialize;
use thiserror::Error;

#[cfg_attr(test, mockall_double::double)]
use crate::blobs::blob_access_token_facade::BlobAccessTokenFacade;
use crate::blobs::blob_facade::BlobFacade;
#[cfg_attr(test, mockall_double::double)]
use crate::crypto::asymmetric_crypto_facade::AsymmetricCryptoFacade;
use crate::crypto::crypto_facade::create_auth_verifier;
#[cfg_attr(test, mockall_double::double)]
use crate::crypto::crypto_facade::CryptoFacade;
use crate::crypto::key::VersionedAesKey;
#[cfg_attr(test, mockall_double::double)]
use crate::crypto::public_key_provider::{
	PublicKeyIdentifier, PublicKeyLoadingError, PublicKeyProvider,
};
#[cfg_attr(test, mockall_double::double)]
use crate::crypto_entity_client::CryptoEntityClient;
use crate::date::date_provider::SystemDateProvider;
use crate::element_value::{ElementValue, ParsedEntity};
use crate::entities::entity_facade::{EntityFacade, EntityFacadeImpl};
use crate::entities::generated::sys::{CreateSessionData, SaltData, User};
use crate::entities::generated::sys::{ExternalUserReference, Group, GroupRoot, RootInstance};
use crate::entities::generated::tutanota::{
	CreateExternalUserGroupData, DraftCreateData, DraftCreateReturn, DraftData, DraftRecipient,
	EncryptedMailAddress, ExternalUserData, InternalRecipientKeyData, Mail, MailDetails,
	MailDetailsBlob, SecureExternalRecipientKeyData, SendDraftData, SendDraftParameters,
	SendDraftReturn, TutanotaFile, TutanotaProperties,
};
#[cfg_attr(test, mockall_double::double)]
use crate::entity_client::EntityClient;
use crate::instance_mapper::InstanceMapper;
use crate::json_serializer::{InstanceMapperError, JsonSerializer};
#[cfg_attr(test, mockall_double::double)]
use crate::key_cache::KeyCache;
#[cfg_attr(test, mockall_double::double)]
use crate::key_loader_facade::KeyLoaderFacade;
use crate::login::login_facade::{derive_user_passphrase_key, KdfType};
use crate::login::{CredentialType, Credentials, LoginError, LoginFacade};
use crate::mail_facade::MailFacade;
use crate::rest_error::{HttpError, ParseFailureError};
use crate::services::generated::sys::{SaltService, SessionService};
use crate::services::generated::tutanota::{DraftService, ExternalUserService, SendDraftService};
#[cfg_attr(test, mockall_double::double)]
use crate::services::service_executor::{ResolvingServiceExecutor, ServiceExecutor};
use crate::services::ExtraServiceParams;
use crate::tutanota_constants::PublicKeyIdentifierType;
use crate::type_model_provider::TypeModelProvider;
#[cfg_attr(test, mockall_double::double)]
use crate::typed_entity_client::TypedEntityClient;
#[cfg_attr(test, mockall_double::double)]
use crate::user_facade::UserFacade;
use crate::util::convert_version_to_i64;
use bindings::file_client::FileClient;
use bindings::rest_client::{RestClient, RestClientError};
use crypto_primitives::aes::{Aes256Key, Iv};
use crypto_primitives::key::GenericAesKey;
use crypto_primitives::randomizer_facade::RandomizerFacade;

pub mod contacts;
pub mod crypto;
pub mod crypto_entity_client;
pub mod customer;
pub mod date;
mod element_value;
pub mod entities;
mod entity_client;
pub mod folder_system;
mod groups;
mod instance_mapper;
mod json_element;
mod json_serializer;
mod key_cache;
mod key_loader_facade;
mod logging;
pub mod login;
mod mail_facade;
mod metamodel;

pub mod bindings;
pub mod blobs;
mod id;
#[cfg(feature = "net")]
pub mod net;
pub mod rest_error;
pub mod services;
mod simple_crypto;
pub mod tutanota_constants;
pub mod type_model_provider;
mod typed_entity_client;
mod user_facade;
mod user_facade_factory;
pub mod util;

use crate::bindings::suspendable_rest_client::SuspendableRestClient;
#[cfg_attr(test, mockall_double::double)]
use crate::contacts::contact_facade::ContactFacade;
#[cfg_attr(test, mockall_double::double)]
use crate::customer::customer_facade::CustomerFacade;
use crate::date::calendar_facade::CalendarFacade;
use crate::date::event_facade::EventFacade;
use crate::entities::generated::storage::BlobServerAccessInfo;
use crate::entities::Entity;
use crate::groups::GroupType;
use crate::metamodel::TypeModel;
use crate::tutanota_constants::ArchiveDataType;
#[cfg_attr(test, mockall_double::double)]
use crate::user_facade_factory::UserFacadeFactory;
pub use id::custom_id::CustomId;
pub use id::generated_id::GeneratedId;
pub use id::id_tuple::IdTupleCustom;
pub use id::id_tuple::IdTupleGenerated;
use metamodel::{AppName, TypeId};

pub static CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

uniffi::setup_scaffolding!();

/// A type for an instance/entity from the backend
/// Definitions for them can be found inside the type model JSON files under `/test_data`
#[derive(PartialEq, Clone, Debug)]
pub struct TypeRef {
	pub app: AppName,
	pub type_id: TypeId,
}

impl TypeRef {
	#[must_use]
	pub fn new(app: AppName, type_id: TypeId) -> Self {
		Self { app, type_id }
	}
}

// Option 1:
// metamodel -> Rust struct -> Kotlin/Swift classes
// need to be able to covert from ParsedEntity -> Rust struct
// will generate a bit more code, but we need to write the conversion only once
// might or might not work for WASM

// Option 2:
// metamodel -> Kotlin/Swift classes
// need to be able to covert from ParsedEntity -> Kotlin/Swift class
// will generate a bit less code, but we need to write the conversion for every platform
// will work for WASM for sure

impl Display for TypeRef {
	fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
		write!(f, "TypeRef({}, {:?})", self.app, self.type_id)
	}
}

pub struct HeadersProvider {
	access_token: Option<String>,
}

impl HeadersProvider {
	#[must_use]
	fn new(access_token: Option<String>) -> Self {
		Self { access_token }
	}

	fn provide_headers(&self, model_version: u64) -> HashMap<String, String> {
		let mut headers = HashMap::from([
			("cv".to_owned(), CLIENT_VERSION.to_string()),
			("v".to_owned(), model_version.to_string()),
		]);

		if let Some(access_token) = &self.access_token {
			headers.insert("accessToken".to_owned(), access_token.to_string());
		}

		headers
	}
}

/// The external facing interface used by the consuming code via FFI
#[derive(uniffi::Object)]
pub struct Sdk {
	type_model_provider: Arc<TypeModelProvider>,
	json_serializer: Arc<JsonSerializer>,
	instance_mapper: Arc<InstanceMapper>,
	rest_client: Arc<dyn RestClient>,
	base_url: String,
}

#[uniffi::export]
impl Sdk {
	#[uniffi::constructor]
	pub fn new(
		base_url: String,
		raw_rest_client: Arc<dyn RestClient>,
		file_client: Arc<dyn FileClient>,
	) -> Sdk {
		let date_provider = Arc::new(SystemDateProvider);
		Self::new_internal(
			base_url,
			Arc::new(SuspendableRestClient::new(raw_rest_client, date_provider)),
			file_client,
		)
	}

	#[uniffi::constructor]
	pub fn new_without_suspension(
		base_url: String,
		raw_rest_client: Arc<dyn RestClient>,
		file_client: Arc<dyn FileClient>,
	) -> Sdk {
		Self::new_internal(base_url, raw_rest_client, file_client)
	}

	/// Authorizes the SDK's REST requests via inserting `access_token` into the HTTP headers
	pub async fn login(&self, credentials: Credentials) -> Result<Arc<LoggedInSdk>, LoginError> {
		self.type_model_provider
			.initialize_server_model_from_file()
			.await;

		let auth_headers_provider =
			Arc::new(HeadersProvider::new(Some(credentials.access_token.clone())));

		let entity_facade = Arc::new(EntityFacadeImpl::new(
			self.type_model_provider.clone(),
			RandomizerFacade::from_core(rand_core::OsRng),
		));

		let entity_client = Arc::new(EntityClient::new(
			self.rest_client.clone(),
			self.json_serializer.clone(),
			self.base_url.clone(),
			auth_headers_provider.clone(),
			self.type_model_provider.clone(),
		));
		let typed_entity_client: Arc<TypedEntityClient> = Arc::new(TypedEntityClient::new(
			entity_client.clone(),
			self.instance_mapper.clone(),
		));

		let key_cache = Arc::new(KeyCache::new());
		let user_facade_factory = Arc::new(UserFacadeFactory::new(key_cache.clone()));

		let login_facade = LoginFacade::new(
			entity_client.clone(),
			typed_entity_client.clone(),
			user_facade_factory,
			self.type_model_provider.clone(),
		);
		let user_facade = Arc::new(login_facade.resume_session(&credentials).await?);

		let key_loader_facade = Arc::new(KeyLoaderFacade::new(
			user_facade.clone(),
			typed_entity_client.clone(),
			key_cache.clone(),
		));

		let service_executor: Arc<ServiceExecutor> = Arc::new(ServiceExecutor::new(
			auth_headers_provider.clone(),
			None,
			entity_facade.clone(),
			self.instance_mapper.clone(),
			self.json_serializer.clone(),
			self.rest_client.clone(),
			self.type_model_provider.clone(),
			self.base_url.clone(),
		));
		let public_key_provider = Arc::new(PublicKeyProvider::new(service_executor.clone()));
		let asymmetric_crypto_facade = Arc::new(AsymmetricCryptoFacade::new(
			key_loader_facade.clone(),
			RandomizerFacade::from_core(rand_core::OsRng),
			service_executor.clone(),
			public_key_provider.clone(),
		));
		let crypto_facade: Arc<CryptoFacade> = Arc::new(CryptoFacade::new(
			key_loader_facade.clone(),
			self.instance_mapper.clone(),
			RandomizerFacade::from_core(rand_core::OsRng),
			asymmetric_crypto_facade.clone(),
			user_facade.clone(),
			entity_client.clone(),
		));
		let crypto_entity_client: Arc<CryptoEntityClient> = Arc::new(CryptoEntityClient::new(
			entity_client.clone(),
			entity_facade.clone(),
			crypto_facade.clone(),
			self.instance_mapper.clone(),
			asymmetric_crypto_facade.clone(),
			key_loader_facade.clone(),
		));

		let service_executor = Arc::new(ResolvingServiceExecutor::new(
			auth_headers_provider.clone(),
			crypto_facade.clone(),
			entity_facade.clone(),
			self.instance_mapper.clone(),
			self.json_serializer.clone(),
			self.rest_client.clone(),
			self.type_model_provider.clone(),
			self.base_url.clone(),
		));

		let date_provider = Arc::new(SystemDateProvider);

		let blob_facade = self.create_blob_facade(
			auth_headers_provider.clone(),
			service_executor.clone(),
			date_provider,
		);

		let contact_facade = Arc::new(ContactFacade::new(
			crypto_entity_client.clone(),
			self.type_model_provider.clone(),
			user_facade.clone(),
		));

		let customer_facade = Arc::new(CustomerFacade::new(
			crypto_entity_client.clone(),
			user_facade.clone(),
		));

		Ok(Arc::new(LoggedInSdk {
			user_facade,
			entity_client,
			service_executor,
			typed_entity_client,
			crypto_entity_client,
			instance_mapper: Arc::clone(&self.instance_mapper),
			entity_facade,
			blob_facade,
			json_serializer: Arc::clone(&self.json_serializer),
			type_model_provider: Arc::clone(&self.type_model_provider),
			contact_facade,
			customer_facade,
			asymmetric_crypto_facade,
			public_key_provider,
		}))
	}

	// not ready yet for production use, only does temporary login for free users without offline.
	pub async fn create_session(
		&self,
		mail_address: &str,
		passphrase: &str,
	) -> Result<Arc<LoggedInSdk>, LoginError> {
		let headers_provider = Arc::new(HeadersProvider::new(None));
		let entity_facade = Arc::new(EntityFacadeImpl::new(
			self.type_model_provider.clone(),
			RandomizerFacade::from_core(rand_core::OsRng),
		));

		let service_executor = ServiceExecutor::new(
			headers_provider.clone(),
			None,
			entity_facade,
			self.instance_mapper.clone(),
			self.json_serializer.clone(),
			self.rest_client.clone(),
			self.type_model_provider.clone(),
			self.base_url.to_string(),
		);
		let salt_get_input: SaltData = SaltData {
			_format: 0,
			mailAddress: mail_address.to_string(),
		};
		let salt_return = service_executor
			.get::<SaltService>(salt_get_input, ExtraServiceParams::default())
			.await?;

		let Ok(salt) = salt_return.salt.try_into() else {
			return Err(LoginError::InvalidKey {
				error_message: "salt has wrong length".to_string(),
			});
		};

		let randomizer = RandomizerFacade::from_core(rand_core::OsRng);
		let access_key = Aes256Key::generate(&randomizer);
		let user_passphrase_key = derive_user_passphrase_key(KdfType::Argon2id, passphrase, salt);
		let auth_verifier = create_auth_verifier(user_passphrase_key.clone());
		let session_data: CreateSessionData = CreateSessionData {
			_format: 0,
			accessKey: Some(access_key.as_bytes().to_vec()),
			authToken: None,
			authVerifier: Some(auth_verifier),
			clientIdentifier: "Linux Desktop".to_string(),
			mailAddress: Some(mail_address.to_string()),
			recoverCodeVerifier: None,
			user: None,
		};
		let encrypted_passphrase_key = GenericAesKey::Aes256(access_key).encrypt_key(
			&GenericAesKey::Aes256(user_passphrase_key),
			Iv::generate(&randomizer),
		);
		let session_data_response = service_executor
			.post::<SessionService>(session_data, ExtraServiceParams::default())
			.await?;

		self.login(Credentials {
			login: mail_address.to_string(),
			user_id: session_data_response.user.clone(),
			access_token: session_data_response.accessToken.clone(),
			encrypted_passphrase_key,
			credential_type: CredentialType::Internal,
		})
		.await
	}

	#[must_use]
	pub fn serialize_mail(&self, mail_server_model_parsed: ParsedEntity) -> Vec<u8> {
		let mut vec = Vec::new();
		let mut encoder = Encoder::new(&mut vec);
		encoder.encode(&mail_server_model_parsed).unwrap();
		vec
	}

	pub fn make_typed_mail(
		&self,
		mail_server_model_parsed: ParsedEntity,
	) -> Result<Mail, ApiCallError> {
		self.instance_mapper
			.parse_entity(mail_server_model_parsed)
			.map_err(|e| {
				ApiCallError::internal_with_err(
					e,
					"Can not deserialize server_model_parsed mail to Mail object",
				)
			})
	}
}

impl Sdk {
	fn new_internal(
		base_url: String,
		rest_client: Arc<dyn RestClient>,
		file_client: Arc<dyn FileClient>,
	) -> Self {
		logging::init_logger();
		log::info!("Initializing SDK...");
		let type_model_provider = Arc::new(TypeModelProvider::new(
			rest_client.clone(),
			file_client,
			base_url.clone(),
		));
		// TODO validate parameters
		let instance_mapper = Arc::new(InstanceMapper::new(type_model_provider.clone()));
		let json_serializer = Arc::new(JsonSerializer::new(type_model_provider.clone()));

		Sdk {
			type_model_provider,
			json_serializer,
			instance_mapper,
			rest_client,
			base_url,
		}
	}

	fn create_blob_facade(
		&self,
		auth_headers_provider: Arc<HeadersProvider>,
		service_executor: Arc<ResolvingServiceExecutor>,
		date_provider: Arc<SystemDateProvider>,
	) -> Arc<BlobFacade> {
		let blob_access_token_facade = BlobAccessTokenFacade::new(
			RandomizerFacade::from_core(rand_core::OsRng),
			service_executor,
			date_provider.clone(),
		);

		let blob_facade = BlobFacade::new(
			blob_access_token_facade,
			self.rest_client.clone(),
			RandomizerFacade::from_core(rand_core::OsRng),
			auth_headers_provider.clone(),
			self.instance_mapper.clone(),
			self.json_serializer.clone(),
			Arc::clone(&self.type_model_provider),
		);
		Arc::new(blob_facade)
	}
}

#[allow(dead_code)]
#[derive(uniffi::Object)]
pub struct LoggedInSdk {
	user_facade: Arc<UserFacade>,
	entity_client: Arc<EntityClient>,
	service_executor: Arc<ResolvingServiceExecutor>,
	entity_facade: Arc<dyn EntityFacade>,
	json_serializer: Arc<JsonSerializer>,
	typed_entity_client: Arc<TypedEntityClient>,
	crypto_entity_client: Arc<CryptoEntityClient>,
	blob_facade: Arc<BlobFacade>,
	pub instance_mapper: Arc<InstanceMapper>,
	pub type_model_provider: Arc<TypeModelProvider>,
	pub contact_facade: Arc<ContactFacade>,
	pub customer_facade: Arc<CustomerFacade>,
	asymmetric_crypto_facade: Arc<AsymmetricCryptoFacade>,
	public_key_provider: Arc<PublicKeyProvider>,
}

#[derive(Clone)]
pub struct SendMailAddressInput {
	pub name: Option<String>,
	pub address: String,
}

pub struct SendMailInput {
	pub sender: SendMailAddressInput,
	pub to: Vec<SendMailAddressInput>,
	pub cc: Vec<SendMailAddressInput>,
	pub bcc: Vec<SendMailAddressInput>,
	pub reply_to: Vec<SendMailAddressInput>,
	pub subject: String,
	pub body: String,
	pub language: String,
	pub external_password: Option<String>,
}

impl LoggedInSdk {
	fn random_aggregate_custom_id() -> CustomId {
		use base64::prelude::BASE64_URL_SAFE_NO_PAD;
		use base64::Engine;
		let randomizer = RandomizerFacade::from_core(rand_core::OsRng);
		CustomId(BASE64_URL_SAFE_NO_PAD.encode(randomizer.generate_random_array::<4>()))
	}

	fn map_draft_recipient(input: &SendMailAddressInput) -> DraftRecipient {
		DraftRecipient {
			_id: Some(Self::random_aggregate_custom_id()),
			name: input.name.clone().unwrap_or_default(),
			mailAddress: input.address.clone(),
			_errors: Default::default(),
		}
	}

	fn map_reply_to(input: &SendMailAddressInput) -> EncryptedMailAddress {
		EncryptedMailAddress {
			_id: Some(Self::random_aggregate_custom_id()),
			name: input.name.clone().unwrap_or_default(),
			address: input.address.clone(),
			_errors: Default::default(),
		}
	}

	async fn build_internal_recipient_key_data(
		&self,
		draft_session_key: &GenericAesKey,
		sender_key_group_id: &GeneratedId,
		recipients: &[SendMailAddressInput],
	) -> Result<Vec<InternalRecipientKeyData>, ApiCallError> {
		let mut out: Vec<InternalRecipientKeyData> = Vec::new();
		for recipient in recipients {
			let identifier = PublicKeyIdentifier {
				identifier: recipient.address.clone(),
				identifier_type: PublicKeyIdentifierType::MailAddress,
			};
			let current_pub_key = match self
				.public_key_provider
				.load_current_pub_key(&identifier)
				.await
			{
				Ok(k) => k,
				Err(PublicKeyLoadingError::KeyLoadingError(
					ApiCallError::ServerResponseError {
						source: HttpError::NotFoundError,
					},
				)) => {
					// External recipient or unknown internal address: skip internal key data.
					continue;
				},
				Err(e) => {
					return Err(ApiCallError::internal(format!(
						"send_mail_standard: load_current_pub_key({}) failed: {e}",
						recipient.address
					)));
				},
			};
			let encrypted = self
				.asymmetric_crypto_facade
				.asym_encrypt_sym_key(
					draft_session_key.clone(),
					current_pub_key,
					sender_key_group_id,
				)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: asym_encrypt_sym_key({}) failed: {e:?}",
						recipient.address
					))
				})?;
			out.push(InternalRecipientKeyData {
				_id: Some(Self::random_aggregate_custom_id()),
				mailAddress: recipient.address.clone(),
				pubEncBucketKey: encrypted.pub_enc_sym_key_bytes().to_vec(),
				recipientKeyVersion: encrypted.recipient_key_version() as i64,
				protocolVersion: encrypted.crypto_protocol_version().clone() as i64,
				senderKeyVersion: encrypted.sender_key_version().map(|v| v as i64),
			});
		}
		Ok(out)
	}

	fn custom_id_from_string(raw: &str) -> CustomId {
		use base64::prelude::BASE64_URL_SAFE_NO_PAD;
		use base64::Engine;
		CustomId(BASE64_URL_SAFE_NO_PAD.encode(raw.as_bytes()))
	}

	/// Loads the account [`GroupRoot`] used for external-user references (same indirection as TS `entityClient.loadRoot(GroupRootTypeRef, userGroupId)`).
	async fn load_sys_group_root_for_external_users(&self) -> Result<GroupRoot, ApiCallError> {
		let user_group_id = self.get_user_group_id();
		let Some(type_root) = self
			.type_model_provider
			.resolve_client_type_ref(&GroupRoot::type_ref())
		else {
			return Err(ApiCallError::external_secure_send_unavailable(
				"Could not read account configuration for password-protected external mail (missing type model).",
			));
		};
		let root_instance_id = IdTupleCustom {
			list_id: user_group_id,
			element_id: type_root.root_id.clone(),
		};
		let root_instance: RootInstance = self
			.crypto_entity_client
			.load(&root_instance_id)
			.await
			.map_err(|e| {
			ApiCallError::external_secure_send_unavailable(format!(
					"Could not resolve password-protected external mail settings (GroupRoot root pointer). {e}"
				))
		})?;
		self.crypto_entity_client
			.load::<GroupRoot, GeneratedId>(&root_instance.reference)
			.await
			.map_err(|e| {
				ApiCallError::external_secure_send_unavailable(format!(
					"Could not load password-protected external mail settings (GroupRoot). {e}"
				))
			})
	}

	/// Mirrors TS `MailFacade.createExternalUser` — calls `ExternalUserService` so password-protected mail can target a new external address.
	async fn post_create_external_user_for_address(
		&self,
		cleaned_mail_address: &str,
		external_user_pw_key: &GenericAesKey,
		verifier: &[u8],
		kdf_version: i64,
	) -> Result<(), ApiCallError> {
		let randomizer = RandomizerFacade::from_core(rand_core::OsRng);
		let internal_user_group_key = self.user_facade.get_current_user_group_key().ok_or_else(|| {
			ApiCallError::external_secure_send_unavailable(
				"Cannot provision an external Tuta user because the account user group key is not available. Try logging in again.",
			)
		})?;
		let mail_group_id = self
			.user_facade
			.get_membership_by_group_type(GroupType::Mail)
			.map_err(|e| {
				ApiCallError::internal(format!("send_mail_standard: mail membership: {e}"))
			})?
			.group;
		let internal_mail_group_key = self.get_current_sym_group_key(&mail_group_id).await?;

		let ext_user_key = GenericAesKey::from(Aes256Key::generate(&randomizer));
		let ext_mail_key = GenericAesKey::from(Aes256Key::generate(&randomizer));
		let current_external_user_group_key = VersionedAesKey::new(ext_user_key.clone(), 0);
		let current_external_mail_group_key = VersionedAesKey::new(ext_mail_key.clone(), 0);

		let external_user_group_info_session_key =
			GenericAesKey::from(Aes256Key::generate(&randomizer));
		let external_mail_group_info_session_key =
			GenericAesKey::from(Aes256Key::generate(&randomizer));
		let tutanota_properties_session_key = GenericAesKey::from(Aes256Key::generate(&randomizer));
		let mailbox_session_key = GenericAesKey::from(Aes256Key::generate(&randomizer));

		let entropy = randomizer.generate_random_array::<32>();
		let external_user_enc_entropy = ext_user_key
			.encrypt_data(entropy.as_slice(), Iv::generate(&randomizer))
			.map_err(|e| {
				ApiCallError::internal(format!(
					"send_mail_standard: encrypt external entropy failed: {e}"
				))
			})?;

		let internal_enc =
			internal_user_group_key.encrypt_key(&ext_user_key, Iv::generate(&randomizer));
		let user_group_data = CreateExternalUserGroupData {
			// Aggregated type: server / TS client expect a client-generated CustomId (cardinality One).
			_id: Some(Self::random_aggregate_custom_id()),
			mailAddress: cleaned_mail_address.to_string(),
			externalPwEncUserGroupKey: external_user_pw_key
				.encrypt_key(&ext_user_key, Iv::generate(&randomizer)),
			internalUserEncUserGroupKey: internal_enc.object,
			internalUserGroupKeyVersion: convert_version_to_i64(internal_enc.version),
		};

		let external_user_enc_user_group_info_session_key = current_external_user_group_key
			.encrypt_key(
				&external_user_group_info_session_key,
				Iv::generate(&randomizer),
			)
			.object;
		let external_user_enc_mail_group_key = current_external_user_group_key
			.encrypt_key(&ext_mail_key, Iv::generate(&randomizer))
			.object;
		let external_user_enc_tutanota_properties_session_key = current_external_user_group_key
			.encrypt_key(&tutanota_properties_session_key, Iv::generate(&randomizer))
			.object;

		let external_mail_enc_mail_group_info_session_key = current_external_mail_group_key
			.encrypt_key(
				&external_mail_group_info_session_key,
				Iv::generate(&randomizer),
			)
			.object;
		let external_mail_enc_mail_box_session_key = current_external_mail_group_key
			.encrypt_key(&mailbox_session_key, Iv::generate(&randomizer))
			.object;

		let internal_mail_enc_user_group_info_session_key = internal_mail_group_key
			.encrypt_key(
				&external_user_group_info_session_key,
				Iv::generate(&randomizer),
			)
			.object;
		let internal_mail_enc_mail_group_info_session_key = internal_mail_group_key
			.encrypt_key(
				&external_mail_group_info_session_key,
				Iv::generate(&randomizer),
			)
			.object;

		let external_user_data = ExternalUserData {
			_format: 0,
			externalUserEncMailGroupKey: external_user_enc_mail_group_key,
			verifier: verifier.to_vec(),
			externalUserEncUserGroupInfoSessionKey: external_user_enc_user_group_info_session_key,
			externalUserEncEntropy: external_user_enc_entropy,
			internalMailEncUserGroupInfoSessionKey: internal_mail_enc_user_group_info_session_key,
			externalMailEncMailGroupInfoSessionKey: external_mail_enc_mail_group_info_session_key,
			internalMailEncMailGroupInfoSessionKey: internal_mail_enc_mail_group_info_session_key,
			externalUserEncTutanotaPropertiesSessionKey:
				external_user_enc_tutanota_properties_session_key,
			externalMailEncMailBoxSessionKey: external_mail_enc_mail_box_session_key,
			kdfVersion: kdf_version,
			internalMailGroupKeyVersion: convert_version_to_i64(internal_mail_group_key.version),
			userGroupData: user_group_data,
		};

		self.service_executor
			.post::<ExternalUserService>(external_user_data, ExtraServiceParams::default())
			.await
			.map_err(|e| {
				ApiCallError::external_secure_send_unavailable(format!(
					"Failed to provision external Tuta user for {cleaned_mail_address}: {e}"
				))
			})
	}

	async fn build_secure_external_recipient_key_data(
		&self,
		bucket_key: &GenericAesKey,
		external_password: &str,
		recipients: &[SendMailAddressInput],
	) -> Result<Vec<SecureExternalRecipientKeyData>, ApiCallError> {
		let user_group_id = self.get_user_group_id();
		let group_root = self.load_sys_group_root_for_external_users().await?;
		let key_loader = self
			.crypto_entity_client
			.get_crypto_facade()
			.get_key_loader_facade()
			.clone();
		let randomizer = RandomizerFacade::from_core(rand_core::OsRng);
		let mut out = Vec::new();

		for recipient in recipients {
			let identifier = PublicKeyIdentifier {
				identifier: recipient.address.clone(),
				identifier_type: PublicKeyIdentifierType::MailAddress,
			};
			match self
				.public_key_provider
				.load_current_pub_key(&identifier)
				.await
			{
				Ok(_) => {
					// Tuta (internal) recipient: bucket key is carried via `internalRecipientKeyData`, not secure-external.
					continue;
				},
				Err(PublicKeyLoadingError::KeyLoadingError(
					ApiCallError::ServerResponseError {
						source: HttpError::NotFoundError,
					},
				)) => {},
				Err(e) => {
					return Err(ApiCallError::internal(format!(
						"send_mail_standard: load_current_pub_key({}) for secure-external branch failed: {e}",
						recipient.address
					)));
				},
			}

			let cleaned = recipient.address.trim().to_lowercase();
			let external_ref_id = IdTupleCustom::new(
				group_root.externalUserReferences.clone(),
				Self::custom_id_from_string(&cleaned),
			);
			let salt = randomizer.generate_random_array::<16>();
			let kdf_for_send = KdfType::Argon2id;
			let password_key = derive_user_passphrase_key(kdf_for_send, external_password, salt);
			let password_verifier = crate::crypto::sha256(password_key.as_bytes()).to_vec();
			let password_key_generic = GenericAesKey::Aes256(password_key.clone());

			let external_ref: ExternalUserReference =
				match self.crypto_entity_client.load(&external_ref_id).await {
					Ok(r) => r,
					Err(ApiCallError::ServerResponseError {
						source: HttpError::NotFoundError,
					}) => {
						self.post_create_external_user_for_address(
							&cleaned,
							&password_key_generic,
							&password_verifier,
							1,
						)
						.await?;
						self.crypto_entity_client
							.load(&external_ref_id)
							.await
							.map_err(|e| {
								ApiCallError::internal(format!(
							"send_mail_standard: external user reference missing after provisioning {cleaned}: {e}"
						))
							})?
					},
					Err(e) => {
						return Err(ApiCallError::external_secure_send_unavailable(format!(
							"Could not load external-user record for {cleaned}: {e}"
						)));
					},
				};

			let external_user: User = self
				.crypto_entity_client
				.load(&external_ref.user)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: load external user failed: {e}"
					))
				})?;
			let external_mail_group_id = external_user
				.memberships
				.iter()
				.find(|m| m.groupType == Some(GroupType::Mail as i64))
				.map(|m| m.group.clone())
				.ok_or_else(|| {
					ApiCallError::internal(
						"send_mail_standard: external user has no mail group".into(),
					)
				})?;
			let external_mail_group: Group = self
				.crypto_entity_client
				.load(&external_mail_group_id)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: load external mail group failed: {e}"
					))
				})?;
			let external_user_group: Group = self
				.crypto_entity_client
				.load(&external_ref.userGroup)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: load external user group failed: {e}"
					))
				})?;

			let required_internal_user_group_key_version =
				external_user_group.adminGroupKeyVersion.unwrap_or(0).max(0) as u64;
			let required_external_user_group_key_version =
				external_mail_group.adminGroupKeyVersion.unwrap_or(0).max(0) as u64;
			let internal_user_enc_external_user_key = external_user_group
				.adminGroupEncGKey
				.clone()
				.ok_or_else(|| {
					ApiCallError::internal(
						"send_mail_standard: missing adminGroupEncGKey on external user group"
							.into(),
					)
				})?;
			let external_user_enc_external_mail_key = external_mail_group
				.adminGroupEncGKey
				.clone()
				.ok_or_else(|| {
					ApiCallError::internal(
						"send_mail_standard: missing adminGroupEncGKey on external mail group"
							.into(),
					)
				})?;

			let required_internal_user_group_key = key_loader
				.load_sym_group_key(
					&user_group_id,
					required_internal_user_group_key_version,
					None,
				)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: load internal user group key failed: {e}"
					))
				})?;
			let current_external_user_group_key = required_internal_user_group_key
				.decrypt_aes_key(&internal_user_enc_external_user_key)
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: decrypt external user group key failed: {e}"
					))
				})?;
			let current_external_user_group_key_version =
				external_user_group.groupKeyVersion.max(0) as u64;

			let required_external_user_group_key = key_loader
				.load_sym_group_key(
					&external_ref.userGroup,
					required_external_user_group_key_version,
					Some(VersionedAesKey::new(
						current_external_user_group_key.clone(),
						current_external_user_group_key_version,
					)),
				)
				.await
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: load external user group key failed: {e}"
					))
				})?;
			let current_external_mail_group_key = required_external_user_group_key
				.decrypt_aes_key(&external_user_enc_external_mail_key)
				.map_err(|e| {
					ApiCallError::internal(format!(
						"send_mail_standard: decrypt external mail group key failed: {e}"
					))
				})?;
			let current_external_mail_group_key_version =
				external_mail_group.groupKeyVersion.max(0) as i64;

			let owner_enc_bucket_key =
				current_external_mail_group_key.encrypt_key(bucket_key, Iv::generate(&randomizer));
			let pw_enc_communication_key = password_key_generic
				.encrypt_key(&current_external_user_group_key, Iv::generate(&randomizer));

			out.push(SecureExternalRecipientKeyData {
				_id: Some(Self::random_aggregate_custom_id()),
				mailAddress: cleaned,
				passwordVerifier: password_verifier,
				salt: Some(salt.to_vec()),
				saltHash: Some(crate::crypto::sha256(&salt).to_vec()),
				pwEncCommunicationKey: Some(pw_enc_communication_key),
				ownerEncBucketKey: owner_enc_bucket_key,
				kdfVersion: 1,
				ownerKeyVersion: current_external_mail_group_key_version,
				userGroupKeyVersion: current_external_user_group_key_version as i64,
			});
		}

		Ok(out)
	}

	pub async fn send_mail_standard(
		&self,
		input: SendMailInput,
	) -> Result<SendDraftReturn, ApiCallError> {
		if input.to.is_empty() {
			return Err(ApiCallError::internal(
				"send_mail_standard: at least one to recipient is required".into(),
			));
		}
		if input.subject.trim().is_empty() {
			return Err(ApiCallError::internal(
				"send_mail_standard: subject is required".into(),
			));
		}
		if input.body.trim().is_empty() {
			return Err(ApiCallError::internal(
				"send_mail_standard: bodyText/bodyHtml is required".into(),
			));
		}

		let mail_facade = self.mail_facade();
		let sender_group_id = mail_facade
			.get_group_id_for_mail_address(&input.sender.address)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!(
					"send_mail_standard: sender address {} is not enabled for this user: {e}",
					input.sender.address
				))
			})?;
		let sender_group_key = self.get_current_sym_group_key(&sender_group_id).await?;

		let randomizer = RandomizerFacade::from_core(rand_core::OsRng);
		let draft_sk = GenericAesKey::from(Aes256Key::generate(&randomizer));
		let owner_enc_session_key = sender_group_key
			.object
			.encrypt_key(&draft_sk, Iv::generate(&randomizer));
		let confidential_send = input
			.external_password
			.as_ref()
			.map(|s| !s.trim().is_empty())
			.unwrap_or(false);

		const CONVERSATION_TYPE_NEW: i64 = 0;
		const MAIL_METHOD_NONE: i64 = 0;
		let draft_create = DraftCreateData {
			_format: 0,
			previousMessageId: None,
			conversationType: CONVERSATION_TYPE_NEW,
			ownerEncSessionKey: owner_enc_session_key,
			ownerKeyVersion: sender_group_key.version as i64,
			draftData: DraftData {
				_id: Some(Self::random_aggregate_custom_id()),
				subject: input.subject,
				bodyText: String::new(),
				senderMailAddress: input.sender.address,
				senderName: input.sender.name.unwrap_or_default(),
				confidential: confidential_send,
				method: MAIL_METHOD_NONE,
				compressedBodyText: Some(input.body),
				toRecipients: input.to.iter().map(Self::map_draft_recipient).collect(),
				ccRecipients: input.cc.iter().map(Self::map_draft_recipient).collect(),
				bccRecipients: input.bcc.iter().map(Self::map_draft_recipient).collect(),
				addedAttachments: vec![],
				removedAttachments: vec![],
				replyTos: input.reply_to.iter().map(Self::map_reply_to).collect(),
				_errors: Default::default(),
			},
			_errors: Default::default(),
		};
		let created: DraftCreateReturn = self
			.service_executor
			.post::<DraftService>(
				draft_create,
				ExtraServiceParams {
					session_key: Some(draft_sk.clone()),
					..Default::default()
				},
			)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!("send_mail_standard: DraftService failed: {e}"))
			})?;

		let lang = if input.language.trim().is_empty() {
			"en".to_string()
		} else {
			input.language
		};
		let created_draft: Mail = self
			.crypto_entity_client
			.load(&created.draft)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!(
					"send_mail_standard: load created draft failed: {e}"
				))
			})?;
		let draft_tm = self
			.type_model_provider
			.resolve_client_type_ref(&Mail::type_ref())
			.ok_or_else(|| {
				ApiCallError::internal("send_mail_standard: missing type model for Mail".into())
			})?;
		let draft_parsed = self
			.crypto_entity_client
			.typed_instance_to_parsed(created_draft.clone())?;
		let draft_resolved = self
			.crypto_entity_client
			.get_crypto_facade()
			.resolve_session_key(&draft_parsed, draft_tm)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!(
					"send_mail_standard: resolve draft session key failed: {e}"
				))
			})?
			.ok_or_else(|| {
				ApiCallError::internal(
					"send_mail_standard: no session key for created draft".into(),
				)
			})?;
		let draft_session_key = draft_resolved.session_key.as_bytes().to_vec();

		let draft_id_for_send = created_draft._id.clone().ok_or_else(|| {
			ApiCallError::internal("send_mail_standard: created draft missing _id".into())
		})?;
		let draft_id_debug = draft_id_for_send.to_string();
		let account_plaintext_only = match self
			.crypto_entity_client
			.load::<TutanotaProperties, _>(&self.get_user_group_id())
			.await
		{
			Ok(p) => p.sendPlaintextOnly,
			Err(_) => false,
		};
		let bucket_key = if created_draft.confidential {
			Some(GenericAesKey::from(Aes256Key::generate(&randomizer)))
		} else {
			None
		};
		let bucket_enc_mail_session_key = if let Some(ref bk) = bucket_key {
			Some(
				draft_resolved
					.session_key
					.encrypt_key(bk, Iv::generate(&randomizer)),
			)
		} else {
			None
		};
		let internal_recipient_key_data = if let Some(ref bk) = bucket_key {
			let all_recipients: Vec<SendMailAddressInput> = input
				.to
				.iter()
				.chain(input.cc.iter())
				.chain(input.bcc.iter())
				.cloned()
				.collect();
			self.build_internal_recipient_key_data(bk, &self.get_user_group_id(), &all_recipients)
				.await?
		} else {
			Vec::new()
		};
		let secure_external_recipient_key_data: Vec<SecureExternalRecipientKeyData> =
			if let (Some(ref bk), Some(pass)) = (
				bucket_key.as_ref(),
				input
					.external_password
					.as_deref()
					.filter(|s| !s.trim().is_empty()),
			) {
				let all_recipients: Vec<SendMailAddressInput> = input
					.to
					.iter()
					.chain(input.cc.iter())
					.chain(input.bcc.iter())
					.cloned()
					.collect();
				self.build_secure_external_recipient_key_data(bk, pass, &all_recipients)
					.await?
			} else {
				Vec::new()
			};
		// TS `MailFacade.sendDraft`: only expose sender display name when notifying password-protected externals.
		let sender_name_unencrypted = if secure_external_recipient_key_data.is_empty() {
			None
		} else if created_draft.sender.name.trim().is_empty() {
			None
		} else {
			Some(created_draft.sender.name.clone())
		};
		let send_parameters_base = SendDraftParameters {
			_id: Some(Self::random_aggregate_custom_id()),
			language: lang.clone(),
			mailSessionKey: if created_draft.confidential {
				None
			} else {
				Some(draft_session_key.clone())
			},
			bucketEncMailSessionKey: bucket_enc_mail_session_key.clone(),
			senderNameUnencrypted: sender_name_unencrypted.clone(),
			plaintext: account_plaintext_only,
			calendarMethod: false,
			sessionEncEncryptionAuthStatus: None,
			mail: draft_id_for_send.clone(),
			internalRecipientKeyData: internal_recipient_key_data.clone(),
			secureExternalRecipientKeyData: secure_external_recipient_key_data.clone(),
			symEncInternalRecipientKeyData: vec![],
			attachmentKeyData: vec![],
		};
		let send_data = SendDraftData {
			_format: 0,
			language: lang.clone(),
			mailSessionKey: if created_draft.confidential {
				None
			} else {
				Some(draft_session_key.clone())
			},
			bucketEncMailSessionKey: bucket_enc_mail_session_key,
			senderNameUnencrypted: sender_name_unencrypted.clone(),
			plaintext: account_plaintext_only,
			calendarMethod: false,
			sessionEncEncryptionAuthStatus: None,
			sendAt: None,
			allowUndo: false,
			internalRecipientKeyData: internal_recipient_key_data.clone(),
			secureExternalRecipientKeyData: secure_external_recipient_key_data.clone(),
			attachmentKeyData: vec![],
			mail: draft_id_for_send.clone(),
			symEncInternalRecipientKeyData: vec![],
			parameters: Some(send_parameters_base),
		};
		let send_payload_debug = format!(
			"send.mailSessionKey.bytes={} nested.mailSessionKey.bytes={} send.json={}",
			send_data
				.mailSessionKey
				.as_ref()
				.map(|k| k.len())
				.unwrap_or(0),
			send_data
				.parameters
				.as_ref()
				.and_then(|p| p.mailSessionKey.as_ref())
				.map(|k| k.len())
				.unwrap_or(0),
			serde_json::to_string(&send_data)
				.unwrap_or_else(|_| "<send_data_json_error>".to_string()),
		);
		self
			.service_executor
			.post::<SendDraftService>(send_data, ExtraServiceParams::default())
			.await
			.map_err(|e| ApiCallError::internal(format!(
				"send_mail_standard: SendDraftService failed; draftId={} draft.confidential={} recipientCount={} firstRecipient={} sender={} subject={} | {}; err={}",
				draft_id_debug,
				created_draft.confidential,
				created_draft.recipientCount,
				created_draft.firstRecipient.as_ref().map(|r| r.address.clone()).unwrap_or_default(),
				created_draft.sender.address,
				created_draft.subject,
				send_payload_debug,
				e,
			)))
	}

	#[must_use]
	pub fn get_service_executor(&self) -> &Arc<ResolvingServiceExecutor> {
		&self.service_executor
	}

	pub fn encrypt_and_map(
		&self,
		type_model: &TypeModel,
		instance: &ParsedEntity,
		sk: &GenericAesKey,
	) -> Result<ParsedEntity, ApiCallError> {
		self.entity_facade.encrypt_and_map(type_model, instance, sk)
	}

	#[must_use]
	pub fn get_entity_client(&self) -> Arc<EntityClient> {
		self.entity_client.clone()
	}

	pub async fn get_current_sym_group_key(
		&self,
		group_id: &GeneratedId,
	) -> Result<VersionedAesKey, ApiCallError> {
		self.crypto_entity_client
			.get_crypto_facade()
			.get_key_loader_facade()
			.as_ref()
			.get_current_sym_group_key(group_id)
			.await
			.map_err(|err| ApiCallError::internal(format!("KeyLoadError: {err:?}")))
	}

	#[must_use]
	pub fn get_user_group_id(&self) -> GeneratedId {
		self.user_facade.get_user_group_id()
	}

	#[must_use]
	pub fn get_user_id(&self) -> Option<GeneratedId> {
		self.user_facade.get_user()._id.clone()
	}

	#[must_use]
	pub fn get_user(&self) -> Arc<User> {
		Arc::clone(&self.user_facade.get_user())
	}

	pub async fn request_blob_facade_write_token(
		&self,
		archive_data_type: ArchiveDataType,
	) -> Result<BlobServerAccessInfo, ApiCallError> {
		let mail_group_id = self
			.user_facade
			.get_membership_by_group_type(GroupType::Mail)?
			.group;
		self.blob_facade
			.blob_access_token_facade
			.request_write_token(archive_data_type, &mail_group_id)
			.await
	}

	pub fn serialize_instance_to_json<Instance>(
		&self,
		instance: Instance,
		key: GenericAesKey,
	) -> Result<String, ApiCallError>
	where
		Instance: Entity + Serialize,
	{
		let parsed_entity = self
			.crypto_entity_client
			.serialize_entity(instance, Some(key))?;
		let raw_entity = self
			.json_serializer
			.serialize(&Instance::type_ref(), parsed_entity)?;
		serde_json::to_string(&raw_entity).map_err(|_e| {
			ApiCallError::internal(format!(
				"failed to stringify raw entity {}",
				Instance::type_ref()
			))
		})
	}

	/// Download and decrypt all blob chunks for a [`TutanotaFile`] (e.g. mail attachment).
	pub async fn download_tutanota_file_attachment(
		&self,
		file: &TutanotaFile,
	) -> Result<Vec<u8>, ApiCallError> {
		let type_model = self
			.type_model_provider
			.resolve_client_type_ref(&TutanotaFile::type_ref())
			.ok_or_else(|| ApiCallError::internal("missing type model for TutanotaFile".into()))?;
		let parsed = self
			.crypto_entity_client
			.typed_instance_to_parsed(file.clone())?;
		let resolved = self
			.crypto_entity_client
			.get_crypto_facade()
			.resolve_session_key(&parsed, &type_model)
			.await
			.map_err(|e| ApiCallError::internal(e.to_string()))?
			.ok_or_else(|| {
				ApiCallError::internal("could not resolve session key for file".into())
			})?;
		self.blob_facade
			.download_and_decrypt_file_attachment(
				ArchiveDataType::Attachments,
				file,
				&resolved.session_key,
			)
			.await
	}

	/// Download a mail attachment when the file may only be keyed via the parent mail's `bucketKey`.
	pub async fn download_tutanota_file_attachment_for_mail(
		&self,
		mail: &Mail,
		file: &TutanotaFile,
	) -> Result<Vec<u8>, ApiCallError> {
		let resolved = self
			.crypto_entity_client
			.resolve_session_key_for_tutanota_file_with_mail(mail, file)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!(
					"download_tutanota_file_attachment_for_mail(resolve key): {e}"
				))
			})?;
		self.blob_facade
			.download_and_decrypt_file_attachment(
				ArchiveDataType::Attachments,
				file,
				&resolved.session_key,
			)
			.await
			.map_err(|e| {
				ApiCallError::internal(format!(
					"download_tutanota_file_attachment_for_mail(blob decrypt): {e}"
				))
			})
	}

	/// Decrypted mail body / headers (`MailDetails`), using the same blob read path as TS [`MailFacade.loadMailDetailsBlob`].
	pub async fn load_mail_details_for_mail(
		&self,
		mail: &Mail,
	) -> Result<MailDetails, ApiCallError> {
		if mail.mailDetailsDraft.is_some() {
			return Err(ApiCallError::internal(
				"load_mail_details_for_mail: draft mail uses mailDetailsDraft (not implemented)"
					.into(),
			));
		}
		let details_id = mail
			.mailDetails
			.as_ref()
			.ok_or_else(|| ApiCallError::internal("mail has no mailDetails".into()))?;
		let mut parsed = self
			.blob_facade
			.fetch_blob_element_parsed_entities(
				&MailDetailsBlob::type_ref(),
				&details_id.list_id,
				&[details_id.element_id.clone()],
			)
			.await?;
		let blob_parsed = parsed
			.pop()
			.ok_or_else(|| ApiCallError::internal("MailDetailsBlob response was empty".into()))?;
		let blob = self
			.crypto_entity_client
			.decrypt_mail_details_blob_using_mail_owner_fallback(mail, blob_parsed)
			.await?;
		Ok(blob.details)
	}
}

#[uniffi::export]
impl LoggedInSdk {
	/// Generates a new interface to operate on mail entities
	#[must_use]
	pub fn mail_facade(&self) -> MailFacade {
		MailFacade::new(
			self.crypto_entity_client.clone(),
			self.user_facade.clone(),
			self.service_executor.clone(),
		)
	}

	#[must_use]
	pub fn calendar_facade(&self) -> CalendarFacade {
		CalendarFacade::new(
			self.crypto_entity_client.clone(),
			self.user_facade.clone(),
			self.contact_facade.clone(),
			self.customer_facade.clone(),
			self.event_facade(),
		)
	}

	#[must_use]
	fn event_facade(&self) -> Arc<EventFacade> {
		Arc::new(EventFacade::new())
	}

	#[must_use]
	pub fn blob_facade(&self) -> Arc<BlobFacade> {
		self.blob_facade.clone()
	}
}

#[derive(uniffi::Enum, Debug, PartialEq, Clone)]
pub enum ListLoadDirection {
	ASC,
	/// Reverse order
	DESC,
}

/// Contains an error from the SDK to be handled by the consuming code over the FFI
#[derive(Error, Debug, uniffi::Error, Eq, PartialEq, Clone)]
pub enum ApiCallError {
	#[error("Rest client error, source: {source}")]
	RestClient {
		#[from]
		source: RestClientError,
	},
	#[error("ServerResponseError: {source}")]
	ServerResponseError {
		#[from]
		source: HttpError,
	},
	/// Preconditions for password-protected mail to external addresses are not met (maps to a documented REST error in the mail API).
	#[error("ExternalSecureSendUnavailable: {message}")]
	ExternalSecureSendUnavailable { message: String },
	#[error("InternalSdkError: {error_message}")]
	InternalSdkError { error_message: String },
}

impl ApiCallError {
	#[must_use]
	pub fn internal(message: String) -> ApiCallError {
		ApiCallError::InternalSdkError {
			error_message: message,
		}
	}
	#[must_use]
	pub fn external_secure_send_unavailable(message: impl Into<String>) -> ApiCallError {
		ApiCallError::ExternalSecureSendUnavailable {
			message: message.into(),
		}
	}
	pub fn internal_with_err<E: Error>(error: E, message: &str) -> ApiCallError {
		ApiCallError::InternalSdkError {
			error_message: format!("{}: {}", error, message),
		}
	}
}

impl From<InstanceMapperError> for ApiCallError {
	fn from(value: InstanceMapperError) -> Self {
		ApiCallError::InternalSdkError {
			error_message: value.to_string(),
		}
	}
}

impl From<ParseFailureError> for ApiCallError {
	fn from(_value: ParseFailureError) -> Self {
		ApiCallError::InternalSdkError {
			error_message: "Parse error".to_owned(),
		}
	}
}

impl<C> Encode<C> for ElementValue {
	fn encode<W: Write>(
		&self,
		e: &mut Encoder<W>,
		_: &mut C,
	) -> Result<(), minicbor::encode::Error<W::Error>> {
		match self {
			ElementValue::Null => e.null()?,
			ElementValue::String(s) => e.str(s)?,
			// JS-specific: some numbers might be big, so we encode them as strings
			ElementValue::Number(n) => e.str(n.to_string().as_str())?,
			ElementValue::Bytes(b) => e.bytes(b)?,
			// See OfflineStorage dateEncoder for this tag
			ElementValue::Date(d) => e.tag(minicbor::data::Tag::new(100))?.u64(d.as_millis())?,
			ElementValue::Bool(b) => e.bool(*b)?,
			ElementValue::IdGeneratedId(s) => e.str(s.as_str())?,
			ElementValue::IdCustomId(s) => e.str(s.as_str())?,
			ElementValue::IdTupleGeneratedElementId(id) => e
				.array(2)?
				.str(id.list_id.as_str())?
				.str(id.element_id.as_str())?,
			ElementValue::IdTupleCustomElementId(id) => e
				.array(2)?
				.str(id.list_id.as_str())?
				.str(id.element_id.as_str())?,
			ElementValue::Dict(d) => {
				e.map(d.len() as u64)?;
				for (k, v) in d {
					e.str(k)?;
					e.encode(v)?;
				}
				e
			},
			ElementValue::Array(a) => {
				e.array(a.len() as u64)?;
				for v in a {
					e.encode(v)?;
				}
				e
			},
		};
		Ok(())
	}

	fn is_nil(&self) -> bool {
		matches!(self, ElementValue::Null)
	}
}
#[cfg(test)]
mod tests {
	use super::Arc;
	use crate::bindings::file_client::MockFileClient;
	use crate::bindings::rest_client::MockRestClient;
	use crate::entities::generated::tutanota::Mail;
	use crate::util::test_utils::create_test_entity_dict;
	use crate::Sdk;

	#[test]
	fn test_serialize_mail_does_not_panic() {
		let sdk = Sdk::new(
			"localhost:9000".to_string(),
			Arc::new(MockRestClient::default()),
			Arc::new(MockFileClient::default()),
		);

		let parsed_mail = create_test_entity_dict::<Mail>();
		let _ = sdk.serialize_mail(parsed_mail);
	}
}
