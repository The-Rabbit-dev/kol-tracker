'use strict';

/**
 * Engagement Tracker — Re-read tweets at checkpoints, compute velocity.
 *
 * Re-reads token-mentioning tweets at 15m/1h/4h/12h/24h after post.
 * Within same UTC day, re-reads are FREE (X API returns fresh metrics).
 *
 * Weighted engagement = likes×1 + RTs×3 + replies×1.5 + views×0.01 + quotes×2 + bookmarks×2
 * Velocity = ΔE / Δt (first hour matters most)
 * Normalized = V_60 / KOL_median_V_60 (self-calibrating per KOL)
 * Score = clamp(normalized × 25, 0, 100)
 */

const logger = require('../utils/logger');

// ── Configuration ────────────────────────────────────────────────────────────

const CHECKPOINT_MINUTES = [15, 60, 240, 720, 1440]; // 15m, 1h, 4h, 12h, 24h

// ── In-Memory State ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} tweetId -> { kolId, mint, createdAt, checkpoints[], engagement[] } */
const _queue = new Map();

/** @type {Map<string, number[]>} kolId -> array of V_60 values (for median computation) */
const _kolVelocityHistory = new Map();

let _xClient = null; // lazy-loaded
let _timer = null;

// ── Engagement Computation ───────────────────────────────────────────────────

function _weightedEngagement(metrics) {
  if (!metrics) return 0;
  return (
    (metrics.like_count ?? metrics.likes ?? 0) * 1 +
    (metrics.retweet_count ?? metrics.retweets ?? 0) * 3 +
    (metrics.reply_count ?? metrics.replies ?? 0) * 1.5 +
    (metrics.impression_count ?? metrics.views ?? 0) * 0.01 +
    (metrics.quote_count ?? metrics.quotes ?? 0) * 2 +
    (metrics.bookmark_count ?? metrics.bookmarks ?? 0) * 2
  );
}

/**
 * Compute velocity score for a tweet based on engagement checkpoints.
 *
 * @param {object} entry — queue entry with engagement[] array
 * @returns {number|null} — 0-100 score or null if insufficient data
 */
function computeVelocityScore(entry) {
  if (!entry || !entry.engagement || entry.engagement.length < 2) return null;

  // Sort by time
  const sorted = [...entry.engagement].sort((a, b) => a.ts - b.ts);

  // Calculate V_60 (engagement growth in first hour)
  const first = sorted[0];
  const atOneHour = sorted.find(e => (e.ts - first.ts) >= 55 * 60 * 1000) || sorted[sorted.length - 1];

  const deltaE = atOneHour.weighted - first.weighted;
  const deltaT = Math.max(1, (atOneHour.ts - first.ts) / (60 * 1000)); // minutes
  const v60 = deltaE / deltaT * 60; // normalized to per-hour

  // Self-calibrate: compare to KOL's median V_60
  const kolHistory = _kolVelocityHistory.get(entry.kolId) ?? [];
  let normalized;
  if (kolHistory.length >= 3) {
    const sorted = [...kolHistory].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    normalized = median > 0 ? v60 / median : (v60 > 0 ? 2.0 : 0);
  } else {
    // Not enough history — use raw V_60 with a generous scale
    normalized = v60 / 50; // assume 50 weighted engagement/hour is median
  }

  return Math.max(0, Math.min(100, Math.round(normalized * 25)));
}

// ── Queue Management ─────────────────────────────────────────────────────────

/**
 * Schedule a tweet for engagement re-reads.
 *
 * @param {object} opts
 * @param {string} opts.tweetId
 * @param {string} opts.kolId
 * @param {string} opts.mint
 * @param {object} opts.initialMetrics — public_metrics from first read
 */
function scheduleReRead(opts) {
  if (!opts?.tweetId) return;

  const now = Date.now();
  const initialWeighted = _weightedEngagement(opts.initialMetrics);

  _queue.set(opts.tweetId, {
    tweetId:   opts.tweetId,
    kolId:     opts.kolId ?? null,
    mint:      opts.mint ?? null,
    createdAt: now,
    checkpoints: CHECKPOINT_MINUTES.map(mins => ({
      minutesAfter: mins,
      dueAt:        now + mins * 60 * 1000,
      completed:    false,
    })),
    engagement: [{
      ts:       now,
      metrics:  opts.initialMetrics ?? {},
      weighted: initialWeighted,
    }],
    velocityScore: null,
  });

  logger.debug(`[ENGAGEMENT] Scheduled re-reads for tweet ${opts.tweetId} (${CHECKPOINT_MINUTES.length} checkpoints)`);
}

/**
 * Process pending re-reads. Called periodically (every 60s).
 * Batches re-reads to minimize API calls.
 */
async function processQueue() {
  if (_queue.size === 0) return;

  // Lazy-load X client
  if (!_xClient) {
    try { _xClient = require('./x-client'); } catch { return; }
  }
  if (!_xClient.hasCredentials) return;

  const now = Date.now();
  const dueIds = [];

  for (const [tweetId, entry] of _queue) {
    // Find next uncompleted checkpoint that's due
    const nextDue = entry.checkpoints.find(cp => !cp.completed && now >= cp.dueAt);
    if (nextDue) dueIds.push(tweetId);

    // Remove entries older than 25h (all checkpoints should be done)
    if (now - entry.createdAt > 25 * 60 * 60 * 1000) {
      _finalizeEntry(entry);
      _queue.delete(tweetId);
    }
  }

  if (dueIds.length === 0) return;

  // Batch fetch tweets (X API v2 supports up to 100 per request)
  try {
    const tweets = await _fetchTweetMetrics(dueIds.slice(0, 100));
    for (const tweet of tweets) {
      const entry = _queue.get(tweet.id);
      if (!entry) continue;

      const weighted = _weightedEngagement(tweet.public_metrics);
      entry.engagement.push({
        ts:       now,
        metrics:  tweet.public_metrics ?? {},
        weighted,
      });

      // Mark checkpoint(s) complete
      for (const cp of entry.checkpoints) {
        if (!cp.completed && now >= cp.dueAt) cp.completed = true;
      }

      // Compute velocity after each checkpoint
      entry.velocityScore = computeVelocityScore(entry);
    }
  } catch (err) {
    logger.warn(`[ENGAGEMENT] Batch re-read failed: ${err.message}`);
  }
}

async function _fetchTweetMetrics(tweetIds) {
  if (!_xClient || !_xClient.hasCredentials) return [];
  // Use x-client's underlying TwitterApi for lookup
  // twitter-api-v2 .v2.tweets() accepts array of IDs
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const client = new TwitterApi({
      appKey:       process.env.X_API_KEY       || '',
      appSecret:    process.env.X_API_SECRET    || '',
      accessToken:  process.env.X_ACCESS_TOKEN  || '',
      accessSecret: process.env.X_ACCESS_TOKEN_SECRET || '',
    });
    const result = await client.v2.tweets(tweetIds, {
      'tweet.fields': ['public_metrics'],
    });
    return result.data ?? [];
  } catch (err) {
    logger.warn(`[ENGAGEMENT] Tweet lookup failed: ${err.message}`);
    return [];
  }
}

function _finalizeEntry(entry) {
  if (!entry.kolId) return;

  // Record V_60 in KOL history
  const sorted = [...entry.engagement].sort((a, b) => a.ts - b.ts);
  if (sorted.length >= 2) {
    const first = sorted[0];
    const atOneHour = sorted.find(e => (e.ts - first.ts) >= 55 * 60 * 1000) || sorted[sorted.length - 1];
    const deltaE = atOneHour.weighted - first.weighted;
    const deltaT = Math.max(1, (atOneHour.ts - first.ts) / (60 * 1000));
    const v60 = deltaE / deltaT * 60;

    if (!_kolVelocityHistory.has(entry.kolId)) _kolVelocityHistory.set(entry.kolId, []);
    const history = _kolVelocityHistory.get(entry.kolId);
    history.push(v60);
    // Keep last 50 values
    if (history.length > 50) history.splice(0, history.length - 50);
  }
}

/**
 * Get velocity score for a mint (best score among active tweets).
 * @param {string} mint
 * @returns {number|null}
 */
function getVelocityScore(mint) {
  if (!mint) return null;
  const mintLower = mint.toLowerCase();
  let best = null;

  for (const entry of _queue.values()) {
    if ((entry.mint ?? '').toLowerCase() !== mintLower) continue;
    if (entry.velocityScore !== null) {
      if (best === null || entry.velocityScore > best) best = entry.velocityScore;
    }
  }
  return best;
}

/**
 * Get all queue entries (for debugging / REST endpoint).
 * @returns {object[]}
 */
function getQueueStatus() {
  return Array.from(_queue.values()).map(e => ({
    tweetId:       e.tweetId,
    kolId:         e.kolId,
    mint:          e.mint,
    checkpoints:   e.checkpoints.filter(cp => cp.completed).length + '/' + e.checkpoints.length,
    velocityScore: e.velocityScore,
    engagement:    e.engagement.length,
    age:           Math.round((Date.now() - e.createdAt) / 60000) + 'min',
  }));
}

// ── Start/Stop ───────────────────────────────────────────────────────────────

function start() {
  if (_timer) return;
  _timer = setInterval(() => processQueue().catch(err =>
    logger.warn(`[ENGAGEMENT] Queue processing error: ${err.message}`)
  ), 60_000); // every 60 seconds
  logger.info('[ENGAGEMENT] Tracker started — processing queue every 60s');
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  logger.info('[ENGAGEMENT] Tracker stopped');
}

function _reset() {
  stop();
  _queue.clear();
  _kolVelocityHistory.clear();
}

module.exports = {
  scheduleReRead,
  processQueue,
  computeVelocityScore,
  getVelocityScore,
  getQueueStatus,
  start,
  stop,
  _reset,
};
