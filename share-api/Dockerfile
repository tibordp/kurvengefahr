# Multi-stage build: dependency layer cached on the manifests, then the real sources.
# Runtime is distroless/cc (glibc for the binary; TLS is rustls via object_store, so no OpenSSL)
# with bundled CA certificates, running as uid 65532. Build context = share-api/ only.
FROM rust:1-slim-bookworm AS build
WORKDIR /build

# Warm the dependency layer with a stub crate so source edits don't recompile the world.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && touch src/lib.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/kg-share-api* target/release/deps/kg_share_api* \
        target/release/deps/libkg_share_api* target/release/.fingerprint/kg-share-api-*

COPY src ./src
COPY testdata ./testdata
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/kg-share-api /usr/local/bin/kg-share-api
USER nonroot
# 8080 = API (KG_LISTEN_ADDR), 9464 = Prometheus metrics (KG_METRICS_ADDR — bind it explicitly
# to a non-loopback address if you want it scrapeable from outside the container).
EXPOSE 8080 9464
ENTRYPOINT ["/usr/local/bin/kg-share-api"]
