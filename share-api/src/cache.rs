//! Bytes-bounded in-memory LRU of blob bodies, so a hot share link (HN hug of death) is served
//! without touching the bucket. Entries are immutable by construction — the key is the content
//! hash — so there is no invalidation path at all. `Bytes` clones are refcounted; a hit copies
//! nothing.

use crate::id::BlobId;
use bytes::Bytes;
use lru::LruCache;
use std::sync::Mutex;

pub struct BlobCache {
    max_bytes: usize,
    inner: Mutex<Inner>,
}

struct Inner {
    map: LruCache<BlobId, Bytes>,
    cur_bytes: usize,
}

impl BlobCache {
    /// `max_bytes == 0` disables caching (every get misses, inserts are dropped).
    pub fn new(max_bytes: usize) -> Self {
        BlobCache {
            max_bytes,
            inner: Mutex::new(Inner {
                map: LruCache::unbounded(),
                cur_bytes: 0,
            }),
        }
    }

    pub fn get(&self, id: &BlobId) -> Option<Bytes> {
        self.inner.lock().unwrap().map.get(id).cloned()
    }

    /// Size without promoting the entry (used by HEAD, which isn't a real read).
    pub fn peek_len(&self, id: &BlobId) -> Option<u64> {
        self.inner
            .lock()
            .unwrap()
            .map
            .peek(id)
            .map(|b| b.len() as u64)
    }

    pub fn insert(&self, id: BlobId, body: Bytes) {
        if body.len() > self.max_bytes {
            return; // also covers max_bytes == 0
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.map.contains(&id) {
            return; // identical bytes by construction — nothing to update
        }
        inner.cur_bytes += body.len();
        inner.map.put(id, body);
        while inner.cur_bytes > self.max_bytes {
            let (_, evicted) = inner.map.pop_lru().expect("over budget implies non-empty");
            inner.cur_bytes -= evicted.len();
        }
        metrics::gauge!("kg_share_cache_bytes").set(inner.cur_bytes as f64);
        metrics::gauge!("kg_share_cache_entries").set(inner.map.len() as f64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> BlobId {
        BlobId([n; crate::id::ID_BYTES])
    }

    fn body(n: usize) -> Bytes {
        Bytes::from(vec![0u8; n])
    }

    #[test]
    fn byte_accounting_and_lru_eviction() {
        let cache = BlobCache::new(100);
        cache.insert(id(1), body(40));
        cache.insert(id(2), body(40));
        // Touch 1 so 2 is the LRU tail, then push it over budget.
        assert!(cache.get(&id(1)).is_some());
        cache.insert(id(3), body(40));
        assert!(cache.get(&id(2)).is_none(), "LRU tail evicted");
        assert!(cache.get(&id(1)).is_some());
        assert!(cache.get(&id(3)).is_some());
    }

    #[test]
    fn oversized_and_disabled() {
        let cache = BlobCache::new(10);
        cache.insert(id(1), body(11));
        assert!(cache.get(&id(1)).is_none(), "over-budget body never cached");
        let off = BlobCache::new(0);
        off.insert(id(2), body(1));
        assert!(off.get(&id(2)).is_none(), "max_bytes=0 disables");
    }

    #[test]
    fn peek_len_does_not_promote() {
        let cache = BlobCache::new(80);
        cache.insert(id(1), body(40));
        cache.insert(id(2), body(40));
        assert_eq!(cache.peek_len(&id(1)), Some(40), "peek sees it");
        // If peek_len() had promoted id(1), id(2) would now be the tail.
        cache.insert(id(3), body(40));
        assert!(cache.get(&id(1)).is_none(), "id(1) stayed the LRU tail");
        assert!(cache.get(&id(2)).is_some());
    }

    #[test]
    fn duplicate_insert_is_noop() {
        let cache = BlobCache::new(100);
        cache.insert(id(1), body(60));
        cache.insert(id(1), body(60));
        // If double-counted, inserting 40 more would evict id(1).
        cache.insert(id(2), body(40));
        assert!(cache.get(&id(1)).is_some());
    }
}
