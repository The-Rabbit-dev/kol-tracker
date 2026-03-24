# KOL Tracker

Track Solana meme coin KOLs (Key Opinion Leaders) on X/Twitter. Measure call accuracy. Rank by credibility.

## What It Does

- **Polls X API** every 5 minutes for tweets from your tracked KOLs
- **Extracts token mentions** — contract addresses, cashtags, ticker aliases, URLs
- **Classifies content** — token call, market commentary, meme, philosophy, question, personal
- **Tracks outcomes** at 48 hours — did the token pump 15%+ (win) or dump 25%+ (loss)?
- **Ranks KOLs** by rolling win rate (7d, 30d, 90d) with weighted credibility score
- **Detects confluence** — multiple KOLs mentioning the same token = attention signal
- **Alerts via Telegram** when high-credibility KOLs make calls

## Quick Start

```bash
git clone <your-repo-url>
cd kol-tracker
npm install
cp .env.example .env    # add your X API keys
npm run seed            # add default KOL roster
npm start               # http://localhost:3002
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health |
| GET | `/api/kols` | All KOL profiles with credibility |
| GET | `/api/kols/:id` | Single KOL profile |
| POST | `/api/kols` | Add a KOL `{ handle, tier, pipeline }` |
| DELETE | `/api/kols/:id` | Remove a KOL |
| GET | `/api/kol-leaderboard` | KOLs ranked by credibility |
| GET | `/api/mentions?days=7` | Recent token mentions |
| GET | `/api/mentions/:mint` | Mentions for a specific token |
| GET | `/api/confluence` | Multi-KOL attention signals |
| GET | `/api/listener/status` | Listener poll stats |

## Credibility Scoring

Every token mention is tracked for 48 hours:
- **Win:** Peak price >= +15% AND nadir > -25%
- **Loss:** Everything else

Rolling win rates (7d/30d/90d) weighted into a 0-100 credibility score. KOLs earn their reputation — no manual labels.

## Content Classification

Every tweet is classified into one of 11 types:
`token_call` · `market_commentary` · `meme_humor` · `philosophy` · `question` · `personal` · `thread` · `rant` · `news_reaction`

Content distribution accumulates on each KOL profile, building a data-driven archetype over time.

## Anti-Gaming

Built-in protections against manipulative KOLs:
- Front-run detection (call after the move already happened)
- Co-occurrence scoring (coordinated pumps)
- Gaming risk discount on credibility

## Architecture

```
X API (5min poll)
  → Tweet ingestion → content classification
  → Token extraction (4 layers: CA, URL, cashtag, alias)
  → Mention recording + price tracking
  → 48h outcome resolution (win/loss)
  → Credibility refresh (rolling WR)
  → Confluence detection (multi-KOL signals)
```

All data persisted to JSONL logs. No database required.

## X API Cost

Pay-per-use pricing. Tracking 30 KOLs at 5-minute intervals ≈ **~$36/month**.

## Extension Points

The `kol-listener.js` has a marked extension point where you can add your own logic:

```javascript
// ── EXTENSION POINT ──
// Add your own logic here: alerts, reply composition, etc.
if (tokens.length > 0 && priceData.score >= 70) {
  sendTelegramAlert(`@${handle} called ${tokens[0].symbol}`);
}
```

## Want More?

This is the tracking layer. The full platform includes:
- **Trading Brain** — autonomous entry/exit with closed-loop calibration
- **Social Brain** — intent-based reply composition, engagement tracking
- **Perps Brain** — Drift Protocol perpetual futures
- **Dashboard** — real-time scanner with tier-gated intelligence

## License

MIT
