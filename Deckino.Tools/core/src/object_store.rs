use std::future::Future;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use aws_credential_types::Credentials;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Region, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::primitives::ByteStream;
use futures::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::credentials::{DatasetSyncCredentials, DpapiSyncCredentialStore};
use crate::error::Cancelled;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteDatasetObject {
    pub key: String,
    pub sha256: Option<String>,
    pub etag: Option<String>,
    pub size: i64,
}

/// The object metadata every upload carries: the file's SHA-256 (x-amz-meta-deckino-sha256).
const SHA_METADATA: &str = "deckino-sha256";
const MAXIMUM_PARALLEL_METADATA_REQUESTS: usize = 8;

/// The Railway bucket (S3-compatible).
#[derive(Clone)]
pub struct RailwayS3ObjectStore {
    client: Client,
    bucket: String,
}

impl RailwayS3ObjectStore {
    /// The bucket connection saved on Dataset Sync.
    pub fn connect(store: &DpapiSyncCredentialStore) -> Result<Self> {
        Self::new(&store.load().ok_or_else(|| anyhow!("Connect the Railway bucket first (Dataset Sync)."))?)
    }

    pub fn new(credentials: &DatasetSyncCredentials) -> Result<Self> {
        if !credentials.is_complete() {
            bail!("The dataset sync credentials are incomplete.");
        }
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(credentials.endpoint.trim_end_matches('/'))
            .region(Region::new(credentials.region.trim().to_string()))
            .credentials_provider(Credentials::new(
                credentials.access_key_id.trim(),
                credentials.secret_access_key.clone(),
                None,
                None,
                "deckino",
            ))
            .force_path_style(credentials.force_path_style)
            // S3-compatible stores don't all take the newer default checksums.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        Ok(Self { client: Client::from_conf(config), bucket: credentials.bucket.trim().to_string() })
    }

    pub async fn probe(&self, prefix: &str) -> Result<()> {
        self.client.list_objects_v2().bucket(&self.bucket).prefix(prefix).max_keys(1).send().await?;
        Ok(())
    }

    /// Every object under `prefix`, sorted by key. `known_sha256(key, etag, size)` returns a cached hash for an
    /// unchanged object, which then needs no metadata request. `report(done, total)` follows the metadata requests.
    pub async fn list(
        &self,
        prefix: &str,
        known_sha256: Option<&(dyn Fn(&str, Option<&str>, i64) -> Option<String> + Sync)>,
        report: Option<&(dyn Fn(usize, usize) + Sync)>,
        cancel: &CancellationToken,
    ) -> Result<Vec<RemoteDatasetObject>> {
        let mut objects = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let page = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix)
                .set_continuation_token(continuation.take())
                .send();
            let response = cancellable(cancel, page).await??;
            for item in response.contents() {
                if let Some(key) = item.key().filter(|key| !key.trim().is_empty()) {
                    let etag = item.e_tag().map(|tag| tag.trim_matches('"').to_string());
                    objects.push((key.to_string(), etag, item.size().unwrap_or(0)));
                }
            }
            continuation = if response.is_truncated() == Some(true) {
                response.next_continuation_token().map(str::to_string)
            } else {
                None
            };
            if continuation.is_none() {
                break;
            }
        }
        let total = objects.len();
        if total == 0 {
            if let Some(report) = report {
                report(0, 0);
            }
            return Ok(Vec::new());
        }

        let mut result = Vec::with_capacity(total);
        let mut unknown = Vec::new();
        for (key, etag, size) in objects {
            match known_sha256.and_then(|known| known(&key, etag.as_deref(), size)) {
                Some(sha) => result.push(RemoteDatasetObject { key, sha256: Some(sha), etag, size }),
                None => unknown.push((key, etag, size)),
            }
        }
        let mut completed = total - unknown.len();
        if let Some(report) = report {
            report(completed, total);
        }
        let mut heads = futures::stream::iter(unknown.into_iter().map(|(key, etag, size)| async move {
            let head = match self.client.head_object().bucket(&self.bucket).key(&key).send().await {
                Ok(head) => head,
                // Deleted (another PC's sync) between the listing and this request: it is gone, not a failure.
                Err(error) if error.as_service_error().is_some_and(|error| error.is_not_found()) => {
                    return anyhow::Ok(None);
                }
                Err(error) => return Err(error.into()),
            };
            let sha = head.metadata().and_then(|metadata| {
                metadata.get(SHA_METADATA).or_else(|| metadata.get("x-amz-meta-deckino-sha256")).cloned()
            });
            anyhow::Ok(Some(RemoteDatasetObject { key, sha256: sha, etag, size }))
        }))
        .buffer_unordered(MAXIMUM_PARALLEL_METADATA_REQUESTS);
        while let Some(item) = cancellable(cancel, heads.next()).await? {
            result.extend(item?);
            completed += 1;
            if let Some(report) = report {
                report(completed, total);
            }
        }
        result.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(result)
    }

    pub async fn download(&self, key: &str, destination: &Path, cancel: &CancellationToken) -> Result<()> {
        self.download_with_progress(key, destination, &|_| {}, cancel).await
    }

    /// `report_percent` gets 0–100 while the object downloads.
    pub async fn download_with_progress(
        &self,
        key: &str,
        destination: &Path,
        report_percent: &(dyn Fn(i32) + Sync),
        cancel: &CancellationToken,
    ) -> Result<()> {
        let response = cancellable(cancel, self.client.get_object().bucket(&self.bucket).key(key).send())
            .await?
            .with_context(|| format!("Downloading {key} failed"))?;
        let length = response.content_length().unwrap_or(0).max(0) as u64;
        let mut body = response.body;
        let mut file = tokio::fs::File::create(destination).await?;
        let (mut written, mut last_percent) = (0u64, -1);
        while let Some(chunk) = cancellable(cancel, body.next()).await? {
            // An IOException in the C# Toolbox: one file fails, the sync goes on.
            let chunk = chunk.map_err(std::io::Error::other)?;
            file.write_all(&chunk).await?;
            written += chunk.len() as u64;
            if length > 0 {
                let percent = (written * 100 / length) as i32;
                if percent != last_percent {
                    last_percent = percent;
                    report_percent(percent);
                }
            }
        }
        file.flush().await?;
        report_percent(100);
        Ok(())
    }

    pub async fn upload(&self, key: &str, source: &Path, sha256: &str, cancel: &CancellationToken) -> Result<()> {
        self.upload_with_progress(key, source, sha256, &|_| {}, cancel).await
    }

    /// `report_bytes` gets the file's size once it is sent.
    // ponytail: progress only at the end; a counting body when big uploads need a live bar.
    pub async fn upload_with_progress(
        &self,
        key: &str,
        source: &Path,
        sha256: &str,
        report_bytes: &(dyn Fn(i64) + Sync),
        cancel: &CancellationToken,
    ) -> Result<()> {
        let body = ByteStream::from_path(source).await?;
        let put =
            self.client.put_object().bucket(&self.bucket).key(key).metadata(SHA_METADATA, sha256).body(body).send();
        cancellable(cancel, put).await?.with_context(|| format!("Uploading {key} failed"))?;
        report_bytes(std::fs::metadata(source).map(|m| m.len() as i64).unwrap_or(0));
        Ok(())
    }

    pub async fn upload_bytes(
        &self,
        key: &str,
        content: Vec<u8>,
        sha256: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let put = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type("application/json")
            .metadata(SHA_METADATA, sha256)
            .body(ByteStream::from(content))
            .send();
        cancellable(cancel, put).await?.with_context(|| format!("Uploading {key} failed"))?;
        Ok(())
    }

    pub async fn delete(&self, key: &str, cancel: &CancellationToken) -> Result<()> {
        cancellable(cancel, self.client.delete_object().bucket(&self.bucket).key(key).send()).await??;
        Ok(())
    }
}

/// A download whose object was deleted (another PC's sync) after the listing that named it.
pub fn is_not_found(error: &anyhow::Error) -> bool {
    error.downcast_ref::<SdkError<GetObjectError>>().is_some_and(|error| {
        error.as_service_error().is_some_and(GetObjectError::is_no_such_key)
            || error.raw_response().is_some_and(|response| response.status().as_u16() == 404)
    })
}

/// A bucket call that stops when `cancel` fires (the SDK's calls take no token).
async fn cancellable<T>(cancel: &CancellationToken, call: impl Future<Output = T>) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Cancelled.into()),
        result = call => Ok(result),
    }
}
