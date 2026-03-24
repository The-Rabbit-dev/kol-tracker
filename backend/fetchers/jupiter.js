'use strict';

const config = require('../config');
const logger = require('../utils/logger');

const TIMEOUT_MS = 8_000;
const DEXSCREENER_PRICE_URL = 'https://api.dexscreener.com/tokens/v1/solana';

/**
 * Fetch spot price for a Solana mint.
 * Uses DexScreener (free, no auth). Jupiter price.jup.ag v4 is dead.
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
async function fetchPrice(mint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${DEXSCREENER_PRICE_URL}/${mint}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Returns array of pairs — pick highest-liquidity one
    const pairs = Array.isArray(data) ? data : [];
    if (pairs.length === 0) return null;
    const best = pairs.reduce((a, b) =>
      (parseFloat(b.liquidity?.usd ?? 0) > parseFloat(a.liquidity?.usd ?? 0) ? b : a)
    );
    const price = parseFloat(best.priceUsd);
    return price > 0 ? price : null;
  } catch (err) {
    logger.warn(`[price] ${mint.slice(0, 8)}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPrice };
