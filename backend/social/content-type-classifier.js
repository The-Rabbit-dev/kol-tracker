'use strict';

/**
 * Content Type Classifier — categorize tweet content for reply strategy selection.
 *
 * Waterfall pattern matching (first match wins). Same approach as classifyThesis
 * in informed-reply.js. Zero dependencies, standalone module.
 */

// ── Pattern Definitions ─────────────────────────────────────────────────────

const THREAD_PATTERNS = [
  /^(\d+[\.\)\/])/,                       // "1." or "1)" or "1/"
  /\bthread\b/i,
  /🧵/,
  /\b\d+\/\d+\b/,                         // "1/10" format
];

const TOKEN_CALL_PATTERNS = [
  /\$[A-Za-z][A-Za-z0-9]{1,10}\b/,        // $TICKER
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,     // Solana address (base58)
  /dexscreener\.com\/solana\//i,
  /birdeye\.so\/token\//i,
  /pump\.fun\//i,
  /jupiter\.ag\//i,
];

const QUESTION_PATTERNS = [
  /\?$/,                                   // ends with ?
  /\bagree or disagree\b/i,
  /\bwhat do you think\b/i,
  /\bthoughts\s*\?/i,
  /\bwho['']s (buying|selling|holding)\b/i,
  /\bwhat['']s your\b/i,
  /\bam i wrong\b/i,
];

const RANT_PATTERNS = [
  /!{3,}/,                                // 3+ exclamation marks
  /[A-Z\s]{20,}/,                         // 20+ chars of ALL CAPS
  /\b(scam|rug|fraud|ponzi|trash|garbage|clown|joke)\b/i,
];

const PHILOSOPHY_PATTERNS = [
  /\b(discipline|patience|process|system|mindset|edge|conviction)\b/i,
  /\b(psychology|emotional?|greed|fear|fomo)\b/i,
  /\b(long.?term|compound|journey|lesson|wisdom)\b/i,
  /\b(most (people|traders))\b/i,
  /\b(the (market|game|key|secret|truth|difference))\b/i,
];

const MARKET_COMMENTARY_PATTERNS = [
  /\b(market|macro|cycle|dominance|correlat|regime|conditions?)\b/i,
  /\b(btc\.?d|bitcoin dominance|alt.?season|risk.?on|risk.?off)\b/i,
  /\b(bottom|top|capitulation|euphoria|distribution|accumulation)\b/i,
  /\b(bull(ish)?|bear(ish)?)\s+(market|cycle|case|thesis)\b/i,
  /\b(feels? (like|toppy|bottomy)|structure|momentum|trend)\b/i,
];

const NEWS_PATTERNS = [
  /\b(just announced|breaking|headline|report|SEC|CFTC|regulat)\b/i,
  /\b(ETF|approval|ruling|lawsuit|hack|exploit|breach)\b/i,
  /\b(partnership|listing|launch(ed|ing)?|integrat)\b/i,
];

const MEME_HUMOR_PATTERNS = [
  /😂|🤣|💀|☠️|🤡|😭|🫡|😈/,
  /\b(lmao|lmfao|rofl|bruh|fam|ser|anon|ngmi|gm|gn|wagmi)\b/i,
];

// ── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify tweet content type via waterfall pattern matching.
 *
 * @param {string} text — tweet text
 * @returns {{ type: string, confidence: number }}
 */
function classifyContentType(text) {
  if (!text || typeof text !== 'string') {
    return { type: 'personal', confidence: 0.1 };
  }

  const trimmed = text.trim();

  // 1. Thread markers (highest priority — structure, not content)
  if (THREAD_PATTERNS.some(p => p.test(trimmed))) {
    return { type: 'thread', confidence: 0.9 };
  }

  // 2. Token call (has cashtag, CA, or DEX URL)
  if (TOKEN_CALL_PATTERNS.some(p => p.test(trimmed))) {
    return { type: 'token_call', confidence: 0.95 };
  }

  // 3. Rant (strong emotional markers — check before philosophy/commentary)
  const rantMatches = RANT_PATTERNS.filter(p => p.test(trimmed)).length;
  if (rantMatches >= 2) {
    return { type: 'rant', confidence: 0.85 };
  }

  // 4. Question (direct audience engagement)
  if (QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    return { type: 'question', confidence: 0.8 };
  }

  // 5. Meme/humor (short + emoji-heavy or meme language)
  const emojiCount = (trimmed.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if ((emojiCount >= 3 && trimmed.length < 100) || MEME_HUMOR_PATTERNS.some(p => p.test(trimmed))) {
    return { type: 'meme_humor', confidence: 0.7 };
  }

  // 6. Philosophy/mindset
  const philMatches = PHILOSOPHY_PATTERNS.filter(p => p.test(trimmed)).length;
  if (philMatches >= 2) {
    return { type: 'philosophy', confidence: 0.8 };
  }

  // 7. Market commentary (macro without specific token)
  const mktMatches = MARKET_COMMENTARY_PATTERNS.filter(p => p.test(trimmed)).length;
  if (mktMatches >= 2) {
    return { type: 'market_commentary', confidence: 0.8 };
  }
  if (mktMatches === 1 && philMatches === 1) {
    return { type: 'market_commentary', confidence: 0.6 };
  }

  // 8. News reaction
  if (NEWS_PATTERNS.some(p => p.test(trimmed))) {
    return { type: 'news_reaction', confidence: 0.7 };
  }

  // 9. Single philosophy match (weaker)
  if (philMatches === 1) {
    return { type: 'philosophy', confidence: 0.5 };
  }

  // 10. Single market match (weaker)
  if (mktMatches === 1) {
    return { type: 'market_commentary', confidence: 0.5 };
  }

  // 11. Default
  return { type: 'personal', confidence: 0.3 };
}

module.exports = { classifyContentType };
