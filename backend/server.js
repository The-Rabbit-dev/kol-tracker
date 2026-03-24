'use strict';

/**
 * KOL Tracker Server — minimal Express server for the public KOL tracking system.
 *
 * Endpoints:
 *   GET  /health              — server health
 *   GET  /api/kols            — all KOL profiles with credibility scores
 *   GET  /api/kols/:kolId     — single KOL profile
 *   POST /api/kols            — add a new KOL
 *   DELETE /api/kols/:kolId   — remove a KOL
 *   GET  /api/kol-leaderboard — KOLs ranked by credibility
 *   GET  /api/mentions        — recent token mentions
 *   GET  /api/mentions/:mint  — mentions for a specific token
 *   GET  /api/confluence      — multi-KOL attention signals
 *   GET  /api/listener/status — listener poll stats
 */

const express = require('express');
const config  = require('./config');
const logger  = require('./utils/logger');

const app = express();
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────────

const _startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: (Date.now() - _startTime) / 1000,
    time:   Date.now(),
  });
});

// ── KOL endpoints ───────────────────────────────────────────────────────────

const kolTracker = require('./social/kol-tracker');

app.get('/api/kols', (_req, res) => {
  res.json(kolTracker.getAllKols());
});

app.get('/api/kols/:kolId', (req, res) => {
  const kol = kolTracker.getKol(req.params.kolId);
  if (!kol) return res.status(404).json({ error: 'KOL not found' });
  res.json(kol);
});

app.post('/api/kols', (req, res) => {
  const { handle, tier, pipeline, focusTags } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const result = kolTracker.addKol({ handle, tier, pipeline, focusTags });
  res.status(201).json(result);
});

app.delete('/api/kols/:kolId', (req, res) => {
  kolTracker.removeKol(req.params.kolId);
  res.json({ ok: true });
});

app.get('/api/kol-leaderboard', (_req, res) => {
  res.json(kolTracker.getLeaderboard());
});

// ── Mention endpoints ───────────────────────────────────────────────────────

app.get('/api/mentions', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  res.json(kolTracker.readMentions(days));
});

app.get('/api/mentions/:mint', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  res.json(kolTracker.getMentionsForMint(req.params.mint, days));
});

// ── Confluence ──────────────────────────────────────────────────────────────

app.get('/api/confluence', (req, res) => {
  try {
    const confluence = require('./social/kol-confluence');
    const window = parseInt(req.query.window) || 6;
    res.json(confluence.getActiveConfluence(window));
  } catch {
    res.json([]);
  }
});

// ── Listener status ─────────────────────────────────────────────────────────

app.get('/api/listener/status', (_req, res) => {
  try {
    const listener = require('./social/kol-listener');
    res.json(listener.getStatus());
  } catch {
    res.json({ pollCount: 0, lastPollTime: 0, mentionCount: 0 });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  logger.info(`KOL Tracker listening on port ${PORT}`);

  // Start KOL listener
  if (config.kol?.enabled) {
    try {
      const listener = require('./social/kol-listener');
      listener.start();
    } catch (err) {
      logger.warn(`KOL listener failed to start: ${err.message}`);
    }
  }
});
