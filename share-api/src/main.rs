//! Thin shell: config from env, tracing, the two listeners (API + metrics), graceful shutdown.
//! Everything testable lives in the library.

use kg_share_api::{app, build_state, config::Config, metrics, storage};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    };
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(&config.log))
        .init();

    let handle = metrics::install();
    let store = match storage::s3_store(&config.s3) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("object store configuration error: {e}");
            std::process::exit(1);
        }
    };

    let listen_addr = config.listen_addr;
    let metrics_addr = config.metrics_addr;
    let api = app(build_state(config, store)).into_make_service_with_connect_info::<SocketAddr>();
    let metrics_app = metrics::app(handle);

    let api_listener = TcpListener::bind(listen_addr)
        .await
        .expect("bind API listener");
    let metrics_listener = TcpListener::bind(metrics_addr)
        .await
        .expect("bind metrics listener");
    tracing::info!(%listen_addr, %metrics_addr, "kg-share-api listening");

    let serve_api = axum::serve(api_listener, api).with_graceful_shutdown(shutdown_signal());
    let serve_metrics = axum::serve(metrics_listener, metrics_app.into_make_service())
        .with_graceful_shutdown(shutdown_signal());
    let (a, m) = tokio::join!(serve_api, serve_metrics);
    a.expect("API server error");
    m.expect("metrics server error");
}

/// Resolves on SIGTERM (docker stop) or ctrl-c. Each server awaits its own copy; both fire.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
