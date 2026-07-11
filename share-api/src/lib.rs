//! kg-share-api — content-addressed, immutable, E2E-encrypted share-blob store for Kurvengefahr.
//!
//! The app encrypts a document snapshot client-side and PUTs the ciphertext here under its own
//! SHA-256; anyone with the share link GETs it back and decrypts in the browser (the key lives
//! in the URL fragment and never reaches this server, which therefore stores bytes it cannot
//! read). No mutation API exists; expiry is the bucket's lifecycle rule, not code.
//!
//! Abuse posture: size-scaled proof-of-work on PUT (`pow`), generous per-IP GCRA limits on both
//! paths (`ratelimit`, IPv4 /32 / IPv6 /64), responses hostile to direct consumption (`routes`),
//! and an in-memory LRU for hot links (`cache`). Prometheus metrics ride a separate listener
//! (`metrics`). Takedown = delete the object from the bucket.
//!
//! `app()` builds the full router from injected state, so integration tests run the real thing
//! against `object_store::memory::InMemory` with no sockets.

pub mod cache;
pub mod config;
pub mod error;
pub mod id;
pub mod metrics;
pub mod pow;
pub mod ratelimit;
pub mod routes;
pub mod storage;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method, header};
use axum::routing::get;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub store: Arc<storage::BlobStore>,
    pub cache: Arc<cache::BlobCache>,
    pub put_limiter: Arc<ratelimit::RateLimiter>,
    pub get_limiter: Arc<ratelimit::RateLimiter>,
}

pub fn build_state(config: config::Config, store: Arc<dyn object_store::ObjectStore>) -> AppState {
    AppState {
        store: Arc::new(storage::BlobStore::new(store, &config.s3.prefix)),
        cache: Arc::new(cache::BlobCache::new(config.cache_max_bytes)),
        put_limiter: Arc::new(ratelimit::RateLimiter::new(
            config.put_burst,
            config.put_per_hour,
            config.ratelimit_max_keys,
        )),
        get_limiter: Arc::new(ratelimit::RateLimiter::new(
            config.get_burst,
            config.get_per_hour,
            config.ratelimit_max_keys,
        )),
        config: Arc::new(config),
    }
}

pub fn app(state: AppState) -> Router {
    let cors = cors_layer(&state.config);
    Router::new()
        .route(
            "/v1/blob/{id}",
            axum::routing::put(routes::put_blob)
                .get(routes::get_blob)
                .head(routes::head_blob)
                .layer(DefaultBodyLimit::disable()), // the PUT handler enforces the cap itself
        )
        .route("/v1/info", get(routes::info))
        .route("/healthz", get(routes::healthz))
        .layer(axum::middleware::from_fn(metrics::track_http))
        // Outermost so preflights are answered before rate limiting can 429 them.
        .layer(cors)
        .with_state(state)
}

/// Default is any origin: there are no cookies and no ambient authority — the URL is the
/// capability and blobs are E2E-encrypted, so a foreign origin learns nothing curl couldn't.
/// `KG_CORS_ORIGINS` narrows it for deployments that want to. Never allow credentials here.
fn cors_layer(config: &config::Config) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::HEAD, Method::PUT])
        .allow_headers([header::CONTENT_TYPE, routes::POW_HEADER.parse().unwrap()])
        .max_age(Duration::from_secs(86400));
    match &config.cors_origins {
        None => layer.allow_origin(Any),
        Some(origins) => {
            let parsed: Vec<HeaderValue> = origins
                .iter()
                .map(|o| {
                    o.parse().unwrap_or_else(|_| {
                        panic!("KG_CORS_ORIGINS entry {o:?} is not a valid origin")
                    })
                })
                .collect();
            layer.allow_origin(parsed)
        }
    }
}
