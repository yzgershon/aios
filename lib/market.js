'use strict';
// AIOS market data — everything Yahoo Finance: live quotes (+ last-good disk
// persistence), cookie+crumb auth, upcoming earnings, and monthly stock P/L.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, parseMarkdownTable, pool, freshness, markFresh } = require('./util');

// Live stock quotes — Yahoo v8 chart (per-symbol), server-cached ~4s. No API key.
const quoteCache = {};
const QUOTE_TTL = 4000;

// Last-good quote persistence — Yahoo's endpoints are unofficial and have
// broken before (the earnings cookie+crumb saga). Snapshot the quote cache to
// disk every 2 min and reload it at boot, so a Yahoo outage degrades the
// dashboard to "stale prices as of X" instead of dashes everywhere. Each quote
// carries `asOf` so the frontend can tell live from stale.
const QUOTES_CACHE_FILE = path.join(AIOS_DATA_DIR, 'quotes-cache.json');
let quotesDirty = false;
(async () => {
  try {
    const saved = JSON.parse(await fsp.readFile(QUOTES_CACHE_FILE, 'utf8'));
    let n = 0;
    for (const [sym, entry] of Object.entries(saved || {})) {
      if (entry && entry.data && entry.data.price != null && !quoteCache[sym]) {
        // keep the original (old) `at` so TTL logic still refetches — these
        // entries only serve as fallbacks when live fetches fail
        quoteCache[sym] = entry;
        n++;
      }
    }
    if (n) console.log(`[AIOS] quotes: loaded ${n} last-good prices from disk`);
  } catch { /* first run */ }
})();
setInterval(() => {
  if (!quotesDirty) return;
  quotesDirty = false;
  writeJsonAtomic(QUOTES_CACHE_FILE, quoteCache).catch(() => {});
}, 2 * 60 * 1000);
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();
  const res0 = j && j.chart && j.chart.result && j.chart.result[0];
  const m = res0 && res0.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no data');
  const price = Number(m.regularMarketPrice);
  const prev = Number(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
  // v8 meta has no marketState — derive it from currentTradingPeriod windows
  let state = m.marketState || '';
  if (!state && m.currentTradingPeriod) {
    const now = Date.now() / 1000;
    const tp = m.currentTradingPeriod;
    const within = (w) => w && now >= w.start && now < w.end;
    if (within(tp.regular)) state = 'REGULAR';
    else if (within(tp.pre)) state = 'PRE';
    else if (within(tp.post)) state = 'POST';
    else state = 'CLOSED';
    if (!m.hasPrePostMarketData && (state === 'PRE' || state === 'POST')) state = 'CLOSED';
  }
  const out = { price, prevClose: prev, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, currency: m.currency || 'USD', state, asOf: new Date().toISOString() };
  markFresh('quotes');
  quotesDirty = true;
  // Extended hours: latest pre/post trade from the included intraday closes,
  // quoted vs the most recent regular close (= `price` during PRE and POST).
  if (/^(PRE|POST)/.test(state)) {
    try {
      const closes = res0.indicators.quote[0].close || [];
      let ext = null;
      for (let i = closes.length - 1; i >= 0; i--) { if (closes[i] != null) { ext = Number(closes[i]); break; } }
      if (ext != null && price > 0 && Math.abs(ext - price) / price < 0.5) {
        out.ext = { price: ext, change: ext - price, changePct: ((ext - price) / price) * 100 };
      }
    } catch { /* extended data missing — regular quote stands */ }
  }
  return out;
}
// ---------------------------------------------------------------------------
// Yahoo auth (cookie + crumb) — quoteSummary now requires it. Cached 30 min,
// re-fetched on a 401. Shared by the earnings calendar.
// ---------------------------------------------------------------------------
let yahooAuth = { cookie: '', crumb: '', at: 0 };
const YAHOO_AUTH_TTL = 30 * 60 * 1000;
async function getYahooAuth(force) {
  if (!force && yahooAuth.crumb && Date.now() - yahooAuth.at < YAHOO_AUTH_TTL) return yahooAuth;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  let cookie = '';
  try {
    const c = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
    cookie = (c.headers.get('set-cookie') || '').split(';')[0] || '';
  } catch { /* ignore */ }
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': ua, Cookie: cookie }, signal: AbortSignal.timeout(8000) });
  const crumb = (await cr.text()).trim();
  yahooAuth = { cookie, crumb, at: Date.now() };
  return yahooAuth;
}

// ---------------------------------------------------------------------------
// Upcoming earnings — holdings + a big-company watchlist. Yahoo calendarEvents.
// Cached 6 h (earnings dates barely move). No third-party key.
// ---------------------------------------------------------------------------
const BIG_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'PLTR', 'COST'];
let earningsCache = { at: 0, data: null };
const EARNINGS_TTL = 6 * 60 * 60 * 1000;

async function fetchEarningsFor(symbol, auth) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents,price&crumb=${encodeURIComponent(auth.crumb)}`;
  const r = await fetch(u, { headers: { 'User-Agent': ua, Cookie: auth.cookie }, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e; }
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  const e = res && res.calendarEvents && res.calendarEvents.earnings;
  const dateRaw = e && e.earningsDate && e.earningsDate[0] && e.earningsDate[0].raw;
  if (!dateRaw) return null;
  const price = res && res.price;
  return {
    ticker: symbol.toUpperCase(),
    name: (price && (price.shortName || price.longName)) || symbol,
    date: e.earningsDate[0].fmt,
    epoch: dateRaw,
    isEstimate: !!e.isEarningsDateEstimate,
    epsEstimate: e.earningsAverage && e.earningsAverage.raw != null ? e.earningsAverage.raw : null,
    revEstimate: (e.revenueAverage && e.revenueAverage.fmt) || null,
  };
}

async function getEarnings() {
  if (earningsCache.data && Date.now() - earningsCache.at < EARNINGS_TTL) return earningsCache.data;
  // Holdings tickers (skip indices/^ symbols — they have no earnings).
  let held = [];
  try {
    const pf = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    held = (pf.holdings || []).map((h) => String(h.ticker || '').toUpperCase()).filter((t) => t && !t.startsWith('^') && !t.includes('='));
  } catch { /* no portfolio is fine */ }
  const heldSet = new Set(held);
  const symbols = Array.from(new Set([...held, ...BIG_TICKERS]));
  if (!symbols.length) return { available: false, reason: 'no_symbols', rows: [] };
  let auth;
  try { auth = await getYahooAuth(); } catch (e) { return earningsCache.data || { available: false, reason: 'auth_failed', message: String(e.message || e), rows: [] }; }
  let results = await pool(symbols, 5, (s) => fetchEarningsFor(s, auth));
  // If everything failed, the crumb may have gone stale mid-flight — refresh once.
  if (results.every((r) => r == null)) {
    try { auth = await getYahooAuth(true); results = await pool(symbols, 5, (s) => fetchEarningsFor(s, auth)); } catch { /* ignore */ }
  }
  const todayMidnight = Math.floor(Date.now() / 1000) - 86400; // keep "reports today" visible
  const rows = results.filter(Boolean)
    .map((r) => ({ ...r, held: heldSet.has(r.ticker) }))
    .filter((r) => r.epoch >= todayMidnight)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, 40);
  const data = { available: rows.length > 0, timestamp: new Date().toISOString(), rows, counts: { all: rows.length, held: rows.filter((r) => r.held).length } };
  if (rows.length) earningsCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// Stock revenue this month — mark-to-market gain since the last close of the
// previous month, summed across holdings. The baseline (prior-month close)
// doesn't move intraday, so it's cached 6 h; the *current* price comes from the
// live quote cache, so this figure tracks the market as closely as the
// portfolio does. Assembled result cached just 20 s.
// ---------------------------------------------------------------------------
let monthCache = { at: 0, data: null };
const MONTH_TTL = 20 * 1000;
const baselineCache = {}; // ticker -> { at, baseline }
const BASELINE_TTL = 6 * 60 * 60 * 1000;

async function getMonthBaseline(symbol) {
  const key = symbol.toUpperCase();
  const hit = baselineCache[key];
  if (hit && Date.now() - hit.at < BASELINE_TTL) return hit.baseline;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (res && res.timestamp) || [];
  const close = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const now = new Date();
  const firstOfMonth = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  let baseline = null;
  for (let i = 0; i < ts.length; i++) { if (ts[i] < firstOfMonth && close[i] != null) baseline = close[i]; }
  if (baseline == null) baseline = close.find((c) => c != null);
  if (baseline == null) { const m = res && res.meta; baseline = m && m.regularMarketPrice; }
  if (baseline == null) throw new Error('no baseline');
  baselineCache[key] = { at: Date.now(), baseline };
  return baseline;
}

// Live price from the shared quote cache (refresh if stale), stored price as fallback.
async function liveOrCachedPrice(symbol, fallback) {
  const key = symbol.toUpperCase();
  if (!(quoteCache[key] && Date.now() - quoteCache[key].at < QUOTE_TTL)) {
    try { quoteCache[key] = { at: Date.now(), data: await fetchYahooQuote(key) }; } catch { /* keep prior / fall back */ }
  }
  const q = quoteCache[key];
  return (q && q.data && q.data.price != null) ? q.data.price : (fallback != null ? fallback : null);
}

async function monthGainFor(h) {
  const symbol = String(h.ticker).toUpperCase();
  const shares = toNumber(h.shares, 0);
  // Positions bought this month measure P/L from your cost basis, not the
  // prior-month close — otherwise the figure counts moves from before you owned it.
  const ym = new Date().toISOString().slice(0, 7);
  let baseline;
  if (typeof h.since === 'string' && h.since.slice(0, 7) === ym && toNumber(h.avgCost, 0) > 0) {
    baseline = toNumber(h.avgCost, 0);
  } else {
    baseline = await getMonthBaseline(symbol);
  }
  let price = await liveOrCachedPrice(symbol, toNumber(h.price, 0) || baseline);
  if (price == null) price = baseline;
  return { ticker: symbol, shares, price, baseline, gain: shares * (price - baseline) };
}

async function getStocksMonth() {
  if (monthCache.data && Date.now() - monthCache.at < MONTH_TTL) return monthCache.data;
  let holdings = [];
  try {
    const pf = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    holdings = (pf.holdings || []).filter((h) => h && h.ticker && toNumber(h.shares, 0) > 0);
  } catch { return { available: false, reason: 'no_portfolio', monthGain: 0 }; }
  if (!holdings.length) return { available: false, reason: 'empty', monthGain: 0 };
  const per = (await pool(holdings, 5, (h) => monthGainFor(h))).filter(Boolean);
  const monthGain = per.reduce((s, p) => s + (p.gain || 0), 0);
  const data = { available: per.length > 0, timestamp: new Date().toISOString(), monthGain, perTicker: per, counts: { priced: per.length, total: holdings.length } };
  if (per.length) monthCache = { at: Date.now(), data };
  return data;
}

// Historical monthly stock P/L, for past-month views on the Command Center.
// gain = shares × (month-end close − month-start close), using current shares as
// a stand-in for what was held that month (same simplification the live calc
// makes). A completed past month never changes, so results cache for a day.
const seriesCache = {}; // ticker -> { at, ts:[], close:[] }
const SERIES_TTL = 6 * 60 * 60 * 1000;
async function getDailySeries(symbol) {
  const key = symbol.toUpperCase();
  const hit = seriesCache[key];
  if (hit && Date.now() - hit.at < SERIES_TTL) return hit;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (res && res.timestamp) || [];
  const close = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const out = { at: Date.now(), ts, close };
  seriesCache[key] = out;
  return out;
}
function closeBefore(series, cutoffSec) {
  let v = null;
  for (let i = 0; i < series.ts.length; i++) { if (series.ts[i] < cutoffSec && series.close[i] != null) v = series.close[i]; }
  return v;
}
const monthHistCache = {}; // ym -> { at, data }
async function getStocksMonthFor(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return { available: false, reason: 'bad_ym', monthGain: 0 };
  if (ym >= new Date().toISOString().slice(0, 7)) return getStocksMonth(); // current/future → live calc
  const hit = monthHistCache[ym];
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.data;
  let holdings = [];
  try {
    const pf = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    holdings = (pf.holdings || []).filter((h) => h && h.ticker && toNumber(h.shares, 0) > 0);
  } catch { return { available: false, reason: 'no_portfolio', monthGain: 0 }; }
  if (!holdings.length) return { available: false, reason: 'empty', monthGain: 0 };
  const [y, m] = ym.split('-').map(Number);
  const startSec = Math.floor(Date.UTC(y, m - 1, 1) / 1000); // first day of the month
  const endSec = Math.floor(Date.UTC(y, m, 1) / 1000);       // first day of the next month
  const per = (await pool(holdings, 5, async (h) => {
    const symbol = String(h.ticker).toUpperCase();
    const shares = toNumber(h.shares, 0);
    try {
      const s = await getDailySeries(symbol);
      const start = closeBefore(s, startSec); // last close before the month began
      const end = closeBefore(s, endSec);     // last close within the month
      if (start == null || end == null) return null; // not enough history for that month
      return { ticker: symbol, shares, start, end, gain: shares * (end - start) };
    } catch { return null; }
  })).filter(Boolean);
  const monthGain = per.reduce((s, p) => s + (p.gain || 0), 0);
  const data = { available: per.length > 0, ym, timestamp: new Date().toISOString(), monthGain, perTicker: per, counts: { priced: per.length, total: holdings.length } };
  if (per.length) monthHistCache[ym] = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------

module.exports = { quoteCache, QUOTE_TTL, fetchYahooQuote, getEarnings, getStocksMonth, getStocksMonthFor, liveOrCachedPrice };
