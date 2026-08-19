/**
 * gt-trending.js — Google Trends "Trending Now" fetcher (2026-08-18 findings)
 *
 * The old REST endpoints are RETIRED (404):
 *   - /trends/api/dailytrends        (google-trends-api: dailyTrends)
 *   - /trends/api/realtimetrends     (google-trends-api: realTimeTrends)
 *
 * The current frontend (TrendsUi / BOQ) has NO public JSON API for trending.
 * The trending list is SERVER-RENDERED into the page HTML:
 *   GET https://trends.google.com/trending?geo=US&hours=24
 *   200 OK, no cookie required (browser UA recommended), and the data lives in:
 *   AF_initDataCallback({key: 'ds:0', hash: '2', data:[null,[...items...]], sideChannel: {}});
 *   ds:1 = resolved geo name, e.g. ["United States"]
 *
 * Item schema (ds:0 → data[1][i]):
 *   [0] title
 *   [1] null
 *   [2] geo code          e.g. "US"
 *   [3] [unixSeconds]     snapshot timestamp
 *   [4] null
 *   [5] null
 *   [6] volume bucket     e.g. 50000, 100000, 200000 (raw; old API called it 50K+/100K+/200K+)
 *   [7] null
 *   [8] breakout          e.g. 1000 (old API "Breakout")
 *   [9] [relatedQueries]  array of related search strings
 *   [10] [meta]
 *   [11] [[articleId,"en","US"],...]  related news article IDs
 *   [12] title (repeat)
 *
 * Auxiliary batchexecute RPCs (POST /_/TrendsUi/data/batchexecute):
 *   - DqDTgb  args ["en-US",1,0]        → full country/region list (geo picker)
 *   - Tnt4U   args []                   → [] (no public args; 400 on any arg)
 *   - g4kJzf  args [currentList, ..., token] → [] (echo/state RPC, not usable standalone)
 */

import https from 'https';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const TRENDING_URL = 'https://trends.google.com/trending';

function httpsGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
    } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

/** Extract AF_initDataCallback data for key (balanced brace/bracket scan). */
function extractCallback(html, key) {
  const marker = `AF_initDataCallback({key: 'ds:${key}', hash: '`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const dataStart = html.indexOf('data:', start);
  if (dataStart === -1) return null;
  let i = dataStart + 5;
  let depth = 0, inStr = false, esc = false;
  while (i < html.length) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return html.slice(dataStart + 5, i + 1);
      }
    }
    i++;
  }
  return null;
}

/**
 * Fetch trending now.
 * @param {object} opts { geo: 'US', hours: 24, cookie: 'NID=...' }
 * @returns [{ title, geo, timestamp, volume, breakout, related, articles }]
 */
export async function getTrending(opts = {}) {
  const { geo, hours, cookie } = opts;
  const params = new URLSearchParams();
  if (geo) params.set('geo', geo);
  if (hours) params.set('hours', String(hours));
  const qs = params.toString();
  const url = TRENDING_URL + (qs ? '?' + qs : '');
  const res = await httpsGet(url, cookie);
  if (res.status !== 200) throw new Error(`trending page HTTP ${res.status}`);
  const raw = extractCallback(res.body, 0);
  if (!raw) throw new Error('ds:0 callback not found (bot-wall or layout change?)');
  const data = JSON.parse(raw);
  const items = Array.isArray(data) && data.length > 1 ? data[1] : data;
  if (!Array.isArray(items)) throw new Error('unexpected ds:0 shape');
  return items.map(it => ({
    title: it[0],
    geo: it[2],
    timestamp: Array.isArray(it[3]) ? it[3][0] : null,
    volume: it[6] ?? null,
    breakout: it[8] ?? null,
    related: Array.isArray(it[9]) ? it[9] : [],
    articles: Array.isArray(it[11]) ? it[11].map(a => a[0]) : [],
  }));
}

// CLI: node gt-trending.js [geo] [hours] [cookie]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [geo, hours, cookie] = process.argv.slice(2);
  getTrending({ geo: geo || 'US', hours: hours ? Number(hours) : 24, cookie })
    .then(items => {
      console.log(`geo=${geo || 'US'} hours=${hours || 24} → ${items.length} trending items`);
      for (const it of items.slice(0, 10)) {
        console.log(`  ${it.title}  [${it.geo}] vol=${it.volume} breakout=${it.breakout} ts=${it.timestamp ? new Date(it.timestamp * 1000).toISOString() : '-'}`);
      }
      if (items.length) {
        console.log('FULL first item:', JSON.stringify(items[0]));
      }
    })
    .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
