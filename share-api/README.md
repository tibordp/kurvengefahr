# kg-share-api

The share service behind Kurvengefahr's document-sharing feature: a small, content-addressed
blob store for end-to-end-encrypted document snapshots, backed by S3-compatible object storage.
The app encrypts a `.kgz` snapshot in the browser and uploads the ciphertext here under its own
SHA-256; the decryption key travels only in the share link's URL fragment, so this server stores
bytes it cannot read. Blobs are immutable -- there is no mutation API, and re-uploading identical
content is an idempotent no-op.

Abuse posture: uploads require a size-scaled proof-of-work, both paths carry generous per-IP
rate limits (IPv4 per address, IPv6 per /64), blob responses are served download-only
(`application/octet-stream` + `attachment` + `nosniff`, so nothing hosted here ever renders in a
browser), and a bytes-bounded in-memory LRU absorbs hot links without hammering the bucket.
Takedown is operational: delete the object from the bucket and the link is dead forever.

## Quick start

```sh
docker run --rm -p 8080:8080 \
  -e KG_S3_ENDPOINT=https://<s3-compatible-endpoint> \
  -e KG_S3_BUCKET=kg-shares \
  -e KG_S3_ACCESS_KEY_ID=... \
  -e KG_S3_SECRET_ACCESS_KEY=... \
  -e KG_RETENTION_DAYS=30 \
  ghcr.io/<owner>/kurvengefahr/share-api:latest
```

Local development uses the compose stack in [`dev/`](dev/) -- a single-node
[Garage](https://garagehq.deuxfleurs.fr/) as the object store (auto-initialized on first boot by
`dev/garage-init.py`) plus this service built from source:

```sh
docker compose -f share-api/dev/compose.yml up --build
```

The API lands on `http://localhost:8787` and metrics on `http://localhost:8788/metrics`; the
repo's `.env.development` points `npm run dev` at it, so a dev build of the app has sharing
enabled against this stack automatically. To run the service outside Docker, point `cargo run`
at the stack's Garage with the same `KG_S3_*` values `dev/compose.yml` uses.

Point a Kurvengefahr build at the service by setting `VITE_SHARE_API_URL` at app build time;
without it the app has no share UI at all. CORS defaults to any origin (the URL fragment is the
capability and content is encrypted, so cross-origin reads reveal nothing), which means a
self-hosted app needs no server-side configuration.

## Configuration

Everything is environment variables; only the four `KG_S3_*` credentials/locators are required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KG_LISTEN_ADDR` | `0.0.0.0:8080` | API listener |
| `KG_METRICS_ADDR` | `127.0.0.1:9464` | Prometheus listener (keep it private) |
| `KG_S3_ENDPOINT` | required | S3-compatible endpoint URL |
| `KG_S3_BUCKET` | required | Bucket name |
| `KG_S3_REGION` | `us-east-1` | Region string (S3-compatibles usually ignore it) |
| `KG_S3_ACCESS_KEY_ID` | required | |
| `KG_S3_SECRET_ACCESS_KEY` | required | |
| `KG_S3_PREFIX` | `blobs/` | Object key prefix |
| `KG_S3_ALLOW_HTTP` | `false` | Allow a plain-HTTP endpoint (local MinIO only) |
| `KG_S3_VIRTUAL_HOSTED` | `false` | Virtual-hosted-style requests (default is path-style) |
| `KG_MAX_BLOB_BYTES` | `5242880` | Hard upload cap |
| `KG_POW_BASE_BITS` | `13` | Proof-of-work base difficulty |
| `KG_POW_SIZE_STEP` | `1024` | Bytes per difficulty-scaling step |
| `KG_POW_MAX_BITS` | `30` | Difficulty clamp |
| `KG_CACHE_MAX_BYTES` | `268435456` | Blob LRU budget; `0` disables |
| `KG_RATELIMIT_PUT_BURST` / `KG_RATELIMIT_PUT_PER_HOUR` | `30` / `120` | Upload limits per IP |
| `KG_RATELIMIT_GET_BURST` / `KG_RATELIMIT_GET_PER_HOUR` | `120` / `3600` | Read limits per IP |
| `KG_RATELIMIT_MAX_KEYS` | `65536` | LRU bound on tracked IPs, per limiter |
| `KG_TRUST_PROXY` | `false` | Trust the rightmost `X-Forwarded-For` entry |
| `KG_RETENTION_DAYS` | unset | Advertised retention (see below); unset = "indefinitely" |
| `KG_CORS_ORIGINS` | `*` | Comma-separated exact origins to allow instead of any |
| `KG_LOG` | `info` | `tracing` filter string |

## API

All error responses are JSON `{"code": "...", "message": "..."}`.

| Method and path | Behavior |
| --- | --- |
| `PUT /v1/blob/{id}` | Body is the blob (max `KG_MAX_BLOB_BYTES`); `id` must be its unpadded base64url SHA-256; header `X-KG-PoW` carries the proof-of-work nonce (decimal u64). `201` stored, `200` already existed. Errors: `400 invalid_id` / `400 pow_required`, `403 pow_invalid`, `413 too_large`, `422 hash_mismatch`, `429 rate_limited` |
| `GET /v1/blob/{id}` | The blob, `Cache-Control: immutable`, download-only headers. `404 not_found` covers expired |
| `HEAD /v1/blob/{id}` | Existence + `Content-Length` without a body (clients use it to skip re-uploads) |
| `GET /v1/info` | Service parameters for clients: `max_blob_bytes`, `pow` (`base_bits`, `size_step`, `max_bits`), `retention_days` (or null) |
| `GET /healthz` | Shallow liveness for the reverse proxy; never rate-limited |

Proof-of-work contract (`sha256-lz-v1`): find a u64 `nonce` such that
`SHA-256(blob_sha256 || nonce_le)` has at least `d` leading zero bits, where
`d = min(max_bits, base_bits + floor(log2(max(1, ceil(len / size_step)))))`. The normative test
vectors live in [`testdata/pow_vectors.json`](testdata/pow_vectors.json), shared bit-for-bit
with the app's solver and test suites.

## Retention

The service never deletes anything -- expiry belongs to the bucket. Put a lifecycle rule on the
prefix and set `KG_RETENTION_DAYS` to the same number so `/v1/info` tells clients the truth:

```json
{
  "Rules": [
    {
      "ID": "expire-shares",
      "Filter": { "Prefix": "blobs/" },
      "Status": "Enabled",
      "Expiration": { "Days": 30 }
    }
  ]
}
```

(`aws s3api put-bucket-lifecycle-configuration --bucket kg-shares --lifecycle-configuration file://rule.json`,
or the equivalent in your provider's console.)

## Running behind a reverse proxy

- Have the proxy set `X-Forwarded-For`, then set `KG_TRUST_PROXY=true`. Never set it without a
  sanitizing proxy in front -- clients could spoof their rate-limit identity.
- Allow request bodies of at least `KG_MAX_BLOB_BYTES` plus a little (nginx
  `client_max_body_size 6m;`, Caddy `request_body { max_size 6MB }`).
- Route `/healthz` for load-balancer checks.
- Do not expose the metrics port; scrape `KG_METRICS_ADDR` locally. Metrics are prefixed
  `kg_share_` (request counts/latency by route, put/get bytes, blobs created/deduped, PoW
  failures, rate-limit rejections, cache hits/bytes, store op latency/errors).

## Development

`cargo test` runs everything (the integration suite drives the real router against an in-memory
object store; no network, no S3). `cargo fmt` and `cargo clippy --all-targets -- -D warnings`
are gated in CI (`.github/workflows/share-api.yml`), which also publishes the container image to
GHCR on every push to main that touches `share-api/`.
