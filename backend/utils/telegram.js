'use strict';

const http   = require('http');
const logger = require('./logger');

// ── Telegram Bot API — push alerts for KOL tracker ──────────────────────────
// Usage:
//   const telegram = require('../utils/telegram');
//   telegram.send('KOL @user called $TOKEN — score 85');
//
// Non-fatal: all errors are logged, never thrown.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const API_BASE  = `https://api.telegram.org/bot${BOT_TOKEN}`;

function _post(endpoint, body) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) { resolve(false); return; }
    const data = JSON.stringify(body);
    const url = new URL(`${API_BASE}/${endpoint}`);
    const req = http.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      protocol: 'https:',
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', (err) => { logger.warn('[telegram] send failed:', err.message); resolve(false); });
    req.write(data);
    req.end();
  });
}

/**
 * Send a plain-text message to the configured chat.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function send(text) {
  return _post('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

/**
 * Notify on KOL activity.
 * @param {'kol_call'|'confluence'|'credibility_change'} eventType
 * @param {object} data
 */
async function notify(eventType, data = {}) {
  const lines = [];
  switch (eventType) {
    case 'kol_call':
      lines.push(`<b>KOL Call</b>`);
      if (data.handle)  lines.push(`@${data.handle}`);
      if (data.symbol)  lines.push(`$${data.symbol}`);
      if (data.credibility != null) lines.push(`Credibility: ${data.credibility}`);
      break;
    case 'confluence':
      lines.push(`<b>Confluence Alert</b>`);
      if (data.symbol)  lines.push(`$${data.symbol} — ${data.kolCount} KOLs`);
      break;
    case 'credibility_change':
      lines.push(`<b>Credibility Update</b>`);
      if (data.handle)  lines.push(`@${data.handle}: ${data.oldScore} → ${data.newScore}`);
      break;
    default:
      lines.push(`<b>${eventType}</b>`);
      lines.push(JSON.stringify(data).slice(0, 200));
  }
  return send(lines.join('\n'));
}

module.exports = { send, notify };
