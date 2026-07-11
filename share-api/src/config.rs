//! Env-only configuration (the container is configured through nothing else). `from_map` is the
//! parsing seam so tests never mutate process env. Every error names the variable.

use crate::pow::PowParams;
use std::collections::HashMap;
use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub metrics_addr: SocketAddr,
    pub s3: S3Config,
    pub max_blob_bytes: u64,
    pub pow: PowParams,
    pub cache_max_bytes: usize,
    pub put_burst: u32,
    pub put_per_hour: u32,
    pub get_burst: u32,
    pub get_per_hour: u32,
    pub ratelimit_max_keys: usize,
    pub trust_proxy: bool,
    /// Advertised in `/v1/info` only — actual expiry is the bucket's lifecycle rule. Keep the
    /// two in agreement so clients are told the truth.
    pub retention_days: Option<u32>,
    /// `None` = allow any origin (the default: no cookies, no auth, content is E2E-encrypted).
    pub cors_origins: Option<Vec<String>>,
    pub log: String,
}

#[derive(Clone, Debug)]
pub struct S3Config {
    /// Custom endpoint for S3-compatibles (MinIO, Garage, Hetzner, R2). Unset = real AWS S3,
    /// where the SDK derives the endpoint from region + bucket; `allow_http`/`virtual_hosted`
    /// only apply alongside a custom endpoint.
    pub endpoint: Option<String>,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
    pub allow_http: bool,
    pub virtual_hosted: bool,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ConfigError {
    #[error("missing required environment variable {0}")]
    Missing(&'static str),
    #[error("invalid value for {var}: {value:?} ({expected})")]
    Invalid {
        var: &'static str,
        value: String,
        expected: &'static str,
    },
}

fn required(vars: &HashMap<String, String>, name: &'static str) -> Result<String, ConfigError> {
    match vars.get(name).map(|s| s.trim()) {
        Some(v) if !v.is_empty() => Ok(v.to_string()),
        _ => Err(ConfigError::Missing(name)),
    }
}

fn parsed<T: std::str::FromStr>(
    vars: &HashMap<String, String>,
    name: &'static str,
    default: T,
    expected: &'static str,
) -> Result<T, ConfigError> {
    match optional(vars, name, expected)? {
        Some(v) => Ok(v),
        None => Ok(default),
    }
}

fn optional<T: std::str::FromStr>(
    vars: &HashMap<String, String>,
    name: &'static str,
    expected: &'static str,
) -> Result<Option<T>, ConfigError> {
    match vars.get(name).map(|s| s.trim()) {
        None | Some("") => Ok(None),
        Some(raw) => raw.parse().map(Some).map_err(|_| ConfigError::Invalid {
            var: name,
            value: raw.to_string(),
            expected,
        }),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(vars: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let cors_origins = match vars.get("KG_CORS_ORIGINS").map(|s| s.trim()) {
            None | Some("") | Some("*") => None,
            Some(list) => Some(list.split(',').map(|o| o.trim().to_string()).collect()),
        };
        Ok(Config {
            listen_addr: parsed(
                vars,
                "KG_LISTEN_ADDR",
                "0.0.0.0:8080".parse().unwrap(),
                "host:port",
            )?,
            metrics_addr: parsed(
                vars,
                "KG_METRICS_ADDR",
                "127.0.0.1:9464".parse().unwrap(),
                "host:port",
            )?,
            s3: S3Config {
                endpoint: optional(vars, "KG_S3_ENDPOINT", "endpoint URL")?,
                bucket: required(vars, "KG_S3_BUCKET")?,
                region: parsed(vars, "KG_S3_REGION", "us-east-1".to_string(), "region name")?,
                access_key_id: required(vars, "KG_S3_ACCESS_KEY_ID")?,
                secret_access_key: required(vars, "KG_S3_SECRET_ACCESS_KEY")?,
                prefix: parsed(vars, "KG_S3_PREFIX", "blobs/".to_string(), "key prefix")?,
                allow_http: parsed(vars, "KG_S3_ALLOW_HTTP", false, "true|false")?,
                virtual_hosted: parsed(vars, "KG_S3_VIRTUAL_HOSTED", false, "true|false")?,
            },
            max_blob_bytes: parsed(vars, "KG_MAX_BLOB_BYTES", 5 * 1024 * 1024, "bytes")?,
            pow: PowParams {
                base_bits: parsed(vars, "KG_POW_BASE_BITS", 13, "bits")?,
                size_step: parsed(vars, "KG_POW_SIZE_STEP", 1024, "bytes")?,
                max_bits: parsed(vars, "KG_POW_MAX_BITS", 30, "bits")?,
            },
            cache_max_bytes: parsed(vars, "KG_CACHE_MAX_BYTES", 256 * 1024 * 1024, "bytes")?,
            put_burst: parsed(vars, "KG_RATELIMIT_PUT_BURST", 30, "count")?,
            put_per_hour: parsed(vars, "KG_RATELIMIT_PUT_PER_HOUR", 120, "count")?,
            get_burst: parsed(vars, "KG_RATELIMIT_GET_BURST", 120, "count")?,
            get_per_hour: parsed(vars, "KG_RATELIMIT_GET_PER_HOUR", 3600, "count")?,
            ratelimit_max_keys: parsed(vars, "KG_RATELIMIT_MAX_KEYS", 65536, "count")?,
            trust_proxy: parsed(vars, "KG_TRUST_PROXY", false, "true|false")?,
            retention_days: optional(vars, "KG_RETENTION_DAYS", "days")?,
            cors_origins,
            log: parsed(vars, "KG_LOG", "info".to_string(), "tracing filter")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HashMap<String, String> {
        [
            ("KG_S3_ENDPOINT", "http://localhost:9000"),
            ("KG_S3_BUCKET", "shares"),
            ("KG_S3_ACCESS_KEY_ID", "minio"),
            ("KG_S3_SECRET_ACCESS_KEY", "minio123"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn defaults_apply() {
        let c = Config::from_map(&base()).unwrap();
        assert_eq!(c.listen_addr, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.max_blob_bytes, 5 * 1024 * 1024);
        assert_eq!(c.pow.base_bits, 13);
        assert_eq!(c.retention_days, None);
        assert!(c.cors_origins.is_none());
        assert!(!c.trust_proxy);
        assert_eq!(c.s3.prefix, "blobs/");
        assert_eq!(c.s3.endpoint.as_deref(), Some("http://localhost:9000"));
    }

    #[test]
    fn endpoint_is_optional_for_real_aws() {
        let mut vars = base();
        vars.remove("KG_S3_ENDPOINT");
        assert_eq!(Config::from_map(&vars).unwrap().s3.endpoint, None);
    }

    #[test]
    fn missing_required_names_the_var() {
        let mut vars = base();
        vars.remove("KG_S3_BUCKET");
        assert_eq!(
            Config::from_map(&vars).unwrap_err(),
            ConfigError::Missing("KG_S3_BUCKET")
        );
    }

    #[test]
    fn bad_parse_names_the_var() {
        let mut vars = base();
        vars.insert("KG_MAX_BLOB_BYTES".into(), "five megabytes".into());
        match Config::from_map(&vars).unwrap_err() {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "KG_MAX_BLOB_BYTES"),
            e => panic!("wrong error: {e}"),
        }
    }

    #[test]
    fn overrides_and_lists() {
        let mut vars = base();
        vars.insert("KG_RETENTION_DAYS".into(), "30".into());
        vars.insert(
            "KG_CORS_ORIGINS".into(),
            "https://kurvengefahr.org, https://example.com".into(),
        );
        vars.insert("KG_TRUST_PROXY".into(), "true".into());
        let c = Config::from_map(&vars).unwrap();
        assert_eq!(c.retention_days, Some(30));
        assert_eq!(
            c.cors_origins.as_deref(),
            Some(
                &[
                    "https://kurvengefahr.org".to_string(),
                    "https://example.com".to_string()
                ][..]
            )
        );
        assert!(c.trust_proxy);
        // Explicit "*" means the default: any origin.
        vars.insert("KG_CORS_ORIGINS".into(), "*".into());
        assert!(Config::from_map(&vars).unwrap().cors_origins.is_none());
    }
}
