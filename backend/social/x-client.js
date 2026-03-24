'use strict';

/**
 * X (Twitter) Client — read-only stub for KOL tracking.
 *
 * Provides: authentication, recent tweets polling, user lookup.
 * Stripped: write operations (post, reply, delete, media upload).
 *
 * Requires X API v2 credentials in .env:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *
 * Uses pay-per-use pricing (~$0.01 per 50 tweets fetched).
 */

const logger = require('../utils/logger');

const API_KEY        = process.env.X_API_KEY        || '';
const API_SECRET     = process.env.X_API_SECRET     || '';
const ACCESS_TOKEN   = process.env.X_ACCESS_TOKEN   || '';
const ACCESS_SECRET  = process.env.X_ACCESS_TOKEN_SECRET || '';

function isConfigured() {
  return !!(API_KEY && API_SECRET && ACCESS_TOKEN && ACCESS_SECRET);
}

/**
 * Fetch recent tweets from a list of user IDs.
 *
 * Uses X API v2 users/:id/tweets endpoint.
 * Returns array of tweet objects with: id, text, created_at, author_id, public_metrics.
 *
 * @param {string[]} userIds — X user IDs to poll
 * @param {object} [opts] — { maxResults, sinceId }
 * @returns {Promise<object[]>} tweets
 */
async function getRecentTweets(userIds, opts = {}) {
  if (!isConfigured()) return [];

  const https = require('https');
  const crypto = require('crypto');

  const allTweets = [];
  const maxResults = opts.maxResults ?? 5; // per user

  for (const userId of userIds) {
    try {
      const url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=${maxResults}&tweet.fields=created_at,public_metrics,entities,referenced_tweets&expansions=author_id&user.fields=username,verified,public_metrics`;

      const response = await _oauthGet(url);
      const data = JSON.parse(response);

      if (data.data) {
        for (const tweet of data.data) {
          tweet.author_id = userId; // ensure author_id is set
          allTweets.push(tweet);
        }
      }
    } catch (err) {
      logger.debug(`[X-CLIENT] Failed to fetch tweets for ${userId}: ${err.message}`);
    }
  }

  return allTweets;
}

/**
 * Look up a user by handle.
 *
 * @param {string} handle — @username (without @)
 * @returns {Promise<object|null>} user object or null
 */
async function lookupUser(handle) {
  if (!isConfigured()) return null;

  try {
    const url = `https://api.twitter.com/2/users/by/username/${handle}?user.fields=created_at,public_metrics,verified,verified_type`;
    const response = await _oauthGet(url);
    const data = JSON.parse(response);
    return data.data ?? null;
  } catch (err) {
    logger.debug(`[X-CLIENT] User lookup failed for @${handle}: ${err.message}`);
    return null;
  }
}

// ── OAuth 1.0a signing ──────────────────────────────────────────────────────

function _oauthGet(url) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const https  = require('https');
    const urlObj = new URL(url);

    const oauthParams = {
      oauth_consumer_key:     API_KEY,
      oauth_nonce:            crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
      oauth_token:            ACCESS_TOKEN,
      oauth_version:          '1.0',
    };

    // Collect all params (oauth + query)
    const allParams = { ...oauthParams };
    for (const [k, v] of urlObj.searchParams) allParams[k] = v;

    // Build signature base string
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
    const baseString = `GET&${encodeURIComponent(urlObj.origin + urlObj.pathname)}&${encodeURIComponent(paramString)}`;
    const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_SECRET)}`;

    oauthParams.oauth_signature = crypto
      .createHmac('sha1', signingKey)
      .update(baseString)
      .digest('base64');

    // Build Authorization header
    const authHeader = 'OAuth ' + Object.entries(oauthParams)
      .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
      .join(', ');

    const req = https.get(url, {
      headers: { Authorization: authHeader, 'User-Agent': 'KOL-Tracker/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = { isConfigured, getRecentTweets, lookupUser };
