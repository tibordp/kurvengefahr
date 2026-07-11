//! Per-IP rate limiting: GCRA with one stored timestamp per key, LRU-bounded. IPv4 is keyed per
//! address (/32); IPv6 per /64 — the standard end-site allocation, so one subscriber can't mint
//! 2^64 identities. The clock is a `check()` argument, which makes time a pure input in tests.
//!
//! Eviction correctness: an evicted key is one that hasn't been seen for `max_keys` distinct
//! other keys — long idle, so its bucket would be full anyway. An attacker churning keys to
//! evict others is bounded by the limiter itself.

use lru::LruCache;
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum IpKey {
    V4(u32),
    V6(u64),
}

impl IpKey {
    pub fn from_ip(ip: IpAddr) -> Self {
        // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the same client as its IPv4 form.
        match ip.to_canonical() {
            IpAddr::V4(v4) => IpKey::V4(u32::from(v4)),
            IpAddr::V6(v6) => IpKey::V6(u64::from_be_bytes(v6.octets()[..8].try_into().unwrap())),
        }
    }
}

/// The client IP a request is accounted to. Only when the deployment says a trusted reverse
/// proxy fronts us do we read `X-Forwarded-For` — and then only its *rightmost* entry, the one
/// appended by our own proxy; everything left of it is attacker-controlled.
pub fn client_ip(peer: SocketAddr, headers: &axum::http::HeaderMap, trust_proxy: bool) -> IpAddr {
    if trust_proxy
        && let Some(xff) = headers.get("x-forwarded-for")
        && let Ok(value) = xff.to_str()
        && let Some(last) = value.rsplit(',').next()
        && let Ok(ip) = last.trim().parse::<IpAddr>()
    {
        return ip;
    }
    peer.ip()
}

pub struct RateLimiter {
    emission: Duration,
    burst_tolerance: Duration,
    inner: Mutex<LruCache<IpKey, Instant>>,
}

impl RateLimiter {
    /// `burst` requests may arrive back-to-back; sustained throughput converges to
    /// `per_hour / hour`.
    pub fn new(burst: u32, per_hour: u32, max_keys: usize) -> Self {
        let emission = Duration::from_secs_f64(3600.0 / per_hour.max(1) as f64);
        RateLimiter {
            emission,
            burst_tolerance: emission * burst.max(1).saturating_sub(1),
            inner: Mutex::new(LruCache::new(NonZeroUsize::new(max_keys.max(1)).unwrap())),
        }
    }

    /// GCRA: the stored value is the theoretical arrival time (TAT). Allow while the TAT is
    /// within `burst_tolerance` of now; on rejection, `Err` holds how long until it would be.
    pub fn check(&self, key: IpKey, now: Instant) -> Result<(), Duration> {
        let mut cache = self.inner.lock().unwrap();
        let tat = cache.get(&key).copied().unwrap_or(now).max(now);
        let ahead = tat.duration_since(now);
        if ahead > self.burst_tolerance {
            return Err(ahead - self.burst_tolerance);
        }
        cache.put(key, tat + self.emission);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpKey {
        IpKey::from_ip(IpAddr::from([a, b, c, d]))
    }

    #[test]
    fn burst_then_reject_then_refill() {
        let rl = RateLimiter::new(3, 3600, 16); // 1/s sustained, burst 3
        let t0 = Instant::now();
        let key = v4(1, 2, 3, 4);
        for _ in 0..3 {
            assert!(rl.check(key, t0).is_ok());
        }
        let retry = rl.check(key, t0).unwrap_err();
        assert!(retry > Duration::ZERO && retry <= Duration::from_secs(1));
        // After exactly one emission interval, one more slot has drained.
        assert!(rl.check(key, t0 + Duration::from_secs(1)).is_ok());
        assert!(rl.check(key, t0 + Duration::from_secs(1)).is_err());
        // A long-idle key is fully refilled.
        assert!(rl.check(key, t0 + Duration::from_secs(3600)).is_ok());
    }

    #[test]
    fn keys_are_independent() {
        let rl = RateLimiter::new(1, 60, 16);
        let t0 = Instant::now();
        assert!(rl.check(v4(1, 1, 1, 1), t0).is_ok());
        assert!(rl.check(v4(1, 1, 1, 1), t0).is_err());
        assert!(rl.check(v4(2, 2, 2, 2), t0).is_ok(), "other key unaffected");
    }

    #[test]
    fn ipv6_keys_by_slash64() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:bbbb::2".parse().unwrap();
        let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(
            IpKey::from_ip(a),
            IpKey::from_ip(b),
            "same /64 shares a bucket"
        );
        assert_ne!(
            IpKey::from_ip(a),
            IpKey::from_ip(c),
            "adjacent /64 does not"
        );
    }

    #[test]
    fn v4_mapped_v6_is_v4() {
        let mapped: IpAddr = "::ffff:9.8.7.6".parse().unwrap();
        assert_eq!(IpKey::from_ip(mapped), v4(9, 8, 7, 6));
    }

    #[test]
    fn lru_bounds_memory() {
        let rl = RateLimiter::new(1, 60, 2);
        let t0 = Instant::now();
        assert!(rl.check(v4(1, 0, 0, 1), t0).is_ok());
        assert!(rl.check(v4(1, 0, 0, 2), t0).is_ok());
        assert!(rl.check(v4(1, 0, 0, 3), t0).is_ok()); // evicts key 1
        // Key 1's history is forgotten — it gets a fresh (full) bucket, i.e. allowed again.
        assert!(rl.check(v4(1, 0, 0, 1), t0).is_ok());
    }

    #[test]
    fn xff_trust_matrix() {
        let peer: SocketAddr = "10.0.0.1:9999".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "6.6.6.6, 7.7.7.7".parse().unwrap());
        assert_eq!(
            client_ip(peer, &headers, false),
            IpAddr::from([10, 0, 0, 1]),
            "untrusted: peer wins"
        );
        assert_eq!(
            client_ip(peer, &headers, true),
            IpAddr::from([7, 7, 7, 7]),
            "trusted: rightmost XFF entry"
        );
        // Garbage XFF falls back to the peer even when trusted.
        let mut bad = HeaderMap::new();
        bad.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        assert_eq!(client_ip(peer, &bad, true), IpAddr::from([10, 0, 0, 1]));
        assert_eq!(
            client_ip(peer, &HeaderMap::new(), true),
            IpAddr::from([10, 0, 0, 1])
        );
    }
}
