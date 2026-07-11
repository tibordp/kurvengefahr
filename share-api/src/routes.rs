//! HTTP handlers. Everything the API promises lives here: the PUT pipeline (cap → hash → PoW →
//! idempotent store), GETs served hostile to direct consumption (octet-stream + attachment +
//! nosniff — a fetched blob never renders or executes), and a dedicated HEAD that never touches
//! a body. Rate limiting is checked in-handler so /healthz, /v1/info, and CORS preflights are
//! exempt by construction.

use crate::AppState;
use crate::error::ApiError;
use crate::id::BlobId;
use crate::pow;
use crate::ratelimit::{IpKey, RateLimiter, client_ip};
use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::time::Instant;

pub const POW_HEADER: &str = "x-kg-pow";

fn check_limit(
    limiter: &RateLimiter,
    state: &AppState,
    addr: SocketAddr,
    headers: &HeaderMap,
    op: &'static str,
) -> Result<(), ApiError> {
    let ip = client_ip(addr, headers, state.config.trust_proxy);
    limiter
        .check(IpKey::from_ip(ip), Instant::now())
        .map_err(|retry| {
            metrics::counter!("kg_share_rate_limited_total", "op" => op).increment(1);
            ApiError::rate_limited(retry)
        })
}

/// Response headers for blob bodies. Immutable-forever caching is sound because the id *is* the
/// content hash; attachment + nosniff keep a blob from ever rendering in a browser.
fn blob_response(id: &BlobId, len: u64, body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::CONTENT_LENGTH, len)
        .header(header::ETAG, format!("\"{id}\""))
        .body(body)
        .expect("static headers are valid")
}

pub async fn put_blob(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Result<Response, ApiError> {
    check_limit(&state.put_limiter, &state, addr, req.headers(), "put")?;
    let id: BlobId = id.parse().map_err(|_| ApiError::invalid_id())?;
    let max = state.config.max_blob_bytes;

    let nonce: u64 = req
        .headers()
        .get(POW_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| {
            metrics::counter!("kg_share_pow_failures_total", "reason" => "missing").increment(1);
            ApiError::pow_required()
        })?;

    // Reject a declared-oversize body before reading a byte; the streaming loop enforces the
    // cap for chunked/lying senders.
    if let Some(declared) = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && declared > max
    {
        return Err(ApiError::too_large(max));
    }

    let mut stream = req.into_body().into_data_stream();
    let mut buf = BytesMut::new();
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::invalid_body())?;
        if buf.len() as u64 + chunk.len() as u64 > max {
            return Err(ApiError::too_large(max));
        }
        hasher.update(&chunk);
        buf.extend_from_slice(&chunk);
    }
    // The id is the digest's 16-byte truncation; PoW binds to the FULL digest (the contract in
    // `pow` — the client had the whole hash in hand when it mined).
    let digest: [u8; 32] = hasher.finalize().into();
    if BlobId::from_digest(&digest) != id {
        return Err(ApiError::hash_mismatch());
    }

    // PoW is verified even when the object already exists: it costs one hash and keeps an
    // unpowered PUT from doubling as a cheap existence oracle.
    let required = pow::difficulty(buf.len() as u64, &state.config.pow);
    if !pow::verify(&digest, nonce, required) {
        metrics::counter!("kg_share_pow_failures_total", "reason" => "invalid").increment(1);
        return Err(ApiError::pow_invalid(required));
    }

    let body = buf.freeze();
    let size = body.len() as u64;
    if state
        .store
        .exists(&id)
        .await
        .map_err(ApiError::storage)?
        .is_some()
    {
        state.cache.insert(id, body);
        metrics::counter!("kg_share_blobs_deduped_total").increment(1);
        let payload = Json(json!({ "id": id.to_string(), "size": size, "created": false }));
        return Ok((StatusCode::OK, payload).into_response());
    }
    state
        .store
        .put(&id, body.clone())
        .await
        .map_err(ApiError::storage)?;
    state.cache.insert(id, body);
    metrics::counter!("kg_share_blobs_created_total").increment(1);
    metrics::counter!("kg_share_put_bytes_total").increment(size);
    let payload = Json(json!({ "id": id.to_string(), "size": size, "created": true }));
    Ok((StatusCode::CREATED, payload).into_response())
}

pub async fn get_blob(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    check_limit(&state.get_limiter, &state, addr, &headers, "get")?;
    let id: BlobId = id.parse().map_err(|_| ApiError::invalid_id())?;

    let body: Bytes = match state.cache.get(&id) {
        Some(hit) => {
            metrics::counter!("kg_share_cache_hits_total").increment(1);
            hit
        }
        None => {
            metrics::counter!("kg_share_cache_misses_total").increment(1);
            let fetched = state
                .store
                .get(&id)
                .await
                .map_err(ApiError::storage)?
                .ok_or_else(ApiError::not_found)?;
            state.cache.insert(id, fetched.clone());
            fetched
        }
    };
    metrics::counter!("kg_share_get_bytes_total").increment(body.len() as u64);
    let len = body.len() as u64;
    Ok(blob_response(&id, len, Body::from(body)))
}

/// Dedicated HEAD so existence checks never pull a body from the bucket (axum would otherwise
/// run the GET handler and strip the body after the fact).
pub async fn head_blob(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    check_limit(&state.get_limiter, &state, addr, &headers, "get")?;
    let id: BlobId = id.parse().map_err(|_| ApiError::invalid_id())?;

    let len = match state.cache.peek_len(&id) {
        Some(len) => len,
        None => state
            .store
            .exists(&id)
            .await
            .map_err(ApiError::storage)?
            .ok_or_else(ApiError::not_found)?,
    };
    Ok(blob_response(&id, len, Body::empty()))
}

pub async fn info(State(state): State<AppState>) -> Response {
    let cfg = &state.config;
    let payload = json!({
        "service": "kg-share-api",
        "version": env!("CARGO_PKG_VERSION"),
        "api": 1,
        "max_blob_bytes": cfg.max_blob_bytes,
        "pow": {
            "algorithm": "sha256-lz-v1",
            "base_bits": cfg.pow.base_bits,
            "size_step": cfg.pow.size_step,
            "max_bits": cfg.pow.max_bits,
        },
        "retention_days": cfg.retention_days,
    });
    (
        [(header::CACHE_CONTROL, "public, max-age=300")],
        Json(payload),
    )
        .into_response()
}

pub async fn healthz() -> &'static str {
    "ok"
}
