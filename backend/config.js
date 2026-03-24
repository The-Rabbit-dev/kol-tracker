'use strict';

/**
 * KOL Tracker Config — minimal config for standalone KOL tracking.
 */

module.exports = {
  kol: {
    enabled:                process.env.KOL_ENABLED === 'true',
    pollIntervalMs:         5 * 60 * 1000,        // 5 min
    maxTrackedKols:         50,
    mentionWindowMs:        6 * 60 * 60 * 1000,   // 6h confluence window
    outcomeWindowMs:        48 * 60 * 60 * 1000,  // 48h outcome tracking
    winThresholdPct:        0.15,                  // 15% peak = win
    lossNadirPct:           -0.25,                 // -25% nadir = loss regardless
  },

  telegram: {
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  },
};
