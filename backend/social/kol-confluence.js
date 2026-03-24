'use strict';

/**
 * KOL Confluence — Multi-KOL attention detection.
 *
 * Multiple KOLs mentioning same token within a time window = confluence signal.
 * Weighted by tier, credibility, and time compression.
 * Pure computation — reads from kol-tracker, no side effects.
 */

const logger = require('../utils/logger');

// ── Lazy imports ─────────────────────────────────────────────────────────────

let _kolTracker;
function _lazyLoad() {
  if (!_kolTracker) _kolTracker = require('./kol-tracker');
}

// ── Configuration defaults ───────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
const TIER_WEIGHTS = { apex: 4, alpha: 2.5, mid: 1.5, meme: 1.0 };

// ── Core Computation ─────────────────────────────────────────────────────────

/**
 * Compute confluence signal for a specific token.
 *
 * @param {string} mint — token mint address
 * @param {object} [opts]
 * @param {number} [opts.windowMs] — confluence window (default 6h)
 * @param {string} [opts.pipeline] — 'meme'|'perps' to filter by KOL pipeline (hybrid matches both)
 * @returns {object|null} — { score, kolCount, weightedScore, timeCompression, mentions[] } or null
 */
function getConfluence(mint, opts = {}) {
  _lazyLoad();

  if (!mint) return null;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const cutoff = Date.now() - windowMs;

  // Get active + recent mentions for this mint (filtered by pipeline)
  const active = _kolTracker.getActiveMentions(mint, { pipeline: opts.pipeline });
  const mentions = active.filter(m => m.ts >= cutoff);

  // Need 2+ unique KOLs to fire
  const uniqueKols = new Set(mentions.map(m => m.kolId));
  if (uniqueKols.size < 2) return null;

  // Compute weighted score
  let weightedSum = 0;
  const kolDetails = [];

  for (const kolId of uniqueKols) {
    const kolMentions = mentions.filter(m => m.kolId === kolId);
    const firstMention = kolMentions.sort((a, b) => a.ts - b.ts)[0];

    const tier = firstMention.kolTier ?? 'mid';
    const tierWeight = TIER_WEIGHTS[tier] ?? 1.0;

    // Get credibility from profile
    const profile = _kolTracker.getKol(kolId);
    const credibility = profile?.credibility?.score ?? 50;

    const kolWeight = tierWeight * (credibility / 100);
    weightedSum += kolWeight;

    kolDetails.push({
      kolId,
      handle:       firstMention.kolHandle,
      tier,
      credibility,
      weight:       parseFloat(kolWeight.toFixed(3)),
      mentionTs:    firstMention.ts,
      confidence:   firstMention.confidence,
    });
  }

  // Time compression bonus: tighter clustering = stronger signal
  const timestamps = mentions.map(m => m.ts).sort((a, b) => a - b);
  const spreadMs = timestamps[timestamps.length - 1] - timestamps[0];
  const spreadH = spreadMs / (60 * 60 * 1000);

  let timeCompression = 1.0;
  if (spreadH < 1) timeCompression = 1.5;
  else if (spreadH < 3) timeCompression = 1.2;

  // Final score: weighted sum × time compression, capped at 100
  const rawScore = weightedSum * timeCompression * 15; // scale to 0-100 range
  const score = Math.min(100, Math.round(rawScore));

  return {
    score,
    kolCount:        uniqueKols.size,
    weightedScore:   parseFloat(weightedSum.toFixed(3)),
    timeCompression: parseFloat(timeCompression.toFixed(2)),
    spreadMinutes:   Math.round(spreadMs / 60000),
    mentions:        kolDetails.sort((a, b) => b.weight - a.weight),
  };
}

/**
 * Get all current confluence signals across all actively-mentioned tokens.
 * @param {object} [opts]
 * @param {string} [opts.pipeline] — 'meme'|'perps' to filter by KOL pipeline
 * @returns {object[]} — array of { mint, symbol, ...confluenceData }
 */
function getAllConfluences(opts) {
  _lazyLoad();

  const allMentions = _kolTracker.getAllActiveMentions({ pipeline: opts?.pipeline });
  const mintMap = new Map(); // mint -> symbol

  for (const m of allMentions) {
    const key = (m.mint ?? '').toLowerCase();
    if (key && !mintMap.has(key)) {
      mintMap.set(key, m.symbol ?? '');
    }
  }

  const results = [];
  for (const [mint, symbol] of mintMap) {
    const conf = getConfluence(mint, { pipeline: opts?.pipeline });
    if (conf) {
      results.push({ mint, symbol, ...conf });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

module.exports = { getConfluence, getAllConfluences };
