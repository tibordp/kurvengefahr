//! Thin prefix-aware wrapper over `dyn ObjectStore`. Production builds an S3-compatible store
//! (path-style by default — MinIO/Hetzner/R2); tests inject `object_store::memory::InMemory`.
//! NotFound is data (`Ok(None)`), not an error; everything else surfaces as `storage_error`.

use crate::config::S3Config;
use crate::id::BlobId;
use bytes::Bytes;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use std::sync::Arc;
use std::time::Instant;

pub struct BlobStore {
    store: Arc<dyn ObjectStore>,
    prefix: String,
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct StoreError(#[from] object_store::Error);

impl BlobStore {
    pub fn new(store: Arc<dyn ObjectStore>, prefix: &str) -> Self {
        BlobStore {
            store,
            prefix: prefix.to_string(),
        }
    }

    pub fn object_path(&self, id: &BlobId) -> ObjPath {
        ObjPath::from(format!("{}{}", self.prefix, id))
    }

    /// Size in bytes if the blob exists.
    pub async fn exists(&self, id: &BlobId) -> Result<Option<u64>, StoreError> {
        let start = Instant::now();
        let res = self.store.head(&self.object_path(id)).await;
        record("head", start, &res);
        match res {
            Ok(meta) => Ok(Some(meta.size)),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn get(&self, id: &BlobId) -> Result<Option<Bytes>, StoreError> {
        let start = Instant::now();
        let res = match self.store.get(&self.object_path(id)).await {
            Ok(r) => r.bytes().await.map(Some),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e),
        };
        record("get", start, &res);
        res.map_err(StoreError::from)
    }

    pub async fn put(&self, id: &BlobId, body: Bytes) -> Result<(), StoreError> {
        let start = Instant::now();
        let res = self
            .store
            .put(&self.object_path(id), PutPayload::from(body))
            .await;
        record("put", start, &res);
        res.map(|_| ()).map_err(StoreError::from)
    }
}

fn record<T>(op: &'static str, start: Instant, res: &Result<T, object_store::Error>) {
    metrics::histogram!("kg_share_store_op_duration_seconds", "op" => op)
        .record(start.elapsed().as_secs_f64());
    if let Err(e) = res
        && !matches!(e, object_store::Error::NotFound { .. })
    {
        metrics::counter!("kg_share_store_errors_total", "op" => op).increment(1);
    }
}

/// The production store from config. Real AWS S3 needs only region + bucket (the SDK derives
/// the endpoint); a custom endpoint is for S3-compatibles, path-style by default (what they
/// expect — with `virtual_hosted` the endpoint must be the bucket-qualified URL), and
/// `allow_http` is for local development only.
pub fn s3_store(cfg: &S3Config) -> Result<Arc<dyn ObjectStore>, object_store::Error> {
    let mut builder = AmazonS3Builder::new()
        .with_bucket_name(&cfg.bucket)
        .with_region(&cfg.region)
        .with_access_key_id(&cfg.access_key_id)
        .with_secret_access_key(&cfg.secret_access_key);
    if let Some(endpoint) = &cfg.endpoint {
        builder = builder
            .with_endpoint(endpoint)
            .with_allow_http(cfg.allow_http)
            .with_virtual_hosted_style_request(cfg.virtual_hosted);
    }
    Ok(Arc::new(builder.build()?))
}
