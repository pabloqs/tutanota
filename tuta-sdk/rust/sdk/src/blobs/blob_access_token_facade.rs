use crate::blobs::blob_access_token_cache::{BlobAccessTokenCache, BlobWriteTokenKey};
use crate::date::DateProvider;
use crate::entities::generated::storage::{
	BlobAccessTokenPostIn, BlobReadData, BlobServerAccessInfo, BlobWriteData, InstanceId,
};
use crate::services::generated::storage::BlobAccessTokenService;
#[cfg_attr(test, mockall_double::double)]
use crate::services::service_executor::ResolvingServiceExecutor;
use crate::services::ExtraServiceParams;
use crate::tutanota_constants::ArchiveDataType;
use crate::ApiCallError;
use crate::CustomId;
use crate::GeneratedId;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use base64::Engine;
use crypto_primitives::randomizer_facade::RandomizerFacade;
use std::sync::Arc;

/// The BlobAccessTokenFacade requests blobAccessTokens from the BlobAccessTokenService to get
/// or post to the BlobService (binary blobs) or DefaultBlobElementResource (instances).
/// All tokens are cached.
pub(crate) struct BlobAccessTokenFacade {
	cache: BlobAccessTokenCache,
	randomizer_facade: RandomizerFacade,
	service_executor: Arc<ResolvingServiceExecutor>,
}

fn random_aggregate_custom_id(rf: &RandomizerFacade) -> CustomId {
	CustomId(BASE64_URL_SAFE_NO_PAD.encode(rf.generate_random_array::<4>()))
}

#[cfg_attr(test, mockall::automock)]
impl BlobAccessTokenFacade {
	pub fn new(
		randomizer_facade: RandomizerFacade,
		service_executor: Arc<ResolvingServiceExecutor>,
		date_provider: Arc<dyn DateProvider>,
	) -> Self {
		Self {
			cache: BlobAccessTokenCache::new(date_provider),
			randomizer_facade,
			service_executor,
		}
	}

	/// Requests a token that allows uploading blobs for the given ArchiveDataType and ownerGroup.
	pub async fn request_write_token(
		&self,
		archive_data_type: ArchiveDataType,
		owner_group_id: &GeneratedId,
	) -> Result<BlobServerAccessInfo, ApiCallError> {
		let archive_data_type_discriminant = archive_data_type.discriminant();
		let owner_group_id_clone = owner_group_id.clone();
		let loader = move || async move {
			let post_in: BlobAccessTokenPostIn = BlobAccessTokenPostIn {
				_format: 0,
				archiveDataType: Some(archive_data_type_discriminant),
				read: None,
				write: Some(BlobWriteData {
					_id: Some(CustomId(
						BASE64_URL_SAFE_NO_PAD
							.encode(self.randomizer_facade.generate_random_array::<4>()),
					)),
					archiveOwnerGroup: owner_group_id_clone,
				}),
			};
			self.service_executor
				.post::<BlobAccessTokenService>(post_in, ExtraServiceParams::default())
				.await
				.map(|r| r.blobAccessInfo)
		};

		self.cache
			.try_get_token(
				&BlobWriteTokenKey::new(owner_group_id, archive_data_type),
				loader,
			)
			.await
	}

	/// Read token for blobs referenced by a single file instance (see TS `requestReadTokenBlobs`).
	pub async fn request_read_token_for_file_instance(
		&self,
		archive_data_type: ArchiveDataType,
		archive_id: &GeneratedId,
		instance_list_id: &GeneratedId,
		instance_element_id: &GeneratedId,
	) -> Result<BlobServerAccessInfo, ApiCallError> {
		let post_in = BlobAccessTokenPostIn {
			_format: 0,
			archiveDataType: Some(archive_data_type.discriminant()),
			read: Some(BlobReadData {
				_id: Some(random_aggregate_custom_id(&self.randomizer_facade)),
				archiveId: archive_id.clone(),
				instanceListId: Some(instance_list_id.clone()),
				instanceIds: vec![InstanceId {
					_id: Some(random_aggregate_custom_id(&self.randomizer_facade)),
					instanceId: Some(instance_element_id.clone()),
				}],
			}),
			write: None,
		};
		let out = self
			.service_executor
			.post::<BlobAccessTokenService>(post_in, ExtraServiceParams::default())
			.await?;
		Ok(out.blobAccessInfo)
	}

	/// Read token for all instances in an archive (see TS `requestReadTokenArchive`).
	pub async fn request_read_token_archive(
		&self,
		archive_id: &GeneratedId,
	) -> Result<BlobServerAccessInfo, ApiCallError> {
		let post_in = BlobAccessTokenPostIn {
			_format: 0,
			archiveDataType: None,
			read: Some(BlobReadData {
				_id: Some(random_aggregate_custom_id(&self.randomizer_facade)),
				archiveId: archive_id.clone(),
				instanceListId: None,
				instanceIds: vec![],
			}),
			write: None,
		};
		let out = self
			.service_executor
			.post::<BlobAccessTokenService>(post_in, ExtraServiceParams::default())
			.await?;
		Ok(out.blobAccessInfo)
	}

	/// Remove a given write token from the cache.
	#[allow(unused)]
	pub fn evict_access_token(&self, key: &BlobWriteTokenKey) {
		self.cache.evict(key);
	}
}
#[cfg(test)]
mod tests {
	use super::*;
	use crate::date::date_provider::stub::DateProviderStub;
	use crate::date::DateTime;
	use crate::entities::generated::storage::{BlobAccessTokenPostOut, BlobServerAccessInfo};
	use crate::services::service_executor::MockResolvingServiceExecutor;
	use crate::tutanota_constants::ArchiveDataType;
	use crate::util::test_utils::create_test_entity;
	use crate::CustomId;
	use crate::GeneratedId;
	use crypto_primitives::randomizer_facade::RandomizerFacade;
	use std::sync::Arc;

	#[tokio::test]
	async fn request_write_token_with_uncached_and_cached() {
		let owner_group_id = GeneratedId(String::from("hallo"));
		let expected_access_info = BlobServerAccessInfo {
			_id: Some(CustomId(String::from("123"))),
			expires: DateTime::from_millis(1_000),
			..create_test_entity()
		};

		let mut executor = MockResolvingServiceExecutor::default();
		executor
			.expect_post::<BlobAccessTokenService>()
			.times(1)
			.return_const(Ok(BlobAccessTokenPostOut {
				blobAccessInfo: expected_access_info.clone(),
				..create_test_entity()
			}));
		let facade = BlobAccessTokenFacade::new(
			RandomizerFacade::from_core(rand_core::OsRng),
			Arc::new(executor),
			Arc::new(DateProviderStub::new(10)),
		);
		let actual_access_info = facade
			.request_write_token(ArchiveDataType::Attachments, &owner_group_id)
			.await
			.expect("failed to request token");

		assert_eq!(expected_access_info, actual_access_info);

		let cached_access_info = facade
			.request_write_token(ArchiveDataType::Attachments, &owner_group_id)
			.await
			.expect("failed to request token");
		assert_eq!(expected_access_info, cached_access_info);
	}
}
