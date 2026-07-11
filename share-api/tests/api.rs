//! Integration tests: the real router against an in-memory object store, driven with
//! `tower::ServiceExt::oneshot` — no sockets, fully parallel-safe, no wall-clock assertions
//! (rate-limit tests only exhaust bursts). PoW difficulty is configured low enough that the
//! brute-force helper solves in microseconds.

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, Response, StatusCode, header};
use http_body_util::BodyExt;
use kg_share_api::config::Config;
use kg_share_api::id::BlobId;
use kg_share_api::pow::{PowParams, difficulty, verify};
use kg_share_api::{app, build_state};
use object_store::ObjectStore;
use object_store::memory::InMemory;
use object_store::path::Path as ObjPath;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

const PREFIX: &str = "blobs/";

fn test_config() -> Config {
    let vars: HashMap<String, String> = [
        ("KG_S3_ENDPOINT", "http://unused:9000"),
        ("KG_S3_BUCKET", "unused"),
        ("KG_S3_ACCESS_KEY_ID", "unused"),
        ("KG_S3_SECRET_ACCESS_KEY", "unused"),
        // Test-solvable PoW: flat 8 bits regardless of size.
        ("KG_POW_BASE_BITS", "8"),
        ("KG_POW_SIZE_STEP", "1073741824"),
        ("KG_MAX_BLOB_BYTES", "4096"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    Config::from_map(&vars).unwrap()
}

fn make_app(config: Config) -> (Router, Arc<InMemory>) {
    let store = Arc::new(InMemory::new());
    (app(build_state(config, store.clone())), store)
}

/// Brute-force solver mirroring the contract (PoW binds to the FULL digest, not the truncated
/// id); fine at 8 bits.
fn solve(body: &[u8], params: &PowParams) -> u64 {
    let digest = full_digest(body);
    let bits = difficulty(body.len() as u64, params);
    (0u64..).find(|&n| verify(&digest, n, bits)).unwrap()
}

fn full_digest(body: &[u8]) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest(body).into()
}

fn with_ip(mut req: Request<Body>, ip: &str) -> Request<Body> {
    let addr: SocketAddr = format!("{ip}:12345").parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(addr));
    req
}

fn put_request(id: &str, body: Vec<u8>, nonce: u64, ip: &str) -> Request<Body> {
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/blob/{id}"))
        .header("x-kg-pow", nonce.to_string())
        .body(Body::from(body))
        .unwrap();
    with_ip(req, ip)
}

fn get_request(method: &str, id: &str, ip: &str) -> Request<Body> {
    let req = Request::builder()
        .method(method)
        .uri(format!("/v1/blob/{id}"))
        .body(Body::empty())
        .unwrap();
    with_ip(req, ip)
}

async fn send(app: &Router, req: Request<Body>) -> Response<Body> {
    app.clone().oneshot(req).await.unwrap()
}

async fn body_bytes(resp: Response<Body>) -> Vec<u8> {
    resp.into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

async fn body_json(resp: Response<Body>) -> serde_json::Value {
    serde_json::from_slice(&body_bytes(resp).await).unwrap()
}

/// PUT a body from `ip` with a freshly solved PoW; returns (id string, response).
async fn put_blob(
    app: &Router,
    config: &Config,
    body: &[u8],
    ip: &str,
) -> (String, Response<Body>) {
    let id = BlobId::of(body);
    let nonce = solve(body, &config.pow);
    let resp = send(app, put_request(&id.to_string(), body.to_vec(), nonce, ip)).await;
    (id.to_string(), resp)
}

#[tokio::test]
async fn put_get_roundtrip_with_headers() {
    let config = test_config();
    let (app, _) = make_app(config.clone());
    let body = b"encrypted kurvengefahr document".to_vec();

    let (id, resp) = put_blob(&app, &config, &body, "1.2.3.4").await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let created = body_json(resp).await;
    assert_eq!(created["created"], true);
    assert_eq!(created["id"], id);
    assert_eq!(created["size"], body.len() as u64);

    let resp = send(&app, get_request("GET", &id, "5.6.7.8")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let headers = resp.headers().clone();
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(headers[header::ETAG], format!("\"{id}\""));
    assert_eq!(
        headers[header::CONTENT_LENGTH],
        body.len().to_string().as_str()
    );
    assert_eq!(body_bytes(resp).await, body);
}

#[tokio::test]
async fn re_put_dedupes() {
    let config = test_config();
    let (app, _) = make_app(config.clone());
    let body = b"same bytes twice".to_vec();
    let (_, first) = put_blob(&app, &config, &body, "1.1.1.1").await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let (_, second) = put_blob(&app, &config, &body, "1.1.1.1").await;
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(body_json(second).await["created"], false);
}

#[tokio::test]
async fn get_serves_from_cache_after_bucket_delete() {
    let config = test_config();
    let (app, store) = make_app(config.clone());
    let body = b"cached blob".to_vec();
    let (id, _) = put_blob(&app, &config, &body, "1.1.1.1").await;

    // The write-through cache means the bucket copy is no longer needed for reads.
    store
        .delete(&ObjPath::from(format!("{PREFIX}{id}")))
        .await
        .unwrap();
    let resp = send(&app, get_request("GET", &id, "2.2.2.2")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_bytes(resp).await, body);
}

#[tokio::test]
async fn put_rejections() {
    let config = test_config();
    let (app, _) = make_app(config.clone());
    let body = b"some body".to_vec();
    let id = BlobId::of(&body);
    let nonce = solve(&body, &config.pow);

    // Bad id in the path.
    let resp = send(
        &app,
        put_request("not-a-valid-id", body.clone(), nonce, "1.1.1.1"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["code"], "invalid_id");

    // Hash mismatch: valid id of *different* content.
    let other = BlobId::of(b"other content").to_string();
    let resp = send(&app, put_request(&other, body.clone(), nonce, "1.1.1.1")).await;
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(resp).await["code"], "hash_mismatch");

    // Missing PoW header.
    let req = with_ip(
        Request::builder()
            .method("PUT")
            .uri(format!("/v1/blob/{id}"))
            .body(Body::from(body.clone()))
            .unwrap(),
        "1.1.1.1",
    );
    let resp = send(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["code"], "pow_required");

    // A nonce that fails the bits requirement. 8 bits leaves plenty of failing nonces; find one.
    let bad = (0u64..)
        .find(|&n| !verify(&full_digest(&body), n, 8))
        .unwrap();
    let resp = send(
        &app,
        put_request(&id.to_string(), body.clone(), bad, "1.1.1.1"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["code"], "pow_invalid");
}

#[tokio::test]
async fn oversize_rejected_both_ways() {
    let config = test_config(); // max 4096
    let (app, _) = make_app(config.clone());

    // Truthful oversized stream (no lying header needed — Body::from sets none here).
    let big = vec![7u8; 5000];
    let id = BlobId::of(&big);
    let resp = send(&app, put_request(&id.to_string(), big, 0, "1.1.1.1")).await;
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    // Declared-oversize Content-Length is rejected before the body is read.
    let small = b"tiny".to_vec();
    let id = BlobId::of(&small);
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/blob/{id}"))
        .header("x-kg-pow", "0")
        .header(header::CONTENT_LENGTH, "999999999")
        .body(Body::from(small))
        .unwrap();
    let resp = send(&app, with_ip(req, "1.1.1.1")).await;
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body_json(resp).await["code"], "too_large");
}

#[tokio::test]
async fn put_rate_limit_by_ip_bucket() {
    let mut config = test_config();
    config.put_burst = 2;
    config.put_per_hour = 1; // effectively no refill within the test
    let (app, _) = make_app(config.clone());

    // Two distinct bodies from the same IP pass, the third 429s with Retry-After.
    for i in 0..2u8 {
        let (_, resp) = put_blob(&app, &config, &[i; 8], "9.9.9.9").await;
        assert_eq!(resp.status(), StatusCode::CREATED);
    }
    let (_, resp) = put_blob(&app, &config, &[2u8; 8], "9.9.9.9").await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(resp.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(body_json(resp).await["code"], "rate_limited");

    // A different IP is unaffected.
    let (_, resp) = put_blob(&app, &config, &[3u8; 8], "9.9.9.10").await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // Two IPv6 addresses in the same /64 share the bucket.
    let mut config = test_config();
    config.put_burst = 1;
    config.put_per_hour = 1;
    let (app, _) = make_app(config.clone());
    let a = "[2001:db8:1:2:aaaa::1]";
    let b = "[2001:db8:1:2:bbbb::2]";
    let (_, resp) = put_blob(&app, &config, &[4u8; 8], a).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let (_, resp) = put_blob(&app, &config, &[5u8; 8], b).await;
    assert_eq!(
        resp.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "same /64 shares the bucket"
    );
}

#[tokio::test]
async fn xff_honored_only_when_trusted() {
    let mut config = test_config();
    config.get_burst = 1;
    config.get_per_hour = 1;

    // Untrusted: two requests with different XFF but the same peer share a bucket.
    let (app, _) = make_app(config.clone());
    for (i, expect) in [StatusCode::NOT_FOUND, StatusCode::TOO_MANY_REQUESTS]
        .iter()
        .enumerate()
    {
        let mut req = get_request("GET", &BlobId::of(b"x").to_string(), "8.8.8.8");
        req.headers_mut()
            .insert("x-forwarded-for", format!("100.0.0.{i}").parse().unwrap());
        assert_eq!(
            send(&app, req).await.status(),
            *expect,
            "untrusted XFF must be ignored"
        );
    }

    // Trusted: the same two requests land in different buckets.
    config.trust_proxy = true;
    let (app, _) = make_app(config.clone());
    for i in 0..2 {
        let mut req = get_request("GET", &BlobId::of(b"x").to_string(), "8.8.8.8");
        req.headers_mut()
            .insert("x-forwarded-for", format!("100.0.0.{i}").parse().unwrap());
        assert_eq!(
            send(&app, req).await.status(),
            StatusCode::NOT_FOUND,
            "trusted XFF splits the buckets"
        );
    }
}

#[tokio::test]
async fn head_existence_without_body() {
    let config = test_config();
    let (app, _) = make_app(config.clone());
    let body = b"head me".to_vec();
    let (id, _) = put_blob(&app, &config, &body, "1.1.1.1").await;

    let resp = send(&app, get_request("HEAD", &id, "2.2.2.2")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()[header::CONTENT_LENGTH],
        body.len().to_string().as_str()
    );
    assert!(body_bytes(resp).await.is_empty(), "HEAD carries no body");

    let missing = BlobId::of(b"never uploaded").to_string();
    let resp = send(&app, get_request("HEAD", &missing, "2.2.2.2")).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // HEAD consumes the GET limiter.
    let mut config = test_config();
    config.get_burst = 1;
    config.get_per_hour = 1;
    let (app, _) = make_app(config.clone());
    let _ = send(&app, get_request("HEAD", &missing, "3.3.3.3")).await;
    let resp = send(&app, get_request("HEAD", &missing, "3.3.3.3")).await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn cors_preflight_allows_pow_header_and_skips_rate_limit() {
    let mut config = test_config();
    config.get_burst = 1;
    config.get_per_hour = 1;
    config.put_burst = 1;
    config.put_per_hour = 1;
    let (app, _) = make_app(config);

    for _ in 0..5 {
        let req = with_ip(
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/blob/whatever")
                .header(header::ORIGIN, "https://kurvengefahr.org")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "x-kg-pow")
                .body(Body::empty())
                .unwrap(),
            "4.4.4.4",
        );
        let resp = send(&app, req).await;
        assert!(
            resp.status().is_success(),
            "preflight never rate-limited: {}",
            resp.status()
        );
        let allow = resp.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()
            .unwrap();
        assert!(
            allow.to_ascii_lowercase().contains("x-kg-pow"),
            "allow-headers: {allow}"
        );
        assert_eq!(resp.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }
}

#[tokio::test]
async fn info_shape() {
    let mut config = test_config();
    config.retention_days = Some(30);
    let (app, _) = make_app(config);
    let resp = send(
        &app,
        with_ip(
            Request::builder()
                .uri("/v1/info")
                .body(Body::empty())
                .unwrap(),
            "1.1.1.1",
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let info = body_json(resp).await;
    assert_eq!(info["service"], "kg-share-api");
    assert_eq!(info["api"], 1);
    assert_eq!(info["max_blob_bytes"], 4096);
    assert_eq!(info["pow"]["algorithm"], "sha256-lz-v1");
    assert_eq!(info["pow"]["base_bits"], 8);
    assert_eq!(info["pow"]["size_step"], 1073741824u64);
    assert_eq!(info["pow"]["max_bits"], 30);
    assert_eq!(info["retention_days"], 30);

    // Unset retention serializes as null.
    let (app, _) = make_app(test_config());
    let resp = send(
        &app,
        with_ip(
            Request::builder()
                .uri("/v1/info")
                .body(Body::empty())
                .unwrap(),
            "1.1.1.1",
        ),
    )
    .await;
    assert!(body_json(resp).await["retention_days"].is_null());
}

#[tokio::test]
async fn healthz_ok() {
    let (app, _) = make_app(test_config());
    let resp = send(
        &app,
        with_ip(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
            "1.1.1.1",
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_bytes(resp).await, b"ok");
}
