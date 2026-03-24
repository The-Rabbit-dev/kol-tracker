'use strict';

const config = require('../config');
const logger = require('../utils/logger');

const BASE = config.dexscreener.baseUrl;
const TIMEOUT_MS = 10_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch trending Solana tokens from DexScreener.
 * Returns an array of raw pair objects (max config.dexscreener.topN).
 */
async function fetchTrending() {
  let data;
  try {
    data = await fetchJson(`${BASE}${config.dexscreener.boostsUrl}`);
  } catch (err) {
    logger.warn('DexScreener boosts failed, trying profiles:', err.message);
    data = await fetchJson(`${BASE}${config.dexscreener.profilesUrl}`);
  }

  // Both endpoints return arrays of token objects
  const tokens = Array.isArray(data) ? data : (data.pairs ?? []);

  return tokens
    .filter(t => (t.chainId ?? t.chain) === 'solana')
    .slice(0, config.dexscreener.topN);
}

/**
 * Fetch full pair data (price, liquidity, volume, market cap) for a mint.
 * Returns the best (highest-liquidity) Solana pair, or null.
 */
async function fetchPairData(mint) {
  try {
    const data = await fetchJson(`${BASE}${config.dexscreener.pairsUrl}/${mint}`);
    const pairs = data.pairs ?? [];
    const solanaPairs = pairs.filter(p => p.chainId === 'solana');
    if (!solanaPairs.length) return null;
    // Pick the pair with highest liquidity
    return solanaPairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
  } catch (err) {
    logger.warn(`DexScreener pair fetch failed for ${mint}:`, err.message);
    return null;
  }
}

/**
 * Extract OHLCV candles from a pair object.
 * DexScreener doesn't expose a dedicated candles endpoint publicly, so we
 * synthesize a single synthetic candle from the pair's priceChange windows.
 *
 * For real OHLCV we need an alternative source (Birdeye).
 * Returns an array of candle objects: { time, open, high, low, close, volume }
 */
function extractCandles(pair) {
  if (!pair) return [];
  const price = parseFloat(pair.priceUsd ?? '0');
  const vol24h = pair.volume?.h24 ?? 0;

  // Build synthetic candles using the available priceChange windows.
  // This gives the TA engine something to work with in the MVP even without
  // a real OHLCV endpoint.
  const windows = [
    { label: 'h24', price5mAgo: price / (1 + (pair.priceChange?.h24 ?? 0) / 100) },
    { label: 'h6',  price5mAgo: price / (1 + (pair.priceChange?.h6  ?? 0) / 100) },
    { label: 'h1',  price5mAgo: price / (1 + (pair.priceChange?.h1  ?? 0) / 100) },
    { label: 'm5',  price5mAgo: price / (1 + (pair.priceChange?.m5  ?? 0) / 100) },
  ];

  const candles = windows.map((w, i) => {
    const open  = w.price5mAgo;
    const close = price;
    return {
      time:   Date.now() - (windows.length - i) * 5 * 60 * 1000,
      open:   isFinite(open) ? open : price,
      high:   Math.max(open, close) * 1.01, // Synthetic ±1% wicks — prevents zero-width candles on flat price windows
      low:    Math.min(open, close) * 0.99,
      close,
      volume: vol24h / windows.length,
    };
  });

  return candles;
}

/**
 * Normalize a trending token entry into a minimal TokenData stub.
 * The stub is later enriched by other fetchers.
 */
function normalizeTrendingEntry(entry, rank) {
  // Boosts response shape differs from profiles
  const mint    = entry.tokenAddress ?? entry.address ?? '';
  const name    = entry.name ?? entry.description?.slice(0, 20) ?? 'Unknown';
  const symbol  = entry.symbol ?? '???';
  const icon    = entry.icon ?? entry.url ?? '';
  const pairCreatedAt = entry.pairCreatedAt ?? null;

  return {
    mint,
    name,
    symbol,
    icon,
    pairCreatedAt,
    trendingRank: rank + 1,
    // Fields filled by fetchPairData
    priceUsd:    null,
    priceChange: {},
    liquidity:   null,
    marketCap:   null,
    volume:      {},
    // Fields from analysis
    candles:     [],
    holderCount: null,
    tokenAge:    null,
  };
}

module.exports = { fetchTrending, fetchPairData, extractCandles, normalizeTrendingEntry };
