# Crypto Trend-to-Trade Signal System

Cross-references Google Trends search interest data with real-time crypto prices to generate early buy/sell signals before price catches up to sentiment.

## Signal Types

| Signal | Condition | Meaning |
|--------|-----------|---------|
| 🟢 **BUY** | Search interest >50% above 7-day avg, price flat (<2% change) | People are searching but price hasn't moved yet |
| 🔴 **SELL** | Search interest dropping sharply, price still elevated (>5%) | Hype fading but price hasn't corrected |
| 👀 **WATCH** | Interest rising 20-50% above avg, price flat | Early momentum building |
| ⚠️ **DANGER** | "[coin] scam/crash/rug pull" trending | Negative sentiment surging |

## Monitored Coins

BTC, ETH, SOL, XRP, DOGE, AVAX, SUI, LINK, PEPE, BNB, ADA, DOT

## How It Works

1. Every 30 minutes, fetches Google Trends interest data for each coin's keywords
2. Fetches current prices from CoinGecko API
3. Compares trend momentum (recent vs 7-day average) against price movement
4. Generates confidence scores based on the divergence between search interest and price
5. Sends WhatsApp alerts for actionable signals (BUY, SELL, DANGER)
6. Writes all signals to `data/signals.json` for Gunbot optimizer integration

## Setup

```bash
cd /home/kabelo/trend-signals
npm install
pm2 start index.js --name trend-signals
pm2 save
```

## Output Files

- `data/signals.json` — Latest signals (Gunbot optimizer reads this)
- `data/price-cache.json` — Price history
- `data/trend-history.json` — Signal history (7 days)
- `data/history/YYYY-MM-DD.json` — Daily snapshots

## WhatsApp Alerts

Sends alerts to configured number when BUY, SELL, or DANGER signals are detected.
Daily summary sent at 07:00 UTC (09:00 SAST).

## Confidence Scoring

- **Base:** 50%
- **Trend momentum:** Higher divergence from average = more confidence (+25 max)
- **Price disconnect:** Bigger gap between trend movement and price movement = more confidence (+15 max)
- **Interest volume:** Higher absolute search interest = more meaningful signal (+10 max)
- **Max confidence:** 95% (never 100% — markets are unpredictable)
