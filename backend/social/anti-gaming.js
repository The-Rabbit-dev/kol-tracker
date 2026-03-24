'use strict';

/**
 * Anti-Gaming — Front-run, coordination, and template language detection.
 *
 * Returns a discount multiplier (0.3-1.0) applied to KOL attention score.
 * Higher suspicion → lower multiplier → less edge confidence boost.
 *
 * Pure computation — reads from kol-tracker, no side effects.
 */

const logger = require('../utils/logger');

// ── Lazy imports ─────────────────────────────────────────────────────────────

let _kolTracker;
function _lazyLoad() {
  if (!_kolTracker) _kolTracker = require('./kol-tracker');
}

// ── Detection Functions ──────────────────────────────────────────────────────

/**
 * Detect front-running: price already moved significantly before KOL tweet.
 *
 * @param {object} mention — { priceAtMention, mint }
 * @param {object} priceHistory — { priceH1Before, priceH6Before } (from cache)
 * @returns {number} discount multiplier (0.8 if front-run detected, 1.0 otherwise)
 */
function detectFrontRun(mention, priceHistory) {
  if (!mention?.priceAtMention || !priceHistory) return 1.0;

  // Check if price moved >50% of total move BEFORE tweet
  const priceH1Before = priceHistory.priceH1Before;
  if (priceH1Before && priceH1Before > 0) {
    const preMoveH1 = (mention.priceAtMention / priceH1Before - 1);
    // If price already ran >15% in the hour before the tweet, suspicious
    if (preMoveH1 > 0.15) {
      return 0.8;
    }
  }

  const priceH6Before = priceHistory.priceH6Before;
  if (priceH6Before && priceH6Before > 0) {
    const preMoveH6 = (mention.priceAtMention / priceH6Before - 1);
    // If price already ran >50% in 6h before tweet, very suspicious
    if (preMoveH6 > 0.50) {
      return 0.7;
    }
  }

  return 1.0;
}

/**
 * Detect coordinated mentions: multiple KOLs posting within tight window.
 *
 * @param {string} mint — token mint
 * @param {number} [windowMinutes=5] — coordination detection window
 * @returns {number} discount multiplier (0.7-0.8 if coordinated, 1.0 otherwise)
 */
function detectCoordination(mint, windowMinutes = 5) {
  _lazyLoad();

  if (!mint) return 1.0;
  const mentions = _kolTracker.getActiveMentions(mint);
  if (mentions.length < 3) return 1.0;

  const windowMs = windowMinutes * 60 * 1000;

  // Check for tight clustering (3+ KOLs within window)
  const sorted = [...mentions].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i <= sorted.length - 3; i++) {
    const window = sorted.slice(i, i + 3);
    const spread = window[window.length - 1].ts - window[0].ts;
    if (spread <= windowMs) {
      const uniqueKols = new Set(window.map(m => m.kolId));
      if (uniqueKols.size >= 3) {
        // Check co-occurrence history between these KOLs
        const coOccRate = _getCoOccurrenceRate(Array.from(uniqueKols));
        if (coOccRate > 0.50) return 0.7;
        return 0.8;
      }
    }
  }

  return 1.0;
}

/**
 * Get historical co-occurrence rate between a set of KOLs.
 * High rate = they always shill together = suspicious.
 *
 * @param {string[]} kolIds
 * @returns {number} 0-1 co-occurrence rate
 */
function _getCoOccurrenceRate(kolIds) {
  _lazyLoad();

  if (kolIds.length < 2) return 0;

  // Read recent mentions (30 days)
  const allMentions = _kolTracker.readMentions(30);

  // Group mentions by mint
  const mintToKols = new Map(); // mint -> Set of kolIds
  for (const m of allMentions) {
    if (!m.mint) continue;
    const key = m.mint.toLowerCase();
    if (!mintToKols.has(key)) mintToKols.set(key, new Set());
    mintToKols.get(key).add(m.kolId);
  }

  // Count how often these specific KOLs appear together
  let togetherCount = 0;
  let anyAppearCount = 0;

  for (const kols of mintToKols.values()) {
    const matchCount = kolIds.filter(id => kols.has(id)).length;
    if (matchCount > 0) anyAppearCount++;
    if (matchCount >= kolIds.length) togetherCount++;
  }

  return anyAppearCount > 0 ? togetherCount / anyAppearCount : 0;
}

/**
 * Detect template language: KOLs using suspiciously similar text.
 *
 * @param {string} mint — token mint
 * @returns {number} discount multiplier (0.9 if template detected, 1.0 otherwise)
 */
function detectTemplateLanguage(mint) {
  _lazyLoad();

  if (!mint) return 1.0;
  const mentions = _kolTracker.getActiveMentions(mint);
  if (mentions.length < 2) return 1.0;

  // Get tweet texts
  const texts = mentions.map(m => m.tweetText ?? '').filter(t => t.length > 20);
  if (texts.length < 2) return 1.0;

  // Simple bigram overlap check
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const overlap = _bigramOverlap(texts[i], texts[j]);
      if (overlap > 0.60) return 0.9;
    }
  }

  return 1.0;
}

/**
 * Compute bigram overlap between two texts.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1 overlap ratio
 */
function _bigramOverlap(a, b) {
  const bigramsA = _getBigrams(a.toLowerCase());
  const bigramsB = _getBigrams(b.toLowerCase());
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let overlap = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) overlap++;
  }

  return overlap / Math.max(bigramsA.size, bigramsB.size);
}

function _getBigrams(text) {
  const words = text.split(/\s+/).filter(w => w.length > 1);
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

/**
 * Detect low-credibility swarm: 3+ mentions but all from low-cred KOLs.
 *
 * @param {string} mint
 * @returns {number} discount multiplier (0.6 if swarm detected, 1.0 otherwise)
 */
function detectLowCredSwarm(mint) {
  _lazyLoad();

  if (!mint) return 1.0;
  const mentions = _kolTracker.getActiveMentions(mint);
  if (mentions.length < 3) return 1.0;

  const uniqueKols = new Set(mentions.map(m => m.kolId));
  if (uniqueKols.size < 3) return 1.0;

  // Check if ALL mentioning KOLs have credibility < 40
  let allLowCred = true;
  for (const kolId of uniqueKols) {
    const profile = _kolTracker.getKol(kolId);
    if (profile && (profile.credibility?.score ?? 50) >= 40) {
      allLowCred = false;
      break;
    }
  }

  return allLowCred ? 0.6 : 1.0;
}

/**
 * Compute combined anti-gaming discount for a token.
 * Multiplies all individual detection results.
 *
 * @param {string} mint
 * @param {object} [context] — { priceHistory, pipeline } for front-run detection + pipeline filter
 * @returns {{ discount: number, signals: string[] }}
 */
function computeDiscount(mint, context = {}) {
  _lazyLoad();

  const mentions = _kolTracker.getActiveMentions(mint, { pipeline: context.pipeline });
  if (!mentions || mentions.length === 0) return { discount: 1.0, signals: [] };

  const signals = [];
  let discount = 1.0;

  // Front-run (check best/most recent mention)
  if (context.priceHistory) {
    const bestMention = mentions.sort((a, b) => b.confidence - a.confidence)[0];
    const fr = detectFrontRun(bestMention, context.priceHistory);
    if (fr < 1.0) { discount *= fr; signals.push('FRONT_RUN'); }
  }

  // Coordination
  const coord = detectCoordination(mint);
  if (coord < 1.0) { discount *= coord; signals.push('COORDINATION'); }

  // Template language
  const template = detectTemplateLanguage(mint);
  if (template < 1.0) { discount *= template; signals.push('TEMPLATE'); }

  // Low-credibility swarm
  const swarm = detectLowCredSwarm(mint);
  if (swarm < 1.0) { discount *= swarm; signals.push('LOW_CRED_SWARM'); }

  // Floor at 0.3
  discount = Math.max(0.3, discount);

  return {
    discount: parseFloat(discount.toFixed(3)),
    signals,
  };
}

module.exports = {
  detectFrontRun,
  detectCoordination,
  detectTemplateLanguage,
  detectLowCredSwarm,
  computeDiscount,
};
