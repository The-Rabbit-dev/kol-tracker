'use strict';

/**
 * KOL Tracker — Registry, credibility scoring, mention tracking, outcome measurement.
 *
 * Pattern: in-memory Map + periodic persistence (follows microstructure-tracker.js).
 * Mention log: append-only JSONL (follows decision-log.js).
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

const PROFILES_PATH = path.join(__dirname, 'kol-profiles.json');
const LOGS_DIR      = path.join(__dirname, '..', 'logs');

// ── KOL Tier weights (for confluence scoring) ────────────────────────────────

const TIER_WEIGHTS = { apex: 4, alpha: 2.5, mid: 1.5, meme: 1.0 };

// ── In-Memory State ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} kolId -> profile */
const _profiles = new Map();

/** @type {Map<string, object[]>} mint (lowercase) -> [{ kolId, ts, tweetId, price, confidence, ... }] */
const _activeMentions = new Map();

const MAX_ACTIVE_MENTIONS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _dateStr(date) {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function _mentionLogPath(date) {
  return path.join(LOGS_DIR, `kol-mentions-${_dateStr(date)}.jsonl`);
}

function _persistMention(record) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(_mentionLogPath(), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    logger.warn(`[KOL-TRACKER] Mention log write error: ${err.message}`);
  }
}

// ── Profile Management ───────────────────────────────────────────────────────

function _loadProfiles() {
  try {
    const raw = fs.readFileSync(PROFILES_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, profile] of Object.entries(data)) {
      _profiles.set(id, profile);
    }
    logger.info(`[KOL-TRACKER] Loaded ${_profiles.size} KOL profiles`);
  } catch {
    logger.info('[KOL-TRACKER] No existing profiles — starting fresh');
  }
}

function _saveProfiles() {
  try {
    const obj = {};
    for (const [id, p] of _profiles) obj[id] = p;
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[KOL-TRACKER] Profile save error: ${err.message}`);
  }
}

/**
 * Add or update a KOL profile.
 * @param {object} profile — { twitterUserId, handle, displayName, tier, focusTags[], ... }
 * @returns {object} the stored profile
 */
function addKol(profile) {
  const id = profile.twitterUserId ?? profile.handle;
  if (!id) throw new Error('twitterUserId or handle required');

  const existing = _profiles.get(id) ?? {};
  const merged = {
    twitterUserId:   profile.twitterUserId ?? existing.twitterUserId ?? id,
    handle:          profile.handle ?? existing.handle ?? '',
    displayName:     profile.displayName ?? existing.displayName ?? '',
    verified:        profile.verified ?? existing.verified ?? false,
    verifiedType:    profile.verifiedType ?? existing.verifiedType ?? null,
    followerCount:   profile.followerCount ?? existing.followerCount ?? 0,
    accountCreatedAt: profile.accountCreatedAt ?? existing.accountCreatedAt ?? null,
    tier:            profile.tier ?? existing.tier ?? 'mid',
    pipeline:        profile.pipeline ?? existing.pipeline ?? 'meme', // 'meme'|'perps'|'hybrid'
    focusTags:       profile.focusTags ?? existing.focusTags ?? [],
    active:          profile.active ?? existing.active ?? true,
    addedAt:         existing.addedAt ?? Date.now(),
    credibility: existing.credibility ?? {
      score: 50, wr7d: null, wr30d: null, wr90d: null,
      avgReturnPct: null, deletionRate: 0, sampleConfidence: 0,
    },
    gaming: existing.gaming ?? {
      frontRunRate: 0, coOccurrenceScore: 0, gamingRisk: 0,
    },
    stats: existing.stats ?? {
      totalCalls: 0, wins: 0, losses: 0, pending: 0,
      lastCallAt: null,
    },
  };

  _profiles.set(id, merged);
  _saveProfiles();
  logger.info(`[KOL-TRACKER] ${existing.handle ? 'Updated' : 'Added'} KOL: @${merged.handle} (${merged.tier})`);
  return merged;
}

/**
 * Remove a KOL from tracking.
 * @param {string} kolId — twitterUserId or handle
 * @returns {boolean}
 */
function removeKol(kolId) {
  const deleted = _profiles.delete(kolId);
  if (deleted) _saveProfiles();
  return deleted;
}

/**
 * Get a single KOL profile.
 * @param {string} kolId
 * @returns {object|null}
 */
function getKol(kolId) {
  return _profiles.get(kolId) ?? null;
}

/**
 * Get all KOL profiles.
 * @returns {object[]}
 */
function getAllKols() {
  return Array.from(_profiles.values());
}

/**
 * Get active KOLs (for polling).
 * @returns {object[]}
 */
function getActiveKols() {
  return Array.from(_profiles.values()).filter(p => p.active);
}

// ── Mention Tracking ─────────────────────────────────────────────────────────

/**
 * Record a KOL mention of a token.
 *
 * @param {object} mention
 * @param {string} mention.kolId — KOL identifier
 * @param {string} mention.mint — token mint address
 * @param {string} mention.symbol — token symbol
 * @param {string} mention.tweetId — source tweet ID
 * @param {string} mention.tweetText — tweet text snippet
 * @param {number} mention.confidence — extraction confidence (0-1)
 * @param {string} mention.source — extraction layer (contract_address/url/cashtag/alias)
 * @param {number} mention.priceAtMention — current price at mention time
 * @param {number} [mention.compositeScore] — token score at mention time
 */
function recordMention(mention) {
  if (!mention?.kolId || !mention?.mint) return;

  const kolProfile = _profiles.get(mention.kolId);
  if (!kolProfile) {
    logger.debug(`[KOL-TRACKER] Ignoring mention from unknown KOL: ${mention.kolId}`);
    return;
  }

  const mintKey = mention.mint.toLowerCase();
  const record = {
    kolId:            mention.kolId,
    kolHandle:        kolProfile.handle,
    kolTier:          kolProfile.tier,
    kolPipeline:      kolProfile.pipeline ?? 'meme',
    mint:             mention.mint,
    symbol:           mention.symbol ?? '',
    tweetId:          mention.tweetId ?? null,
    tweetText:        (mention.tweetText ?? '').slice(0, 200),
    confidence:       mention.confidence ?? 0,
    source:           mention.source ?? 'unknown',
    priceAtMention:   mention.priceAtMention ?? null,
    compositeScore:   mention.compositeScore ?? null,
    ts:               Date.now(),
    // Outcome tracking — filled later by updateMentionPrice()
    peak24h:          null,
    nadir24h:         null,
    peak48h:          null,
    priceAt24h:       null,
    priceAt48h:       null,
    outcome:          null, // 'win'|'loss'|'pending'
    returnPct:        null,
  };

  // Store in active mentions (in-memory)
  if (!_activeMentions.has(mintKey)) _activeMentions.set(mintKey, []);
  _activeMentions.get(mintKey).push(record);

  // Trim if over limit
  _trimActiveMentions();

  // Update KOL stats
  kolProfile.stats.totalCalls++;
  kolProfile.stats.pending++;
  kolProfile.stats.lastCallAt = Date.now();
  _saveProfiles();

  // Persist to JSONL
  _persistMention(record);

  logger.info(`[KOL-TRACKER] @${kolProfile.handle} mentioned ${mention.symbol ?? mintKey} (conf=${mention.confidence})`);
}

/**
 * Update price tracking for all active mentions of a given mint.
 * Called every enrichment cycle (20s) from runner.js.
 *
 * @param {string} mint
 * @param {number} price — current price
 */
function updateMentionPrice(mint, price) {
  if (!mint || !price || price <= 0) return;
  const mintKey = mint.toLowerCase();
  const mentions = _activeMentions.get(mintKey);
  if (!mentions || mentions.length === 0) return;

  const now = Date.now();
  const toRemove = [];

  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    if (!m.priceAtMention || m.priceAtMention <= 0) continue;
    if (m.outcome && m.outcome !== 'pending') continue; // already finalized

    const ageMs = now - m.ts;
    const ageH  = ageMs / (60 * 60 * 1000);

    // Track peak/nadir
    if (m.peak24h === null || price > m.peak24h) m.peak24h = price;
    if (m.nadir24h === null || price < m.nadir24h) m.nadir24h = price;

    if (ageH >= 24) {
      if (m.priceAt24h === null) m.priceAt24h = price;
      if (m.peak48h === null || price > m.peak48h) m.peak48h = price;
    }

    // Outcome evaluation at 48h
    if (ageH >= 48 && m.outcome !== 'win' && m.outcome !== 'loss') {
      const peakReturn = ((m.peak24h ?? price) / m.priceAtMention - 1);
      const nadirReturn = ((m.nadir24h ?? price) / m.priceAtMention - 1);

      m.priceAt48h = price;
      m.returnPct = peakReturn;

      // Win: peak ≥ 15% AND nadir > -25%
      if (peakReturn >= 0.15 && nadirReturn > -0.25) {
        m.outcome = 'win';
      } else {
        m.outcome = 'loss';
      }

      // Update KOL credibility
      _updateKolOutcome(m.kolId, m.outcome);
      toRemove.push(i);
    }
  }

  // Remove finalized mentions (iterate in reverse to preserve indices)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    const finalized = mentions.splice(toRemove[i], 1)[0];
    // Persist final record
    _persistMention({ ...finalized, action: 'OUTCOME' });
  }

  // Clean up empty mint entries
  if (mentions.length === 0) _activeMentions.delete(mintKey);
}

function _updateKolOutcome(kolId, outcome) {
  const profile = _profiles.get(kolId);
  if (!profile) return;

  profile.stats.pending = Math.max(0, (profile.stats.pending ?? 0) - 1);
  if (outcome === 'win') profile.stats.wins++;
  else profile.stats.losses++;

  // Recalculate rolling credibility
  _refreshCredibility(kolId);
  _saveProfiles();
}

// ── Credibility Scoring ──────────────────────────────────────────────────────

/**
 * Refresh credibility score for a KOL based on outcome history.
 * @param {string} kolId
 */
function _refreshCredibility(kolId) {
  const profile = _profiles.get(kolId);
  if (!profile) return;

  const mentions = readMentions(90); // 90 days of history
  const kolMentions = mentions.filter(m =>
    m.kolId === kolId && m.action === 'OUTCOME' && (m.outcome === 'win' || m.outcome === 'loss')
  );

  if (kolMentions.length === 0) {
    profile.credibility.score = 50; // neutral
    profile.credibility.sampleConfidence = 0;
    return;
  }

  const now = Date.now();

  // Rolling WR by window
  const windows = [
    { key: 'wr7d',  days: 7,  weight: 0.25 },
    { key: 'wr30d', days: 30, weight: 0.40 },
    { key: 'wr90d', days: 90, weight: 0.15 },
  ];

  let weightedWR = 0;
  let wrWeightSum = 0;

  for (const w of windows) {
    const cutoff = now - w.days * 86400000;
    const inWindow = kolMentions.filter(m => m.ts >= cutoff);
    if (inWindow.length === 0) {
      profile.credibility[w.key] = null;
      continue;
    }
    const wr = inWindow.filter(m => m.outcome === 'win').length / inWindow.length;
    profile.credibility[w.key] = parseFloat(wr.toFixed(4));
    weightedWR += wr * w.weight;
    wrWeightSum += w.weight;
  }

  // Average return (weight 0.20)
  const withReturn = kolMentions.filter(m => m.returnPct != null);
  if (withReturn.length > 0) {
    const avgReturn = withReturn.reduce((s, m) => s + m.returnPct, 0) / withReturn.length;
    profile.credibility.avgReturnPct = parseFloat(avgReturn.toFixed(4));
    // Convert return to WR-like score: 0% = 0.5, +30% = 1.0, -30% = 0.0
    const returnScore = Math.max(0, Math.min(1, 0.5 + avgReturn / 0.60));
    weightedWR += returnScore * 0.20;
    wrWeightSum += 0.20;
  }

  // Deletion penalty (not implemented yet — placeholder)
  const deletionPenalty = Math.max(0.5, 1.0 - (profile.credibility.deletionRate ?? 0) * 5);

  // Sample confidence: min(1.0, calls_30d / 10)
  const calls30d = kolMentions.filter(m => m.ts >= now - 30 * 86400000).length;
  profile.credibility.sampleConfidence = Math.min(1.0, calls30d / 10);

  // Recency decay: weight recent calls more
  // (already handled by rolling windows)

  // Final score: 0-100
  const baseScore = wrWeightSum > 0 ? (weightedWR / wrWeightSum) * 100 : 50;
  profile.credibility.score = Math.round(
    baseScore * deletionPenalty * Math.max(0.3, profile.credibility.sampleConfidence)
  );
}

/**
 * Refresh credibility for all KOLs. Called periodically.
 */
function refreshAllCredibility() {
  for (const kolId of _profiles.keys()) {
    _refreshCredibility(kolId);
  }
  _saveProfiles();
  logger.debug(`[KOL-TRACKER] Refreshed credibility for ${_profiles.size} KOLs`);
}

// ── Mention Queries ──────────────────────────────────────────────────────────

/**
 * Check whether a KOL's pipeline matches the requested context.
 * 'hybrid' KOLs match both 'meme' and 'perps'.
 * @param {string} kolPipeline — the KOL's pipeline tag
 * @param {string} filterPipeline — 'meme'|'perps'|null (null = all)
 * @returns {boolean}
 */
function _pipelineMatch(kolPipeline, filterPipeline) {
  if (!filterPipeline) return true; // no filter = all
  if (kolPipeline === 'hybrid') return true; // hybrids match everything
  return kolPipeline === filterPipeline;
}

/**
 * Get active (in-flight) mentions for a mint.
 * @param {string} mint
 * @param {object} [opts]
 * @param {string} [opts.pipeline] — 'meme'|'perps' to filter by KOL pipeline (hybrid matches both)
 * @returns {object[]}
 */
function getActiveMentions(mint, opts) {
  if (!mint) return [];
  const all = _activeMentions.get(mint.toLowerCase()) ?? [];
  const pipeline = opts?.pipeline;
  if (!pipeline) return all;
  return all.filter(m => _pipelineMatch(m.kolPipeline ?? 'meme', pipeline));
}

/**
 * Get all active mentions across all mints.
 * @param {object} [opts]
 * @param {string} [opts.pipeline] — 'meme'|'perps' to filter by KOL pipeline
 * @returns {object[]}
 */
function getAllActiveMentions(opts) {
  const result = [];
  const pipeline = opts?.pipeline;
  for (const mentions of _activeMentions.values()) {
    for (const m of mentions) {
      if (!pipeline || _pipelineMatch(m.kolPipeline ?? 'meme', pipeline)) {
        result.push(m);
      }
    }
  }
  return result.sort((a, b) => b.ts - a.ts);
}

/**
 * Get recent mentions for a specific mint (from JSONL log).
 * @param {string} mint
 * @param {number} [days=7]
 * @returns {object[]}
 */
function getMentionsForMint(mint, days = 7) {
  if (!mint) return [];
  const all = readMentions(days);
  const mintKey = mint.toLowerCase();
  return all.filter(m => (m.mint ?? '').toLowerCase() === mintKey);
}

/**
 * Read historical mention records from JSONL logs.
 * @param {number} [days=7]
 * @returns {object[]}
 */
function readMentions(days = 7) {
  const results = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const file = _mentionLogPath(d);
    if (!fs.existsSync(file)) continue;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { results.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }
  return results;
}

/**
 * Get KOL leaderboard sorted by credibility score.
 * @returns {object[]}
 */
function getLeaderboard() {
  return Array.from(_profiles.values())
    .sort((a, b) => (b.credibility?.score ?? 0) - (a.credibility?.score ?? 0))
    .map(p => ({
      kolId:        p.twitterUserId,
      handle:       p.handle,
      displayName:  p.displayName,
      tier:         p.tier,
      credibility:  p.credibility?.score ?? 0,
      wr30d:        p.credibility?.wr30d,
      totalCalls:   p.stats?.totalCalls ?? 0,
      wins:         p.stats?.wins ?? 0,
      losses:       p.stats?.losses ?? 0,
      sampleConf:   p.credibility?.sampleConfidence ?? 0,
      gamingRisk:   p.gaming?.gamingRisk ?? 0,
    }));
}

// ── Maintenance ──────────────────────────────────────────────────────────────

function _trimActiveMentions() {
  let total = 0;
  for (const mentions of _activeMentions.values()) total += mentions.length;
  if (total <= MAX_ACTIVE_MENTIONS) return;

  // Remove oldest mentions first
  const allEntries = [];
  for (const [mint, mentions] of _activeMentions) {
    for (const m of mentions) allEntries.push({ mint, m });
  }
  allEntries.sort((a, b) => a.m.ts - b.m.ts);

  const toRemove = total - MAX_ACTIVE_MENTIONS;
  for (let i = 0; i < toRemove; i++) {
    const { mint, m } = allEntries[i];
    const arr = _activeMentions.get(mint);
    if (arr) {
      const idx = arr.indexOf(m);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) _activeMentions.delete(mint);
    }
  }
}

// ── Restore active mentions from JSONL logs ─────────────────────────────────
// On startup, scan recent mention logs (past 3 days covers 48h window + buffer)
// and rebuild _activeMentions for any non-finalized mentions.

function _restoreActiveMentions() {
  const restored = { total: 0, skipped: 0 };
  const now = Date.now();
  const WINDOW_MS = 72 * 60 * 60 * 1000; // 3 days

  for (let i = 3; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const file = _mentionLogPath(d);
    if (!fs.existsSync(file)) continue;

    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);

          // Skip OUTCOME records (already finalized)
          if (record.action === 'OUTCOME') { restored.skipped++; continue; }

          // Skip if already resolved
          if (record.outcome === 'win' || record.outcome === 'loss') { restored.skipped++; continue; }

          // Skip if older than 72h (well past 48h outcome window)
          if (!record.ts || (now - record.ts) > WINDOW_MS) { restored.skipped++; continue; }

          // Skip if no mint or no price
          if (!record.mint || !record.priceAtMention) { restored.skipped++; continue; }

          const mintKey = record.mint.toLowerCase();

          // Dedup — don't re-add if same kolId + tweetId already in active
          if (_activeMentions.has(mintKey)) {
            const existing = _activeMentions.get(mintKey);
            const dupe = existing.some(m =>
              m.tweetId && record.tweetId && m.tweetId === record.tweetId && m.kolId === record.kolId
            );
            if (dupe) { restored.skipped++; continue; }
          }

          // Restore into active mentions
          if (!_activeMentions.has(mintKey)) _activeMentions.set(mintKey, []);
          _activeMentions.get(mintKey).push(record);
          restored.total++;
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  if (restored.total > 0) {
    logger.info(`[KOL-TRACKER] Restored ${restored.total} active mentions from logs (${restored.skipped} skipped)`);
  }
}

// ── Earned Labels: Content Distribution + Archetype ─────────────────────────

/**
 * Increment content type counter on a KOL profile.
 * Called from kol-listener on every ingested tweet.
 * Recomputes archetype every 50 tweets.
 */
function incrementContentType(kolId, contentType) {
  const profile = _profiles.get(kolId);
  if (!profile || !contentType) return;

  if (!profile.contentDistribution) profile.contentDistribution = {};
  profile.contentDistribution[contentType] = (profile.contentDistribution[contentType] || 0) + 1;
  profile.totalTweetsClassified = (profile.totalTweetsClassified || 0) + 1;

  // Recompute archetype every 50 tweets
  if (profile.totalTweetsClassified >= 50 && profile.totalTweetsClassified % 50 === 0) {
    _computeArchetype(kolId);
  }

  _saveProfiles();
}

function _computeArchetype(kolId) {
  const profile = _profiles.get(kolId);
  if (!profile) return;

  const dist = profile.contentDistribution || {};
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  if (total < 50) return;

  const pct = {};
  for (const [k, v] of Object.entries(dist)) pct[k] = v / total;

  const humor    = (pct.meme_humor || 0) + (pct.personal || 0);
  const calling  = (pct.token_call || 0);
  const analysis = (pct.token_call || 0) + (pct.market_commentary || 0);
  const philo    = (pct.philosophy || 0);

  if (humor > 0.6)       profile.archetype = 'SHITPOSTER';
  else if (humor > 0.4)  profile.archetype = 'ENTERTAINER';
  else if (calling > 0.5) profile.archetype = 'CALLER';
  else if (analysis > 0.4) profile.archetype = 'ANALYST';
  else if (philo > 0.25)  profile.archetype = 'PHILOSOPHER';
  else                     profile.archetype = 'MIXED';

  profile.archetypeComputedAt = Date.now();
  logger.info(`[KOL-TRACKER] Archetype computed for @${profile.handle}: ${profile.archetype} (${total} tweets)`);
}

// ── Init ─────────────────────────────────────────────────────────────────────

_loadProfiles();
_restoreActiveMentions();

// ── Test helpers ─────────────────────────────────────────────────────────────

function _reset() {
  _profiles.clear();
  _activeMentions.clear();
  // Clean up persisted profiles (for tests)
  try { fs.writeFileSync(PROFILES_PATH, '{}', 'utf8'); } catch { /* non-fatal */ }
}

module.exports = {
  addKol,
  removeKol,
  getKol,
  getAllKols,
  getActiveKols,
  recordMention,
  updateMentionPrice,
  getActiveMentions,
  getAllActiveMentions,
  getMentionsForMint,
  readMentions,
  getLeaderboard,
  refreshAllCredibility,
  incrementContentType,
  TIER_WEIGHTS,
  _reset,
};
