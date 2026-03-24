'use strict';

/**
 * KOL Listener — polls X API for tweets from tracked KOLs.
 *
 * Extracts token mentions, records to kol-tracker for credibility scoring,
 * classifies content type, tracks engagement at checkpoints.
 *
 * Stripped: reply-loop integration, ghost-mode, composition pipeline.
 * Add your own reply/alert logic in the marked extension point.
 */

const config = require('../config');
const logger = require('../utils/logger');

let _kolTracker, _extractor, _engagementTracker, _cache, _jupiter, _contentClassifier;

function _lazyLoad() {
  if (!_kolTracker) {
    _kolTracker          = require('./kol-tracker');
    _extractor           = require('./tweet-extractor');
    _engagementTracker   = require('./engagement-tracker');
    _contentClassifier   = require('./content-type-classifier');
    try { _cache   = require('../pipeline/cache'); } catch { _cache = null; }
    try { _jupiter = require('../fetchers/jupiter'); } catch { _jupiter = null; }
  }
}

let _xClient = null;
let _pollCount = 0;
let _lastPollTime = 0;
let _mentionCount = 0;

// ── Price resolution ────────────────────────────────────────────────────────

async function _getPrice(mint) {
  // Try cache first
  if (_cache) {
    const cached = _cache.get(mint);
    if (cached?.priceUsd) return { price: cached.priceUsd, symbol: cached.symbol, score: cached.compositeScore };
  }
  // Fallback: DexScreener via jupiter.js (free, 0 CU)
  if (_jupiter) {
    try {
      const price = await _jupiter.fetchPrice(mint);
      if (price > 0) return { price, symbol: '', score: null };
    } catch { /* non-fatal */ }
  }
  return { price: null, symbol: '', score: null };
}

function isKnownMint(mint) {
  return _cache ? _cache.has(mint) : false;
}

function resolveCashtag(tag) {
  // Override with your own cashtag → mint resolution
  return null;
}

// ── Core Poll ───────────────────────────────────────────────────────────────

async function poll() {
  _lazyLoad();
  if (!_xClient) return;

  const kolProfiles = _kolTracker.getActiveKols();
  if (kolProfiles.length === 0) return;

  let mentionsFound = 0;

  try {
    // Batch fetch recent tweets from all active KOLs
    const userIds = kolProfiles.map(k => k.twitterUserId).filter(Boolean);
    const tweets = await _xClient.getRecentTweets(userIds);

    for (const tweet of tweets) {
      const kolProfile = kolProfiles.find(k => k.twitterUserId === tweet.author_id);
      if (!kolProfile) continue;

      const handle = kolProfile.handle;
      const kolId  = kolProfile.twitterUserId;

      // Classify content type + increment distribution
      try {
        const classified = _contentClassifier.classifyContentType(tweet.text);
        if (classified?.type) {
          _kolTracker.incrementContentType(kolId, classified.type);
        }
      } catch { /* non-fatal */ }

      // Learn pipeline: log only, no token extraction
      if (kolProfile.pipeline === 'learn') {
        _kolTracker.recordMention({
          kolId, mint: 'learn', symbol: 'LEARN',
          tweetId: tweet.id, tweetText: tweet.text,
          confidence: 1.0, source: 'learn_feed',
          priceAtMention: null, compositeScore: null,
        });
        mentionsFound++;
        continue;
      }

      // Extract token mentions
      const tokens = _extractor.extractTokens(tweet, { isKnownMint, resolveCashtag });

      for (const token of tokens) {
        const priceData = await _getPrice(token.mint);

        _kolTracker.recordMention({
          kolId,
          mint:            token.mint,
          symbol:          priceData.symbol || '',
          tweetId:         tweet.id,
          tweetText:       tweet.text,
          confidence:      token.confidence,
          source:          token.source,
          priceAtMention:  priceData.price,
          compositeScore:  priceData.score,
        });

        mentionsFound++;
      }

      // Schedule engagement re-reads
      if (tokens.length > 0) {
        _engagementTracker.scheduleReRead({
          tweetId:        tweet.id,
          kolId,
          mint:           tokens[0].mint,
          initialMetrics: tweet.public_metrics,
        });
      }

      // ── EXTENSION POINT ────────────────────────────────────────────────
      // Add your own logic here: alerts, reply composition, etc.
      // Example:
      //   if (tokens.length > 0 && priceData.score >= 70) {
      //     sendTelegramAlert(`@${handle} called ${tokens[0].symbol} — score ${priceData.score}`);
      //   }
      // ──────────────────────────────────────────────────────────────────
    }
  } catch (err) {
    logger.warn(`[KOL-LISTENER] Poll error: ${err.message}`);
  }

  _lastPollTime = Date.now();
  _pollCount++;
  _mentionCount += mentionsFound;

  logger.info(`[KOL-LISTENER] Poll #${_pollCount}: ${tweets?.length ?? 0} tweets, ${mentionsFound} mentions`);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let _pollTimer = null;

function start() {
  _lazyLoad();
  try {
    _xClient = require('./x-client');
    if (!_xClient.isConfigured()) {
      logger.warn('[KOL-LISTENER] X API not configured — listener disabled');
      return;
    }
  } catch {
    logger.warn('[KOL-LISTENER] x-client not available — listener disabled');
    return;
  }

  const interval = config.kol?.pollIntervalMs ?? 5 * 60 * 1000;
  _pollTimer = setInterval(() => poll().catch(() => {}), interval);
  poll().catch(() => {}); // initial poll
  logger.info(`[KOL-LISTENER] Started — polling every ${interval / 1000}s`);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function getStatus() {
  return { pollCount: _pollCount, lastPollTime: _lastPollTime, mentionCount: _mentionCount };
}

module.exports = { start, stop, poll, getStatus };
