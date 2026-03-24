'use strict';

/**
 * Tweet Extractor — Token extraction from tweet text.
 *
 * 4 confidence layers:
 *   1. Contract address (1.0) — base58 regex, validated against cache
 *   2. URL parsing (0.95) — DexScreener/Birdeye/Pump.fun/Jupiter URLs
 *   3. Cashtag (0.85) — $TAG entities resolved via cache
 *   4. Alias (0.4-0.7) — natural language names via token-aliases.json
 *
 * Pure functions — no side effects, fully testable.
 */

const fs   = require('fs');
const path = require('path');

const ALIASES_PATH = path.join(__dirname, 'token-aliases.json');

// Skip generic/major tokens — too common to be actionable
const SKIP_SYMBOLS = new Set([
  'SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'USD', 'BUSD', 'DAI',
  'WBTC', 'WETH', 'WSOL', 'JUP', 'RAY', 'ORCA',
]);

// ── Base58 contract address regex (Solana mints: 32-44 chars) ────────────────

const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// ── URL patterns that embed mint addresses ───────────────────────────────────

const URL_PATTERNS = [
  // DexScreener: dexscreener.com/solana/<mint>
  /dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi,
  // Birdeye: birdeye.so/token/<mint>
  /birdeye\.so\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi,
  // Pump.fun: pump.fun/<mint> or pump.fun/coin/<mint>
  /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/gi,
  // Jupiter: jup.ag/swap/<pair> containing mint
  /jup\.ag\/swap\/[^\/]*-([1-9A-HJ-NP-Za-km-z]{32,44})/gi,
  // Solscan: solscan.io/token/<mint>
  /solscan\.io\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _loadAliases() {
  try {
    const raw = fs.readFileSync(ALIASES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

/**
 * Extract token mentions from a single tweet.
 *
 * @param {object} tweet — { text, entities? }
 * @param {object} opts
 * @param {function} opts.isKnownMint — (mint) => boolean (validate against cache)
 * @param {function} [opts.resolveCashtag] — (symbol) => mint|null (resolve from cache)
 * @returns {Array<{ mint: string, confidence: number, source: string, raw: string }>}
 */
function extractTokens(tweet, opts = {}) {
  const { isKnownMint, resolveCashtag } = opts;
  if (!tweet) return [];
  const text = tweet.text ?? '';
  const results = [];
  const seenMints = new Set();

  // Layer 1: Contract addresses in text
  const base58Matches = text.match(BASE58_RE) || [];
  for (const match of base58Matches) {
    if (seenMints.has(match)) continue;
    // Validate: must be a known mint (in cache or watchlist)
    if (isKnownMint && isKnownMint(match)) {
      seenMints.add(match);
      results.push({ mint: match, confidence: 1.0, source: 'contract_address', raw: match });
    }
  }

  // Layer 2: URLs with embedded mint addresses
  for (const pattern of URL_PATTERNS) {
    pattern.lastIndex = 0; // reset global regex
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const mint = m[1];
      if (seenMints.has(mint)) continue;
      seenMints.add(mint);
      results.push({ mint, confidence: 0.95, source: 'url', raw: m[0] });
    }
  }

  // Layer 3: Cashtags from Twitter entities
  const cashtags = tweet.entities?.cashtags ?? [];
  for (const ct of cashtags) {
    const tag = (ct.tag ?? ct).toString().toUpperCase();
    if (SKIP_SYMBOLS.has(tag)) continue;
    if (resolveCashtag) {
      const mint = resolveCashtag(tag);
      if (mint && !seenMints.has(mint)) {
        seenMints.add(mint);
        results.push({ mint, confidence: 0.85, source: 'cashtag', raw: `$${tag}` });
      }
    }
  }

  // Also scan for $TAGS in text (not all clients populate entities)
  const cashtagRe = /\$([A-Za-z][A-Za-z0-9]{1,10})/g;
  let ctMatch;
  while ((ctMatch = cashtagRe.exec(text)) !== null) {
    const tag = ctMatch[1].toUpperCase();
    if (SKIP_SYMBOLS.has(tag)) continue;
    if (resolveCashtag) {
      const mint = resolveCashtag(tag);
      if (mint && !seenMints.has(mint)) {
        seenMints.add(mint);
        results.push({ mint, confidence: 0.85, source: 'cashtag_text', raw: ctMatch[0] });
      }
    }
  }

  // Layer 4: Alias matching (lowest confidence)
  const aliases = _loadAliases();
  const textLower = text.toLowerCase();
  for (const [alias, entry] of Object.entries(aliases)) {
    const aliasLower = alias.toLowerCase();
    if (textLower.includes(aliasLower)) {
      const mint = typeof entry === 'string' ? entry : entry.mint;
      if (!mint || seenMints.has(mint)) continue;
      seenMints.add(mint);
      const conf = typeof entry === 'object' && entry.confidence ? entry.confidence : 0.5;
      results.push({ mint, confidence: Math.min(conf, 0.7), source: 'alias', raw: alias });
    }
  }

  // Sort by confidence desc
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

/**
 * Build cashtag resolver from cached token payloads.
 * When multiple tokens share a symbol, picks highest liquidity.
 *
 * @param {object[]} cachedTokens — array of payload objects with { mint, symbol, liquidity }
 * @returns {function} (symbol: string) => mint | null
 */
function buildCashtagResolver(cachedTokens) {
  const symbolMap = new Map(); // SYMBOL -> { mint, liquidity }
  for (const t of cachedTokens) {
    if (!t.symbol || !t.mint) continue;
    const sym = t.symbol.toUpperCase();
    const existing = symbolMap.get(sym);
    if (!existing || (t.liquidity ?? 0) > (existing.liquidity ?? 0)) {
      symbolMap.set(sym, { mint: t.mint, liquidity: t.liquidity ?? 0 });
    }
  }
  return (symbol) => {
    const entry = symbolMap.get(symbol.toUpperCase());
    return entry?.mint ?? null;
  };
}

/**
 * Refresh token-aliases.json from current cache data.
 * Auto-populates name → mint mappings for alias layer.
 *
 * @param {object[]} cachedTokens — array of payload objects
 */
function refreshAliases(cachedTokens) {
  const aliases = _loadAliases();
  let changed = false;

  for (const t of cachedTokens) {
    if (!t.mint || !t.name) continue;
    const name = t.name.trim();
    if (name.length < 3) continue; // too short = too ambiguous

    if (!aliases[name]) {
      aliases[name] = { mint: t.mint, confidence: 0.5 };
      changed = true;
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(ALIASES_PATH, JSON.stringify(aliases, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }
}

module.exports = { extractTokens, buildCashtagResolver, refreshAliases, SKIP_SYMBOLS };
