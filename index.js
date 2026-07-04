#!/usr/bin/env node
/**
 * Crypto Trend-to-Trade Signal System
 * 
 * Cross-references Google Trends search interest with real-time crypto prices
 * to detect early buy/sell opportunities before price catches up to sentiment.
 * 
 * Signals:
 *   BUY  - Search interest spikes >50% above 7-day avg, price hasn't moved (<2%)
 *   SELL - Search interest drops sharply, price still elevated
 *   DANGER - "[coin] scam" or "[coin] crash" trending
 * 
 * Runs every 30 minutes via PM2/cron. Daily summary at 07:00 UTC.
 */

import googleTrends from 'google-trends-api';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const SIGNALS_FILE = join(DATA_DIR, 'signals.json');
const HISTORY_DIR = join(DATA_DIR, 'history');
const PRICE_CACHE_FILE = join(DATA_DIR, 'price-cache.json');
const TREND_HISTORY_FILE = join(DATA_DIR, 'trend-history.json');

// Ensure directories exist
[DATA_DIR, HISTORY_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── Configuration ───────────────────────────────────────────────────────────
const WHATSAPP_TARGET = '+27783678266';

const COINS = [
  { id: 'bitcoin', symbol: 'BTC', keywords: ['bitcoin', 'btc'] },
  { id: 'ethereum', symbol: 'ETH', keywords: ['ethereum', 'eth'] },
  { id: 'solana', symbol: 'SOL', keywords: ['solana', 'sol crypto'] },
  { id: 'ripple', symbol: 'XRP', keywords: ['xrp', 'ripple'] },
  { id: 'dogecoin', symbol: 'DOGE', keywords: ['dogecoin', 'doge'] },
  { id: 'avalanche-2', symbol: 'AVAX', keywords: ['avax', 'avalanche crypto'] },
  { id: 'sui', symbol: 'SUI', keywords: ['sui crypto', 'sui blockchain'] },
  { id: 'chainlink', symbol: 'LINK', keywords: ['chainlink', 'link crypto'] },
  { id: 'pepe', symbol: 'PEPE', keywords: ['pepe coin', 'pepe crypto'] },
  { id: 'binancecoin', symbol: 'BNB', keywords: ['bnb', 'binance coin'] },
  { id: 'cardano', symbol: 'ADA', keywords: ['cardano', 'ada crypto'] },
  { id: 'polkadot', symbol: 'DOT', keywords: ['polkadot', 'dot crypto'] },
];

// Danger keywords to monitor
const DANGER_SUFFIXES = ['scam', 'crash', 'rug pull', 'hack', 'dead'];

// ── Utility Functions ───────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌', signal: '📊', success: '✅' }[level] || 'ℹ️';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── WhatsApp Alert ──────────────────────────────────────────────────────────
function sendWhatsApp(message) {
  try {
    const escaped = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    execSync(
      `sudo docker exec -e OPENCLAW_GATEWAY_TOKEN=9e2c9171fc1b9990c0c5ec95a0d8ebe01397e891af3cd38c5b936216718a8c66 openclaw-source-backup-openclaw-gateway-1 node /app/openclaw.mjs message send --channel whatsapp --target "${WHATSAPP_TARGET}" --message "${escaped}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
    log(`WhatsApp alert sent`, 'success');
  } catch (err) {
    log(`WhatsApp send failed: ${err.message}`, 'error');
  }
}

// ── CoinGecko Price Fetcher ─────────────────────────────────────────────────
async function fetchPrices() {
  const ids = COINS.map(c => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    
    // Cache prices with timestamp
    const priceData = {};
    for (const coin of COINS) {
      if (data[coin.id]) {
        priceData[coin.symbol] = {
          price: data[coin.id].usd,
          change24h: data[coin.id].usd_24h_change || 0,
          timestamp: Date.now()
        };
      }
    }
    
    // Update price history
    const cache = loadJSON(PRICE_CACHE_FILE) || { history: {} };
    for (const [sym, pd] of Object.entries(priceData)) {
      if (!cache.history[sym]) cache.history[sym] = [];
      cache.history[sym].push({ price: pd.price, change24h: pd.change24h, ts: Date.now() });
      // Keep last 7 days of 30-min intervals = ~336 entries
      if (cache.history[sym].length > 400) cache.history[sym] = cache.history[sym].slice(-336);
    }
    cache.latest = priceData;
    cache.updatedAt = new Date().toISOString();
    saveJSON(PRICE_CACHE_FILE, cache);
    
    log(`Fetched prices for ${Object.keys(priceData).length} coins`);
    return priceData;
  } catch (err) {
    log(`Price fetch error: ${err.message}`, 'error');
    const cache = loadJSON(PRICE_CACHE_FILE);
    return cache?.latest || {};
  }
}

// ── Google Trends Fetcher ───────────────────────────────────────────────────
async function fetchTrendInterest(keywords) {
  // Batch keywords in groups of 5 (Google Trends limit)
  const results = {};
  
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5);
    try {
      const raw = await googleTrends.interestOverTime({
        keyword: batch,
        startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        geo: '',  // Global
      });
      
      const parsed = JSON.parse(raw);
      const timelineData = parsed.default?.timelineData || [];
      
      for (let j = 0; j < batch.length; j++) {
        const values = timelineData.map(d => d.value?.[j] || 0);
        if (values.length === 0) {
          results[batch[j]] = { avg: 0, recent: 0, momentum: 0, values: [] };
          continue;
        }
        
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        // Recent = last ~24h of data points  
        const recentSlice = values.slice(-Math.max(1, Math.floor(values.length / 7)));
        const recent = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
        const momentum = avg > 0 ? recent / avg : 0;
        
        results[batch[j]] = {
          avg: Math.round(avg * 100) / 100,
          recent: Math.round(recent * 100) / 100,
          momentum: Math.round(momentum * 100) / 100,
          values: values.slice(-48), // Keep last 48 data points
          spiking: momentum > 1.5,   // >50% above average
          dropping: momentum < 0.6,  // >40% below average
        };
      }
      
      // Rate limit: wait between batches
      if (i + 5 < keywords.length) await sleep(2000);
      
    } catch (err) {
      log(`Trends fetch error for [${batch.join(', ')}]: ${err.message}`, 'warn');
      for (const kw of batch) {
        results[kw] = { avg: 0, recent: 0, momentum: 0, values: [], error: true };
      }
      await sleep(5000); // Longer wait on error
    }
  }
  
  return results;
}

// ── Danger Keyword Check ────────────────────────────────────────────────────
async function checkDangerKeywords() {
  const dangerKeywords = [];
  for (const coin of COINS) {
    for (const suffix of DANGER_SUFFIXES) {
      dangerKeywords.push(`${coin.keywords[0]} ${suffix}`);
    }
  }
  
  // Check in batches of 5
  const dangerSignals = [];
  
  for (let i = 0; i < dangerKeywords.length; i += 5) {
    const batch = dangerKeywords.slice(i, i + 5);
    try {
      const raw = await googleTrends.interestOverTime({
        keyword: batch,
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24h only
        geo: '',
      });
      
      const parsed = JSON.parse(raw);
      const timelineData = parsed.default?.timelineData || [];
      
      for (let j = 0; j < batch.length; j++) {
        const values = timelineData.map(d => d.value?.[j] || 0);
        const max = Math.max(...values, 0);
        const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        
        if (avg > 40 || max > 70) { // Significant search volume for danger terms
          const coinName = batch[j].split(' ')[0];
          const dangerType = batch[j].split(' ').slice(1).join(' ');
          dangerSignals.push({
            keyword: batch[j],
            coin: coinName,
            dangerType,
            intensity: Math.round(avg),
            peak: max,
          });
        }
      }
      
      if (i + 5 < dangerKeywords.length) await sleep(2000);
    } catch (err) {
      // Danger keywords often have too little data, that's fine
      await sleep(3000);
    }
  }
  
  return dangerSignals;
}

// ── Signal Generation Engine ────────────────────────────────────────────────
function generateSignals(trendData, prices, dangerSignals) {
  const signals = [];
  const now = new Date().toISOString();
  
  for (const coin of COINS) {
    const priceInfo = prices[coin.symbol];
    if (!priceInfo) continue;
    
    // Get trend data for this coin's primary keyword
    const primaryTrend = trendData[coin.keywords[0]];
    if (!primaryTrend || primaryTrend.error) continue;
    
    const { momentum, recent, avg, spiking, dropping } = primaryTrend;
    const priceChange = Math.abs(priceInfo.change24h || 0);
    
    // ── BUY SIGNAL: Interest spiking but price flat ─────────────────────
    if (spiking && priceChange < 2) {
      const confidence = calculateConfidence('BUY', momentum, priceChange, recent);
      signals.push({
        type: 'BUY',
        coin: coin.symbol,
        coinId: coin.id,
        price: priceInfo.price,
        priceChange24h: priceInfo.change24h,
        trendMomentum: momentum,
        trendRecent: recent,
        trendAvg: avg,
        confidence,
        reason: `Search interest surging ${Math.round((momentum - 1) * 100)}% above average while price flat (${priceInfo.change24h?.toFixed(2)}% 24h change)`,
        timestamp: now,
      });
    }
    
    // ── SELL SIGNAL: Interest dropping but price still up ───────────────
    if (dropping && priceInfo.change24h > 5) {
      const confidence = calculateConfidence('SELL', momentum, priceInfo.change24h, recent);
      signals.push({
        type: 'SELL',
        coin: coin.symbol,
        coinId: coin.id,
        price: priceInfo.price,
        priceChange24h: priceInfo.change24h,
        trendMomentum: momentum,
        trendRecent: recent,
        trendAvg: avg,
        confidence,
        reason: `Search interest dropping (momentum ${momentum}) but price still elevated (+${priceInfo.change24h?.toFixed(2)}% 24h)`,
        timestamp: now,
      });
    }
    
    // ── EARLY MOVER: Trend rising but not yet spiking, price flat ──────
    if (momentum > 1.2 && momentum <= 1.5 && priceChange < 1.5) {
      const confidence = calculateConfidence('WATCH', momentum, priceChange, recent);
      signals.push({
        type: 'WATCH',
        coin: coin.symbol,
        coinId: coin.id,
        price: priceInfo.price,
        priceChange24h: priceInfo.change24h,
        trendMomentum: momentum,
        trendRecent: recent,
        trendAvg: avg,
        confidence,
        reason: `Rising search interest (${Math.round((momentum - 1) * 100)}% above avg), price steady — potential early move`,
        timestamp: now,
      });
    }
  }
  
  // ── DANGER SIGNALS ──────────────────────────────────────────────────────
  for (const danger of dangerSignals) {
    const coin = COINS.find(c => c.keywords[0] === danger.coin);
    if (!coin) continue;
    
    signals.push({
      type: 'DANGER',
      coin: coin.symbol,
      coinId: coin.id,
      price: prices[coin.symbol]?.price || 0,
      priceChange24h: prices[coin.symbol]?.change24h || 0,
      dangerType: danger.dangerType,
      intensity: danger.intensity,
      peak: danger.peak,
      confidence: Math.min(95, danger.intensity + danger.peak),
      reason: `"${danger.keyword}" trending with intensity ${danger.intensity} (peak ${danger.peak})`,
      timestamp: now,
    });
  }
  
  return signals;
}

// ── Confidence Score Calculator ─────────────────────────────────────────────
function calculateConfidence(signalType, momentum, priceChange, recentInterest) {
  let score = 50; // Base
  
  if (signalType === 'BUY') {
    // Higher momentum = more confidence
    score += Math.min(25, (momentum - 1) * 50);
    // Flatter price = more confidence (bigger disconnect)
    score += Math.min(15, (2 - priceChange) * 7.5);
    // Higher absolute interest = more meaningful
    score += Math.min(10, recentInterest / 10);
  } else if (signalType === 'SELL') {
    // Lower momentum = more confidence in sell
    score += Math.min(25, (1 - momentum) * 50);
    // Higher price = more confidence (bigger disconnect)
    score += Math.min(15, priceChange * 1.5);
    // Low interest = more meaningful
    score += Math.min(10, (100 - recentInterest) / 10);
  } else if (signalType === 'WATCH') {
    score = 30 + Math.min(20, (momentum - 1) * 40);
  }
  
  return Math.round(Math.min(95, Math.max(10, score)));
}

// ── Format Alert Message ────────────────────────────────────────────────────
function formatAlertMessage(signals) {
  if (signals.length === 0) return null;
  
  const emoji = { BUY: '🟢', SELL: '🔴', WATCH: '👀', DANGER: '⚠️' };
  const now = new Date();
  const timeStr = now.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
  
  let msg = `📊 *TREND SIGNAL ALERT* (${timeStr} SAST)\n\n`;
  
  // Sort: DANGER first, then BUY, SELL, WATCH
  const priority = { DANGER: 0, BUY: 1, SELL: 2, WATCH: 3 };
  const sorted = signals.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9) || b.confidence - a.confidence);
  
  for (const s of sorted) {
    msg += `${emoji[s.type] || '📌'} *${s.type} ${s.coin}* — $${formatPrice(s.price)}\n`;
    msg += `   Confidence: ${s.confidence}%\n`;
    msg += `   ${s.reason}\n\n`;
  }
  
  msg += `_Signals based on Google Trends vs price analysis_`;
  return msg;
}

function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.001) return price.toFixed(4);
  return price.toFixed(8);
}

// ── Daily Summary ───────────────────────────────────────────────────────────
function generateDailySummary() {
  const history = loadJSON(TREND_HISTORY_FILE) || { runs: [] };
  const now = new Date();
  const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  
  // Get last 24h signals
  const recentRuns = history.runs.filter(r => new Date(r.timestamp).getTime() > oneDayAgo);
  const allSignals = recentRuns.flatMap(r => r.signals || []);
  
  if (allSignals.length === 0) {
    return `📊 *DAILY TREND SIGNAL SUMMARY*\n\nNo significant signals detected in the last 24 hours. Markets appear stable relative to search trends.`;
  }
  
  const buySignals = allSignals.filter(s => s.type === 'BUY');
  const sellSignals = allSignals.filter(s => s.type === 'SELL');
  const dangerSignals = allSignals.filter(s => s.type === 'DANGER');
  const watchSignals = allSignals.filter(s => s.type === 'WATCH');
  
  // Get unique coins with strongest signals
  const bestBuys = getTopSignals(buySignals, 3);
  const topSells = getTopSignals(sellSignals, 3);
  const dangers = getTopSignals(dangerSignals, 3);
  
  let msg = `📊 *DAILY TREND SIGNAL SUMMARY*\n`;
  msg += `${now.toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' })}\n\n`;
  
  msg += `📈 *24h Overview:*\n`;
  msg += `• ${buySignals.length} buy signals\n`;
  msg += `• ${sellSignals.length} sell signals\n`;
  msg += `• ${watchSignals.length} watch signals\n`;
  msg += `• ${dangerSignals.length} danger alerts\n\n`;
  
  if (bestBuys.length > 0) {
    msg += `🟢 *Strongest Buy Signals:*\n`;
    for (const s of bestBuys) {
      msg += `• ${s.coin} — ${s.confidence}% confidence\n`;
    }
    msg += '\n';
  }
  
  if (topSells.length > 0) {
    msg += `🔴 *Sell Signals:*\n`;
    for (const s of topSells) {
      msg += `• ${s.coin} — ${s.confidence}% confidence\n`;
    }
    msg += '\n';
  }
  
  if (dangers.length > 0) {
    msg += `⚠️ *Danger Alerts:*\n`;
    for (const s of dangers) {
      msg += `• ${s.coin} — "${s.dangerType}" trending\n`;
    }
    msg += '\n';
  }
  
  msg += `_Next scan in 30 minutes_`;
  return msg;
}

function getTopSignals(signals, max) {
  const byConfidence = {};
  for (const s of signals) {
    if (!byConfidence[s.coin] || s.confidence > byConfidence[s.coin].confidence) {
      byConfidence[s.coin] = s;
    }
  }
  return Object.values(byConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max);
}

// ── Main Scan Cycle ─────────────────────────────────────────────────────────
async function runScan() {
  log('Starting trend signal scan...', 'signal');
  const scanStart = Date.now();
  
  try {
    // 1. Fetch current prices
    log('Fetching crypto prices...');
    const prices = await fetchPrices();
    if (Object.keys(prices).length === 0) {
      log('No price data available, skipping scan', 'warn');
      return;
    }
    
    // 2. Fetch Google Trends for all coin keywords
    log('Fetching Google Trends data...');
    const allKeywords = COINS.flatMap(c => [c.keywords[0]]);
    const trendData = await fetchTrendInterest(allKeywords);
    
    // 3. Check danger keywords (only primary keyword + danger suffixes)
    log('Checking danger keywords...');
    const dangerSignals = await checkDangerKeywords();
    
    // 4. Generate signals
    log('Generating signals...');
    const signals = generateSignals(trendData, prices, dangerSignals);
    
    // 5. Save to signals.json for Gunbot optimizer
    const signalOutput = {
      generatedAt: new Date().toISOString(),
      scanDuration: `${((Date.now() - scanStart) / 1000).toFixed(1)}s`,
      signalCount: signals.length,
      signals,
      prices: Object.fromEntries(
        Object.entries(prices).map(([sym, p]) => [sym, { price: p.price, change24h: p.change24h }])
      ),
      trends: Object.fromEntries(
        Object.entries(trendData).map(([kw, t]) => [kw, { momentum: t.momentum, recent: t.recent, avg: t.avg }])
      ),
    };
    saveJSON(SIGNALS_FILE, signalOutput);
    log(`Saved ${signals.length} signals to signals.json`);
    
    // AUTO-OVERRIDE: Feed strong signals to Gunbot override + Earn manager
    try {
      const gunbotPairs = ["DASH", "SOL", "LINK", "XRP", "AVAX", "SUI"];
      const strongSignals = signals.filter(s => s.confidence >= 75 && gunbotPairs.some(p => s.coin.toUpperCase().includes(p)));
      if (strongSignals.length > 0) {
        const batch = strongSignals.map(s => ({
          pair: s.coin.replace("USDT", ""),
          signal: (s.type === "BUY" ? "STRONG_BUY" : s.type === "SELL" ? "STRONG_SELL" : null)
        })).filter(s => s.signal);
        if (batch.length > 0) {
          const fs = require("fs");
          fs.writeFileSync("/tmp/latest-signals.json", JSON.stringify(batch));
          const { execSync } = require("child_process");
          execSync("node /home/kabelo/signal-override.js --batch /tmp/latest-signals.json 2>>/home/kabelo/signal-override.log", { timeout: 30000 });
          log("Auto-override applied for " + batch.length + " signal(s): " + batch.map(b => b.pair + "=" + b.signal).join(", "));
        // Also trigger Earn Manager for strong signals
        try {
          const earnBatch = batch.filter(b => b.signal === "STRONG_SELL" || b.signal === "STRONG_BUY");
          for (const s of earnBatch) {
            execSync("cd /home/kabelo/earn-manager && node run.js --signal " + s.signal + " --asset " + s.pair + " 2>>/home/kabelo/earn-manager/earn-manager.log", { timeout: 60000 });
          }
          log("Auto-Earn management applied for " + earnBatch.length + " signal(s)");
        } catch (earnErr) { log("Auto-Earn error: " + earnErr.message, "warn"); }
        }
      }
    } catch (err) { log("Auto-override error: " + err.message, "warn"); }

    // 6. Save to history
    const history = loadJSON(TREND_HISTORY_FILE) || { runs: [] };
    history.runs.push({
      timestamp: new Date().toISOString(),
      signalCount: signals.length,
      signals: signals,
    });
    // Keep last 7 days of history (~336 runs at 30-min intervals)
    if (history.runs.length > 400) history.runs = history.runs.slice(-336);
    saveJSON(TREND_HISTORY_FILE, history);
    
    // 7. Save daily snapshot
    const dateStr = new Date().toISOString().split('T')[0];
    saveJSON(join(HISTORY_DIR, `${dateStr}.json`), signalOutput);
    
    
    
    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    log(`Scan complete in ${elapsed}s — ${signals.length} signals (${actionableSignals.length} actionable)`, 'success');
    
  } catch (err) {
    log(`Scan error: ${err.message}`, 'error');
    console.error(err.stack);
  }
}

// ── Entry Point ─────────────────────────────────────────────────────────────
async function main() {
  log('🚀 Crypto Trend Signal System starting...');
  log(`Monitoring ${COINS.length} coins: ${COINS.map(c => c.symbol).join(', ')}`);
  
  const runOnce = process.argv.includes('--once');
  
  // Run initial scan
  await runScan();
  
  if (runOnce) {
    log('Single run mode (--once), exiting.');
    process.exit(0);
  }
  
  // Schedule scans every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    log('Scheduled scan triggered');
    await runScan();
  });
  
  // Daily summary at 07:00 UTC (09:00 SAST)
  cron.schedule('0 7 * * *', () => {
    log('Generating daily summary...');
    const summary = generateDailySummary();
    sendWhatsApp(summary);
    log('Daily summary sent', 'success');
  });
  
  log('Scheduled: Scans every 30 min, daily summary at 07:00 UTC (09:00 SAST)');
  log('System running. Press Ctrl+C to stop.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
