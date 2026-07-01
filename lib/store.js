'use strict';
// AIOS file-backed stores — projects, metrics, portfolio, net worth (+ daily
// history), lead pipeline, goals, the vault graph, and to-do seeds.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, pool, freshness, markFresh } = require('./util');
const { quoteCache, QUOTE_TTL, fetchYahooQuote } = require('./market');

// ---------------------------------------------------------------------------
// Projects — tolerant markdown-table parser
// ---------------------------------------------------------------------------
function parseMarkdownTable(md) {
  const rows = md.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.length > 1)
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const isSep = (r) => r.length > 0 && r.every((c) => /^:?-+:?$/.test(c) || c === '');
  const nonSep = rows.filter((r) => !isSep(r));
  return nonSep.slice(1); // drop the header row
}

async function getProjects() {
  let raw;
  try { raw = await fsp.readFile(PROJECTS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: 'no_file', active: [], counts: { active: 0 } };
    throw e;
  }
  const active = parseMarkdownTable(raw).map((r, i) => ({
    slug: slugify(r[0] || ('project-' + i)),
    name: r[0] || 'Untitled',
    status: r[1] || '',
    summary: r[2] || '',
  })).filter((p) => p.name && p.name !== 'Untitled');
  return { available: true, active, counts: { active: active.length } };
}

// ---------------------------------------------------------------------------
// Manual metrics — file-backed, atomic write
// ---------------------------------------------------------------------------
function defaultMetrics() {
  return {
    // Net-worth assets outside the brokerage. Stocks come live from the portfolio.
    assets: { motorcycle: 0, cash: 0, savings: 0, currency: 'USD' },
    instagram: { followers: 0, note: '' },
    updatedAt: null,
  };
}

function normalizeMetrics(m) {
  m = m || {};
  const cap = (s, n = 120) => (typeof s === 'string' ? s.slice(0, n) : '');
  // Migrate the old single-value `mrr` field → assets (cash) so nothing is lost.
  const a = m.assets || {};
  const legacy = m.mrr || {};
  const ig = m.instagram || {};
  return {
    assets: {
      motorcycle: toNumber(a.motorcycle, 0),
      cash: toNumber(a.cash, m.assets ? 0 : toNumber(legacy.value, 0)),
      savings: toNumber(a.savings, 0), // bank savings / inheritance, separate from operating cash
      currency: cap(a.currency || legacy.currency || 'USD', 8),
    },
    instagram: {
      followers: toNumber(ig.followers, 0),
      note: cap(ig.note || '', 120),
    },
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : null,
  };
}

async function getMetrics(errors) {
  let raw;
  try { raw = await fsp.readFile(METRICS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return defaultMetrics();
    throw e;
  }
  try { return normalizeMetrics(JSON.parse(raw)); }
  catch {
    try { await fsp.rename(METRICS_FILE, METRICS_FILE + '.corrupt'); } catch { /* ignore */ }
    if (errors) errors.push({ source: 'metrics', message: 'metrics.json was corrupt; backed up to .corrupt and reset' });
    return defaultMetrics();
  }
}

// ---------------------------------------------------------------------------
// Portfolio — file-backed holdings; prices are manual for now (live API later).
// ---------------------------------------------------------------------------
function computePortfolio(raw) {
  const currency = (raw && raw.currency) || 'USD';
  const holdings = Array.isArray(raw && raw.holdings) ? raw.holdings : [];
  let totalValue = 0, totalCost = 0, dayChange = 0;
  const positions = holdings.map((h) => {
    const shares = toNumber(h.shares, 0);
    const price = toNumber(h.price, 0);
    const avgCost = toNumber(h.avgCost, 0);
    const prevClose = h.prevClose != null ? toNumber(h.prevClose, price) : null;
    const value = shares * price;
    const cost = shares * avgCost;
    const gain = value - cost;
    const dchg = prevClose != null ? shares * (price - prevClose) : 0;
    totalValue += value; totalCost += cost; dayChange += dchg;
    return {
      ticker: String(h.ticker || '').toUpperCase().slice(0, 8),
      name: String(h.name || '').slice(0, 40),
      shares, price, avgCost, value, gain,
      gainPct: cost > 0 ? (gain / cost) * 100 : 0,
      dayChange: dchg,
      dayChangePct: prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    };
  });
  for (const p of positions) p.weight = totalValue > 0 ? (p.value / totalValue) * 100 : 0;
  positions.sort((a, b) => b.value - a.value);
  const totalGain = totalValue - totalCost;
  const prevTotal = totalValue - dayChange;
  return {
    available: positions.length > 0,
    currency,
    totalValue, totalCost, totalGain,
    totalGainPct: totalCost > 0 ? (totalGain / totalCost) * 100 : 0,
    dayChange,
    dayChangePct: prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0,
    positions,
    updatedAt: (raw && raw.updatedAt) || null,
  };
}

async function getPortfolio() {
  let raw;
  try { raw = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: 'no_file', currency: 'USD', positions: [], totalValue: 0, totalGain: 0, dayChange: 0 };
    throw e;
  }
  return computePortfolio(raw);
}

// ---------------------------------------------------------------------------
// Net worth — manual assets (motorcycle, bank) + live brokerage value.
// Stocks use live Yahoo quotes (4s server cache); falls back to the last saved
// portfolio price per holding if a quote is unavailable, so a Yahoo blip never
// blanks the figure. This is what powers the Command Center "Net Worth" tile.
// ---------------------------------------------------------------------------
async function getNetWorth(errors) {
  const metrics = await getMetrics(errors);
  const assets = metrics.assets || { motorcycle: 0, cash: 0, savings: 0 };
  const currency = assets.currency || 'USD';
  const motorcycle = toNumber(assets.motorcycle, 0);
  const cash = toNumber(assets.cash, 0);
  const savings = toNumber(assets.savings, 0);

  let holdings = [];
  try {
    const pf = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    holdings = Array.isArray(pf.holdings) ? pf.holdings : [];
  } catch { /* no portfolio is fine — net worth is still bike + bank */ }

  // Refresh any stale quotes for held tickers (same cache the portfolio uses).
  const syms = Array.from(new Set(holdings
    .map((h) => String(h.ticker || '').toUpperCase())
    .filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s))));
  const now = Date.now();
  const need = syms.filter((s) => !(quoteCache[s] && now - quoteCache[s].at < QUOTE_TTL));
  await Promise.allSettled(need.map(async (s) => {
    try { quoteCache[s] = { at: Date.now(), data: await fetchYahooQuote(s) }; } catch { /* keep prior / fall back */ }
  }));

  let stocks = 0, priced = 0, live = false;
  for (const h of holdings) {
    const t = String(h.ticker || '').toUpperCase();
    const shares = toNumber(h.shares, 0);
    const q = quoteCache[t];
    let price;
    if (q && q.data && q.data.price != null) { price = q.data.price; live = true; }
    else price = toNumber(h.price, 0);
    if (price > 0) priced++;
    stocks += shares * price;
  }

  return {
    available: true,
    currency,
    motorcycle, cash, savings, stocks,
    total: motorcycle + cash + savings + stocks,
    live,
    counts: { holdings: holdings.length, priced },
    updatedAt: metrics.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Lead pipeline — file-backed kanban (pipeline.json). Fresh Nextdoor leads
// auto-import as cards in 'new' on every GET; the board itself is owned by the
// frontend and saved back whole via POST.
// ---------------------------------------------------------------------------
const PIPELINE_COLUMNS = ['new', 'contacted', 'booked', 'done'];
const PIPELINE_COLUMN_SET = new Set(PIPELINE_COLUMNS);
const PIPELINE_MAX_CARDS = 500;

function randomId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

function defaultPipeline() {
  return { columns: PIPELINE_COLUMNS.slice(), cards: [] };
}

function normalizePipelineCard(c) {
  c = c || {};
  const cap = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const card = {
    id: cap(c.id, 48) || randomId('card'),
    srcId: cap(c.srcId, 300),
    name: cap(c.name, 220),
    source: cap(c.source, 40) || 'manual',
    area: cap(c.area, 40),
    note: cap(c.note, 300),
    link: cap(c.link, 600),
    createdAt: typeof c.createdAt === 'string' ? c.createdAt.slice(0, 40) : new Date().toISOString(),
    importedAt: typeof c.importedAt === 'string' ? c.importedAt.slice(0, 40) : null,
    stage: PIPELINE_COLUMN_SET.has(c.stage) ? c.stage : 'new',
  };
  if (c.value != null && c.value !== '') card.value = toNumber(c.value, 0);
  return card;
}

async function readPipeline() {
  let raw;
  try { raw = await fsp.readFile(PIPELINE_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return defaultPipeline();
    throw e;
  }
  try {
    const p = JSON.parse(raw);
    return {
      columns: PIPELINE_COLUMNS.slice(),
      cards: (Array.isArray(p.cards) ? p.cards : []).slice(0, PIPELINE_MAX_CARDS).map(normalizePipelineCard),
    };
  } catch {
    try { await fsp.rename(PIPELINE_FILE, PIPELINE_FILE + '.corrupt'); } catch { /* ignore */ }
    return defaultPipeline();
  }
}

// Stable import key per lead: the poller's _key when present (link || messageId
// || snippet), else link, else title+capturedAt — so re-imports never duplicate.
function leadSrcId(l) {
  const key = l.link || l._key || ((l.title || '') + '|' + (l.capturedAt || l.time || ''));
  return String(key).slice(0, 300);
}

// ---- Meta lead-form import (Google Sheet the instant form delivers to) ----
// Polled lazily on GET /api/pipeline, cached 10 min, single-flight, 5-min
// negative cache on failure. The sheet must be link-viewable.
const META_SHEET_TTL = 10 * 60 * 1000;
const META_SHEET_ERR_TTL = 5 * 60 * 1000;
let metaSheetCache = { at: 0, errAt: 0, leads: [] };
let metaSheetInFlight = null;

function metaSheetCsvUrl(raw) {
  const m = String(raw).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  const id = m ? m[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(raw) ? raw : null);
  if (!id) return null;
  const gid = (String(raw).match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

// minimal quote-aware CSV → array of rows
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function metaLeadsFromRows(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || '').toLowerCase());
  const col = (...needles) => header.findIndex((h) => needles.some((n) => h.includes(n)));
  const cId = col('lead id', 'id');
  const cName = col('full name', 'full_name', 'name');
  const cPhone = col('phone');
  const cEmail = col('email');
  const cArea = col('city', 'town', 'area', 'zip', 'postal');
  const cTime = col('created', 'time', 'date');
  const cVehicle = col('vehicle', 'car', 'service');
  const out = [];
  for (const r of rows.slice(1)) {
    const get = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    const name = get(cName);
    const phone = get(cPhone), email = get(cEmail);
    if (!name && !phone && !email) continue;
    const created = get(cTime);
    const srcId = 'meta:' + (get(cId) || (created + '|' + (phone || email || name))).slice(0, 280);
    const note = [phone, email, get(cVehicle)].filter(Boolean).join(' · ').slice(0, 290);
    let createdAt = new Date().toISOString();
    if (created) { const d = new Date(created); if (!Number.isNaN(d.getTime())) createdAt = d.toISOString(); }
    out.push({ srcId, name: name || phone || email, area: get(cArea), note, createdAt });
  }
  return out;
}

async function fetchMetaSheetLeads() {
  if (!META_LEADS_SHEET_URL) return [];
  const now = Date.now();
  if (now - metaSheetCache.at < META_SHEET_TTL) return metaSheetCache.leads;
  if (now - metaSheetCache.errAt < META_SHEET_ERR_TTL) return metaSheetCache.leads;
  if (metaSheetInFlight) return metaSheetInFlight;
  metaSheetInFlight = (async () => {
    try {
      const url = metaSheetCsvUrl(META_LEADS_SHEET_URL);
      if (!url) throw new Error('bad META_LEADS_SHEET_URL');
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('sheet ' + r.status);
      const text = await r.text();
      if (/<html/i.test(text.slice(0, 300))) throw new Error('sheet not link-viewable (got a login page)');
      metaSheetCache = { at: Date.now(), errAt: 0, leads: metaLeadsFromRows(parseCsv(text)) };
    } catch (e) {
      metaSheetCache.errAt = Date.now();
      console.error('[meta-leads]', String((e && e.message) || e));
    } finally {
      metaSheetInFlight = null;
    }
    return metaSheetCache.leads;
  })();
  return metaSheetInFlight;
}

async function getPipeline() {
  const state = await readPipeline();
  const have = new Set(state.cards.map((c) => c.srcId).filter(Boolean));
  const now = new Date().toISOString();
  let imported = 0;
  const metaLeads = await fetchMetaSheetLeads();
  for (const l of metaLeads) {
    if (!l.srcId || have.has(l.srcId)) continue;
    have.add(l.srcId);
    state.cards.push(normalizePipelineCard({
      id: randomId('card'),
      srcId: l.srcId,
      name: l.name || 'Meta lead',
      source: 'meta',
      area: l.area || '',
      note: l.note || '',
      createdAt: l.createdAt || now,
      importedAt: now,
      stage: 'new',
    }));
    imported++;
  }
  if (imported) {
    state.cards = state.cards.slice(0, PIPELINE_MAX_CARDS);
    await writeJsonAtomic(PIPELINE_FILE, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Goals — file-backed savings goals (goals.json)
// ---------------------------------------------------------------------------
function defaultGoals() {
  return { goals: [] };
}

function normalizeGoals(g) {
  g = g || {};
  const cap = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const goals = (Array.isArray(g.goals) ? g.goals : []).slice(0, 50).map((it) => {
    it = it || {};
    const out = {
      id: cap(it.id, 48) || randomId('goal'),
      name: cap(it.name, 80),
      icon: cap(it.icon, 8),
      target: Math.max(toNumber(it.target, 0), 0),
      saved: Math.max(toNumber(it.saved, 0), 0),
    };
    if (typeof it.deadline === 'string' && /^\d{4}-\d{2}-\d{2}/.test(it.deadline)) out.deadline = it.deadline.slice(0, 10);
    if (it.lastMilestone != null && it.lastMilestone !== '') out.lastMilestone = toNumber(it.lastMilestone, 0);
    return out;
  }).filter((it) => it.name && it.target > 0);
  return { goals };
}

async function getGoals() {
  let raw;
  try { raw = await fsp.readFile(GOALS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return defaultGoals();
    throw e;
  }
  try { return normalizeGoals(JSON.parse(raw)); }
  catch {
    try { await fsp.rename(GOALS_FILE, GOALS_FILE + '.corrupt'); } catch { /* ignore */ }
    return defaultGoals();
  }
}

// ---------------------------------------------------------------------------
// Net-worth history — one snapshot per day (last write wins), so the Net Worth
// tile can show where the number has been, not just where it is. Snapshots on
// boot (after quote warmup) + every 6 h; ~2 years retained.
// ---------------------------------------------------------------------------
const NETWORTH_HISTORY_FILE = path.join(AIOS_DATA_DIR, 'networth-history.json');
async function snapshotNetWorth() {
  try {
    const nw = await getNetWorth([]);
    if (!nw || !nw.available || !(nw.total > 0)) return;
    const today = new Date().toISOString().slice(0, 10);
    let hist = [];
    try { hist = JSON.parse(await fsp.readFile(NETWORTH_HISTORY_FILE, 'utf8')); } catch { /* first run */ }
    if (!Array.isArray(hist)) hist = [];
    const entry = {
      date: today,
      total: Math.round(nw.total),
      motorcycle: Math.round(nw.motorcycle), cash: Math.round(nw.cash),
      savings: Math.round(nw.savings), stocks: Math.round(nw.stocks),
    };
    const i = hist.findIndex((h) => h && h.date === today);
    if (i >= 0) hist[i] = entry; else hist.push(entry);
    hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    await writeJsonAtomic(NETWORTH_HISTORY_FILE, hist.slice(-730));
  } catch { /* next pass */ }
}
// ---------------------------------------------------------------------------
// Obsidian vault — graph of notes (.md) linked by [[wikilinks]]
// ---------------------------------------------------------------------------
const VAULT_EXCLUDE = new Set(['.git', '.obsidian', '.claude', 'node_modules', '.trash', '.vscode', 'AIOS']);
let vaultCache = { at: 0, data: null };
const VAULT_TTL = 30 * 1000;

function walkMd(dir, base, out, depth) {
  if (depth > 8 || out.length > 1200) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (VAULT_EXCLUDE.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, base, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ full, rel: path.relative(base, full) });
  }
}

function parseVault() {
  if (vaultCache.data && Date.now() - vaultCache.at < VAULT_TTL) return vaultCache.data;
  const files = [];
  walkMd(VAULT_DIR, VAULT_DIR, files, 0);
  const sliced = files.slice(0, 600);
  const byKey = {}; // basename / relpath (lower) -> node id
  const nodes = sliced.map((f) => {
    const id = f.rel.replace(/\\/g, '/');
    const title = path.basename(f.rel, '.md');
    byKey[title.toLowerCase()] = id;
    byKey[id.toLowerCase().replace(/\.md$/, '')] = id;
    const folder = path.dirname(f.rel).replace(/\\/g, '/');
    return { id, title, folder: folder === '.' ? '' : folder, deg: 0 };
  });
  const seen = new Set();
  const edges = [];
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  for (let i = 0; i < sliced.length; i++) {
    let text = '';
    try { text = fs.readFileSync(sliced[i].full, 'utf8'); } catch { continue; }
    const src = nodes[i].id;
    let m;
    while ((m = re.exec(text))) {
      const tgt = byKey[m[1].trim().toLowerCase()];
      if (tgt && tgt !== src) {
        const k = src + '|' + tgt;
        if (!seen.has(k)) { seen.add(k); edges.push({ source: src, target: tgt }); }
      }
    }
  }
  const deg = {};
  for (const e of edges) { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1; }
  for (const n of nodes) n.deg = deg[n.id] || 0;
  const data = { nodes, edges, counts: { notes: nodes.length, links: edges.length, total: files.length, vault: path.basename(VAULT_DIR) } };
  vaultCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Focus · To-Do seeds — live in ~/.aios/todos.json (data, not code) so
// updating them never needs a code edit. Seeded once if the file is missing.
// Checks/custom items stay client-side in localStorage, same as before.
// ---------------------------------------------------------------------------
const TODO_DEFAULTS = [
  { id: 'post3', tag: 'biz', title: 'Post 3 short-form detailing videos this week', sub: 'before/after reveals convert best — steal from Trending.' },
  { id: 'lead1h', tag: 'biz', title: 'Reply to every new lead within an hour', sub: 'fastest reply usually wins the booking.' },
  { id: 'reviews', tag: 'biz', title: 'Ask every happy customer for a Google review', sub: 'reviews compound — one ask per completed job.' },
  { id: 'julybook', tag: 'biz', title: 'Book out July — push a summer special on Nextdoor', sub: 'peak season; a full calendar now carries the fall.' },
  { id: 'crmlog', tag: 'money', title: 'Log every job in the CRM same-day', sub: 'the revenue tiles are only as accurate as the CRM.' },
  { id: 'precond', tag: 'me', title: 'Preseason conditioning', sub: 'Surf NE + Newton North season is coming — build the base now.' },
  { id: 'collegelist', tag: 'school', title: 'Draft the college list', sub: 'senior year starts in September — a rough list this summer beats a rushed one in October.' },
  { id: 'essay', tag: 'school', title: 'Brainstorm Common App essay angles', sub: 'jot moments that actually mattered — the businesses, soccer, the builds.' },
];
async function getTodos() {
  try {
    const j = JSON.parse(await fsp.readFile(TODOS_FILE, 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch { /* seed below */ }
  const seeded = { updatedAt: new Date().toISOString(), items: TODO_DEFAULTS };
  await writeJsonAtomic(TODOS_FILE, seeded).catch(() => { /* read-only fs — serve from memory */ });
  return seeded;
}

module.exports = { getProjects, getMetrics, defaultMetrics, normalizeMetrics, getPortfolio, computePortfolio, getNetWorth, snapshotNetWorth, NETWORTH_HISTORY_FILE, getPipeline, defaultPipeline, normalizePipelineCard, PIPELINE_COLUMNS, PIPELINE_COLUMN_SET, PIPELINE_MAX_CARDS, getGoals, normalizeGoals, parseVault, getTodos };
