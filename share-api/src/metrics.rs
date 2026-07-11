//! Prometheus exposition on its own listener (default loopback — never expose it publicly) plus
//! the per-request middleware. The `metrics` macros are no-ops when no recorder is installed,
//! so unit/integration tests need zero ceremony.

use axum::Router;
use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use std::time::Instant;

pub fn install() -> PrometheusHandle {
    PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Suffix("duration_seconds".to_string()),
            &[0.001, 0.005, 0.025, 0.1, 0.25, 1.0, 5.0],
        )
        .expect("static bucket list is non-empty")
        .install_recorder()
        .expect("install prometheus recorder")
}

pub fn app(handle: PrometheusHandle) -> Router {
    Router::new().route("/metrics", get(move || async move { handle.render() }))
}

/// Request counter + latency histogram, labelled by route template (never the raw path — ids
/// would explode cardinality).
pub async fn track_http(req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "unmatched".to_string());
    let start = Instant::now();
    let resp = next.run(req).await;
    metrics::counter!(
        "kg_share_http_requests_total",
        "method" => method.clone(),
        "route" => route.clone(),
        "status" => resp.status().as_u16().to_string(),
    )
    .increment(1);
    metrics::histogram!(
        "kg_share_http_request_duration_seconds",
        "method" => method,
        "route" => route,
    )
    .record(start.elapsed().as_secs_f64());
    resp
}
