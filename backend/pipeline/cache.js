'use strict';

const config    = require('../config');
const logger    = require('../utils/logger');
const watchlist = require('./watchlist');

// TTL = 3× discovery interval (15 min default)
const TOKEN_TTL_MS = config.discoveryIntervalMs * 3;

/** Returns true if a cache entry has exceeded its TTL. */
function _isExpired(entry) {
  return Date.now() - entry.updatedAt > TOKEN_TTL_MS;
}

/** Normalize mint to lowercase — prevents casing mismatches creating duplicate cache entries */
function _norm(mint) {
  return typeof mint === 'string' ? mint.toLowerCase() : mint;
}

class TokenCache {
  constructor() {
    /** @type {Map<string, { payload: object, updatedAt: number }>} */
    this._store = new Map();
  }

  /**
   * Upsert a token payload. Keyed by normalized mint address.
   * @param {string} mint
   * @param {object} payload  — full TokenPayload object
   */
  set(mint, payload) {
    const key = _norm(mint);
    // Keep the original-case mint on the payload — external APIs (Birdeye) need it.
    // The Map key is lowercase for dedup only.
    this._store.set(key, { payload, updatedAt: Date.now() });
  }

  /**
   * Get a cached token payload by mint.
   * @param {string} mint
   * @returns {object|null}
   */
  get(mint) {
    const key = _norm(mint);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (_isExpired(entry)) {
      this._store.delete(key);
      return null;
    }
    return entry.payload;
  }

  /**
   * Check whether a mint is currently tracked.
   */
  has(mint) {
    return this.get(_norm(mint)) !== null;
  }

  /**
   * Delete a token from cache.
   */
  delete(mint) {
    this._store.delete(_norm(mint));
  }

  /**
   * All currently valid (non-expired) payloads, sorted by composite score desc.
   * @returns {object[]}
   */
  all() {
    const results = [];
    for (const [mint, entry] of this._store) {
      if (_isExpired(entry)) {
        this._store.delete(mint);
        continue;
      }
      results.push(entry.payload);
    }
    results.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
    return results;
  }

  /**
   * Number of live (non-expired) tokens currently tracked.
   */
  get size() {
    let count = 0;
    for (const entry of this._store.values()) {
      if (!_isExpired(entry)) count++;
    }
    return count;
  }

  /**
   * Evict all entries older than TOKEN_TTL_MS. Called periodically.
   */
  evictStale() {
    let evicted = 0;
    for (const [mint, entry] of this._store) {
      if (_isExpired(entry)) {
        this._store.delete(mint);
        evicted++;
      }
    }
    if (evicted > 0) logger.debug(`Cache: evicted ${evicted} stale tokens`);
  }

  /**
   * Trim cache to maxTrackedTokens by dropping lowest-scored entries.
   * @param {function} [onRemove] — called with each removed mint for client sync
   */
  trim(onRemove) {
    const all = this.all(); // evicts expired, sorted by score desc
    if (all.length <= config.maxTrackedTokens) return;

    const nonWatchlist = all.filter(p => !watchlist.has(p.mint));
    const watchlistCount = all.length - nonWatchlist.length;
    const discoveryReserve = config.discoveryReserveSlots || 10;
    const keepSlots = Math.max(discoveryReserve, config.maxTrackedTokens - watchlistCount);

    // Sub-trading-mcap tokens sort to the bottom — evicted first to free slots
    // for tokens that can actually trade.
    const minMcap = config.trading?.minMarketCapEntry ?? 0;
    nonWatchlist.sort((a, b) => {
      const aBelow = minMcap > 0 && (a.marketCap ?? 0) < minMcap ? 1 : 0;
      const bBelow = minMcap > 0 && (b.marketCap ?? 0) < minMcap ? 1 : 0;
      if (aBelow !== bBelow) return aBelow - bBelow;  // tradeable first
      return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);  // then by score
    });
    const toRemove = nonWatchlist.slice(keepSlots);

    for (const p of toRemove) {
      this._store.delete(_norm(p.mint));
      if (onRemove) onRemove(p.mint);
    }
    if (toRemove.length > 0) {
      logger.debug(`Cache: trimmed ${toRemove.length} tokens → ${this._store.size} tracked (${watchlistCount} pinned)`);
    }
  }
}

module.exports = new TokenCache();
