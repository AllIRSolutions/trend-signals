/**
 * gt-client.js — cookie-aware Google Trends client wrapper (2026-08-18)
 *
 * Problem: google-trends-api's /trends/api/explore returns 429 (bot-wall) without
 * an NID cookie. The lib's built-in retry only fires when the 429 response carries
 * Set-Cookie, which Google often omits on the wall — so batches fail with 429.
 *
 * Fix: pre-fetch a fresh NID cookie from the /trending HTML page (it sets NID and
 * is fully open: 200, no cookie needed), inject it into every lib request via a
 * custom https.Agent (lib supports `agent` option), and on any failure refresh the
 * NID once and retry.
 *
 * Contract: interestOverTime(params) resolves with the SAME raw JSON string the
 * lib returns, so call sites only swap the import.
 */

import https from 'https';
import googleTrends from 'google-trends-api';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const COOKIE_URL = 'https://trends.google.com/trending?geo=US';
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // refresh NID at most every 10 min

// Rate discipline: Google allows only ~6 API requests per ~minute from one IP,
// then serves an HTML bot-wall (429) for a few minutes. Pacing + backoff keeps
// us inside the envelope: 25s between flows, 60s/240s escalating backoff on wall.
const MIN_FLOW_GAP_MS = 25 * 1000;
const BACKOFF_STEPS = [60 * 1000, 240 * 1000];

let nidCookie = null;
let lastCookieFetch = 0;
let lastFlowStart = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] 🍪 gt-client ${msg}`);
}

function httpsGetCookie() {
  return new Promise((resolve, reject) => {
    const req = https.get(COOKIE_URL, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000,
    }, res => {
      res.resume(); // drain; we only need set-cookie
      const sc = res.headers['set-cookie'];
      resolve({ status: res.statusCode, setCookie: Array.isArray(sc) ? sc : (sc ? [sc] : []) });
    });
    req.on('timeout', () => req.destroy(new Error('cookie fetch timeout')));
    req.on('error', reject);
  });
}

/** Fetch a fresh NID cookie from the trending page. Returns cookie string or null. */
export async function fetchNid() {
  try {
    const { status, setCookie } = await httpsGetCookie();
    if (status !== 200) { log(`cookie page HTTP ${status}`); return nidCookie; }
    const nid = setCookie.find(c => c.startsWith('NID='));
    if (nid) {
      nidCookie = nid.split(';')[0];
      lastCookieFetch = Date.now();
      log(`NID refreshed (${nidCookie.length} chars)`);
    } else {
      log('no NID in set-cookie (page may have served from cache)');
    }
  } catch (err) {
    log(`cookie fetch failed: ${err.message}`);
  }
  return nidCookie;
}

// Reads nidCookie dynamically so refreshes apply to subsequent requests.
class CookieAgent extends https.Agent {
  addRequest(req, options) {
    if (nidCookie) {
      options.headers = { ...(options.headers || {}), Cookie: nidCookie };
    }
    return super.addRequest(req, options);
  }
}

const agent = new CookieAgent({ keepAlive: true, maxSockets: 10 });

function validate(raw) {
  const parsed = JSON.parse(raw); // throws on wall/error bodies
  if (!parsed.default?.timelineData) throw new Error('payload missing timelineData');
  return raw;
}

async function pace() {
  const wait = MIN_FLOW_GAP_MS - (Date.now() - lastFlowStart);
  if (wait > 0) {
    log(`pacing ${Math.round(wait / 1000)}s before next flow`);
    await new Promise(r => setTimeout(r, wait));
  }
  lastFlowStart = Date.now();
}

/**
 * interestOverTime(params) — same params as google-trends-api, plus cookie
 * handling, pacing and escalating wall-backoff. Resolves with raw JSON string.
 */
export async function interestOverTime(params) {
  await pace();
  if (!nidCookie || Date.now() - lastCookieFetch > COOKIE_MAX_AGE_MS) {
    await fetchNid();
  }
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF_STEPS.length; attempt++) {
    try {
      return validate(await googleTrends.interestOverTime({ ...params, agent }));
    } catch (err) {
      lastErr = err;
      const wait = BACKOFF_STEPS[attempt];
      if (wait === undefined) break; // exhausted retries
      log(`flow failed (${err.message}) — wall/429? backing off ${Math.round(wait / 1000)}s, fresh NID, retry ${attempt + 1}/${BACKOFF_STEPS.length}`);
      await fetchNid();
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// CLI self-test: node gt-client.js bitcoin ethereum
if (import.meta.url === `file://${process.argv[1]}`) {
  const keywords = process.argv.slice(2).length ? process.argv.slice(2) : ['bitcoin', 'ethereum'];
  interestOverTime({
    keyword: keywords,
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    geo: '',
  }).then(raw => {
    const parsed = JSON.parse(raw);
    const td = parsed.default?.timelineData || [];
    console.log(`✅ HTTP OK — ${keywords.length} keywords, ${td.length} timeline points`);
    for (let j = 0; j < keywords.length; j++) {
      const vals = td.map(d => d.value?.[j] || 0);
      console.log(`  ${keywords[j]}: avg=${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)} recent=${(vals.slice(-8).reduce((a, b) => a + b, 0) / 8).toFixed(1)}`);
    }
  }).catch(e => { console.error('❌', e.message); process.exit(1); });
}
