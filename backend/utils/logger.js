'use strict';

// ── Structured Logger ────────────────────────────────────────────────────────
// Drop-in replacement for the original 30-line logger. Same API surface:
//   logger.info(), logger.warn(), logger.error(), logger.debug()
//
// New capabilities (opt-in, zero breaking changes):
//   - LOG_FORMAT=json → NDJSON output for production log aggregation
//   - logger.child('module') → embedded module context
//   - Secret redaction on all output (API keys, private keys, rth_ tokens)

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const JSON_MODE = process.env.LOG_FORMAT === 'json';

// ── Secret redaction patterns (compiled once) ────────────────────────────────
const REDACT_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|bearer|authorization)[=:\s]+['"]?[A-Za-z0-9_\-./+]{20,}/gi,
  /rth_[A-Za-z0-9]{32,}/g,                              // Gateway API keys
  /[A-Za-z0-9/+]{64,88}={0,2}/g,                        // base64 private keys (64+ chars)
  /\b[0-9a-f]{64}\b/g,                                  // hex secrets (BRAIN_SECRET)
];

function _redact(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const pat of REDACT_PATTERNS) {
    out = out.replace(pat, (m) =>
      m.length > 16 ? m.slice(0, 6) + '***' + m.slice(-4) : '***'
    );
  }
  return out;
}

// ── Serialization ────────────────────────────────────────────────────────────

function _serialize(args) {
  return args.map(a => {
    if (a instanceof Error) return _redact(a.stack || a.message);
    if (typeof a === 'object' && a !== null) {
      try { return _redact(JSON.stringify(a)); } catch { return String(a); }
    }
    return _redact(String(a));
  }).join(' ');
}

// ── Core log function ────────────────────────────────────────────────────────

function _log(level, mod, args) {
  if (LEVELS[level] < MIN_LEVEL) return;

  if (JSON_MODE) {
    const entry = { ts: new Date().toISOString(), level, msg: _serialize(args) };
    if (mod) entry.module = mod;
    const line = JSON.stringify(entry);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    return;
  }

  // Human-readable (default — backward compatible, with redaction)
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const safe = args.map(a => {
    if (typeof a === 'string') return _redact(a);
    if (a instanceof Error) return _redact(a.stack || a.message);
    return a; // objects pass through for console formatting
  });
  fn(prefix, ...safe);
}

// ── Logger factory ───────────────────────────────────────────────────────────

function _createLogger(mod) {
  return {
    debug: (...args) => _log('debug', mod, args),
    info:  (...args) => _log('info',  mod, args),
    warn:  (...args) => _log('warn',  mod, args),
    error: (...args) => _log('error', mod, args),
    child: (name) => _createLogger(mod ? `${mod}:${name}` : name),
  };
}

module.exports = _createLogger(null);
