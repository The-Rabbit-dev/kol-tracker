#!/usr/bin/env node
'use strict';

/**
 * Seed KOL Profiles — loads all 35 tracked KOLs.
 *
 * Usage: node scripts/seed-kols.js
 *
 * Safe to re-run — addKol() merges with existing profiles.
 */

const kolTracker = require('../backend/social/kol-tracker');

const SEED_KOLS = [
  // ── Alpha — on-chain verified PnL, early signals ──────────────────────────

  {
    handle:        'Cented7',
    twitterUserId: 'Cented7',
    displayName:   'Cented',
    tier:          'alpha',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'on_chain'],
  },
  {
    handle:        'notdecu',
    twitterUserId: 'notdecu',
    displayName:   'decu',
    tier:          'alpha',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'high_volume'],
  },
  {
    handle:        'theonomix',
    twitterUserId: 'theonomix',
    displayName:   'theo',
    tier:          'alpha',
    pipeline:      'hybrid',
    focusTags:     ['solana', 'memes', 'perps'],
  },
  {
    handle:        'jijo_exe',
    twitterUserId: 'jijo_exe',
    displayName:   'Jijo',
    tier:          'alpha',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'precision'],
  },
  {
    handle:        '0GAntD',
    twitterUserId: '0GAntD',
    displayName:   'OGAntD',
    tier:          'alpha',
    pipeline:      'hybrid',
    focusTags:     ['solana', 'memes', 'perps'],
  },
  {
    handle:        'KookCapitalLLC',
    twitterUserId: 'KookCapitalLLC',
    displayName:   'Kook Capital',
    tier:          'alpha',
    pipeline:      'hybrid',
    focusTags:     ['contrarian', 'solana', 'independent'],
  },

  // ── Meme / Mid — high volume callers, confluence fuel ─────────────────────

  {
    handle:        'Kevsznx',
    twitterUserId: 'Kevsznx',
    displayName:   'Kev',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'volume'],
  },
  {
    handle:        'vibed333',
    twitterUserId: 'vibed333',
    displayName:   'dv',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'data'],
  },
  {
    handle:        'watchingmarkets',
    twitterUserId: 'watchingmarkets',
    displayName:   'Market Watcher',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['memes', 'calls', 'track_record'],
  },
  {
    handle:        'inversebrah',
    twitterUserId: 'inversebrah',
    displayName:   'inversebrah',
    tier:          'mid',
    pipeline:      'perps',
    focusTags:     ['contrarian', 'macro', 'fades'],
  },
  {
    handle:        'tilcrypto',
    twitterUserId: 'tilcrypto',
    displayName:   'TIL',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'consistent'],
  },

  // ── Wave 2 — Meme callers, chart analysts, shittalkers ──────────────

  {
    handle:        'kikcharts',
    twitterUserId: 'kikcharts',
    displayName:   'Kik Charts',
    tier:          'alpha',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'charts', 'technical'],
  },
  {
    handle:        'hakuand_',
    twitterUserId: 'hakuand_',
    displayName:   'Haku',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'elGodric',
    twitterUserId: 'elGodric',
    displayName:   'Godric',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'LyvoCrypto',
    twitterUserId: 'LyvoCrypto',
    displayName:   'Lyvo',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'solbrdl',
    twitterUserId: 'solbrdl',
    displayName:   'Sol Brdl',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'eleetmo',
    twitterUserId: 'eleetmo',
    displayName:   'Eleet',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'Crypton_on_x',
    twitterUserId: 'Crypton_on_x',
    displayName:   'Crypton',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'greenytrades',
    twitterUserId: 'greenytrades',
    displayName:   'Greeny',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'trades'],
  },
  {
    handle:        'dxrnell',
    twitterUserId: 'dxrnell',
    displayName:   'Dxrnell',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'BenevAleksandar',
    twitterUserId: 'BenevAleksandar',
    displayName:   'Aleksandar',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },
  {
    handle:        'Eljaboom',
    twitterUserId: 'Eljaboom',
    displayName:   'Eljaboom',
    tier:          'alpha',
    pipeline:      'hybrid',
    focusTags:     ['macro', 'market_temp', 'memes'],
  },
  {
    handle:        'slingoorio',
    twitterUserId: 'slingoorio',
    displayName:   'Slingo',
    tier:          'mid',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'shitposter'],
  },
  {
    handle:        '_Shadow36',
    twitterUserId: '_Shadow36',
    displayName:   'Shadow',
    tier:          'mid',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'shitposter'],
  },
  {
    handle:        'MarcellxMarcell',
    twitterUserId: 'MarcellxMarcell',
    displayName:   'Marcell',
    tier:          'mid',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes', 'shitposter'],
  },
  {
    handle:        'shrebobo',
    twitterUserId: 'shrebobo',
    displayName:   'Shrebobo',
    tier:          'meme',
    pipeline:      'meme',
    focusTags:     ['solana', 'memes'],
  },

  // ── Learn — builders, tools, patterns. Not for trading. ───────────────

  {
    handle:        'bcherny',
    twitterUserId: 'bcherny',
    displayName:   'Boris Cherny',
    tier:          'apex',
    pipeline:      'learn',
    focusTags:     ['claude_code', 'anthropic', 'creator', 'workflows'],
  },
  {
    handle:        'AnthropicAI',
    twitterUserId: 'AnthropicAI',
    displayName:   'Anthropic',
    tier:          'apex',
    pipeline:      'learn',
    focusTags:     ['anthropic', 'claude', 'official', 'releases'],
  },
  {
    handle:        'alexalbert__',
    twitterUserId: 'alexalbert__',
    displayName:   'Alex Albert',
    tier:          'apex',
    pipeline:      'learn',
    focusTags:     ['claude', 'anthropic', 'claude_relations'],
  },
  {
    handle:        'claudeai',
    twitterUserId: 'claudeai',
    displayName:   'Claude',
    tier:          'apex',
    pipeline:      'learn',
    focusTags:     ['claude', 'product', 'official'],
  },
  {
    handle:        'claude_code',
    twitterUserId: 'claude_code',
    displayName:   'Claude Code Community',
    tier:          'alpha',
    pipeline:      'learn',
    focusTags:     ['claude_code', 'community', 'skills', 'tips'],
  },
  {
    handle:        'swyx',
    twitterUserId: 'swyx',
    displayName:   'swyx',
    tier:          'alpha',
    pipeline:      'learn',
    focusTags:     ['ai_engineering', 'latent_space', 'agent_patterns'],
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`\nSeeding ${SEED_KOLS.length} KOL profiles...\n`);

const results = { added: 0, updated: 0 };

for (const kol of SEED_KOLS) {
  const existing = kolTracker.getKol(kol.twitterUserId);
  kolTracker.addKol(kol);
  if (existing) {
    results.updated++;
    console.log(`  ✓ Updated @${kol.handle} (${kol.tier}/${kol.pipeline})`);
  } else {
    results.added++;
    console.log(`  + Added   @${kol.handle} (${kol.tier}/${kol.pipeline})`);
  }
}

console.log(`\nDone: ${results.added} added, ${results.updated} updated.`);
console.log(`Total KOLs: ${kolTracker.getAllKols().length}`);

// Pipeline breakdown
const all = kolTracker.getAllKols();
const meme   = all.filter(k => k.pipeline === 'meme').length;
const perps  = all.filter(k => k.pipeline === 'perps').length;
const hybrid = all.filter(k => k.pipeline === 'hybrid').length;
const learn  = all.filter(k => k.pipeline === 'learn').length;
console.log(`Pipeline: ${meme} meme, ${perps} perps, ${hybrid} hybrid, ${learn} learn`);
console.log(`Meme pipeline sees: ${meme + hybrid} voices`);
console.log(`Perps pipeline sees: ${perps + hybrid} voices`);
console.log(`Learn feed: ${learn} builders\n`);

// Activation instructions
console.log('To activate KOL listening, add to your .env:');
console.log('  KOL_ENABLED=true');
console.log('  X_API_KEY=...');
console.log('  X_API_SECRET=...');
console.log('  X_ACCESS_TOKEN=...');
console.log('  X_ACCESS_TOKEN_SECRET=...\n');
