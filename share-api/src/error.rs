//! The one error type every handler returns. Serializes as `{"code", "message"}` JSON with the
//! matching status; `Retry-After` rides along on 429s. Machine codes are part of the API
//! contract (the app's client maps on them) — change them only with the client.

use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::time::Duration;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            retry_after: None,
        }
    }

    pub fn invalid_id() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "blob id must be the unpadded base64url of the body's first 16 SHA-256 bytes (22 chars)",
        )
    }

    pub fn pow_required() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "pow_required",
            "missing or unparseable X-KG-PoW header (decimal u64 nonce)",
        )
    }

    pub fn pow_invalid(required_bits: u32) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "pow_invalid",
            format!("proof-of-work nonce does not meet {required_bits} leading zero bits"),
        )
    }

    pub fn too_large(max: u64) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            format!("body exceeds the {max}-byte limit"),
        )
    }

    pub fn hash_mismatch() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "hash_mismatch",
            "body SHA-256 does not match the blob id",
        )
    }

    pub fn invalid_body() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "failed to read request body",
        )
    }

    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such blob (it may have expired)",
        )
    }

    pub fn rate_limited(retry_after: Duration) -> Self {
        let secs = retry_after.as_secs_f64().ceil().max(1.0) as u64;
        ApiError {
            retry_after: Some(secs),
            ..Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "rate limit exceeded",
            )
        }
    }

    pub fn storage(err: impl std::fmt::Display) -> Self {
        tracing::error!(%err, "object store operation failed");
        Self::new(
            StatusCode::BAD_GATEWAY,
            "storage_error",
            "object storage unavailable",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "code": self.code, "message": self.message }));
        let mut resp = (self.status, body).into_response();
        if let Some(secs) = self.retry_after {
            resp.headers_mut().insert(header::RETRY_AFTER, secs.into());
        }
        resp
    }
}
