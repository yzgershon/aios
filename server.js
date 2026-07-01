'use strict';

/*
 * AIOS — Yish's AI Operating System
 * Local single-pane dashboard + embedded interactive Claude Code terminal.
 * Express + ws + node-pty. Binds loopback only. Serves only ./public.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execSync, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

// node-pty: prefer the official package; fall back to the prebuilt-multiarch
// fork (it ships Node 24 / ABI-137 binaries). require() throws on an
// ABI-mismatched native binary too, so this also recovers a bad install.
let pty = null;
let ptyError = null;
for (const mod of ['node-pty', '@homebridge/node-pty-prebuilt-multiarch']) {
  try { pty = require(mod); break; }
  catch (e) { ptyError = e; }
}


// ---------------------------------------------------------------------------
// Modules — the server is now routes + terminal + listeners; everything else
// lives in lib/ (config, util, market, content, crm, leads, store, brief,
// claude). Each module is self-contained; shared state stays in its owner.
// ---------------------------------------------------------------------------
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./lib/config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, slugify, pool, freshness, markFresh } = require('./lib/util');
const { quoteCache, QUOTE_TTL, fetchYahooQuote, getEarnings, getStocksMonth, getStocksMonthFor } = require('./lib/market');
const { getYouTube, getSocial, getTikTok, getTrends, getContent, getComments, refreshSocial, readSocialCache, stampNewContent, SOCIAL_TTL } = require('./lib/content');
const { getLocalDemand, pollNextdoorLeads, readNextdoorStore, isNextdoorPolling, NEXTDOOR_POLL_TTL } = require('./lib/leads');
const { getCrm } = require('./lib/crm');
const { getProjects, getMetrics, defaultMetrics, normalizeMetrics, getPortfolio, computePortfolio, getNetWorth, snapshotNetWorth, NETWORTH_HISTORY_FILE, getPipeline, defaultPipeline, normalizePipelineCard, PIPELINE_COLUMNS, PIPELINE_COLUMN_SET, PIPELINE_MAX_CARDS, getGoals, normalizeGoals, parseVault, getTodos } = require('./lib/store');
const { readBrief, generateBrief, readBriefHistory, isBriefGenerating } = require('./lib/brief');
const { CLAUDE, buildSpawn, ptyEnv } = require('./lib/claude');

// ---------------------------------------------------------------------------
// Express app — serves ONLY ./public (no dotfiles, no project root)
// ---------------------------------------------------------------------------
const app = express();

// ---------------------------------------------------------------------------
// Host allowlist — first middleware, covers every route and static file.
// Blocks DNS rebinding: a malicious site pointing its own domain at 127.0.0.1
// would otherwise get same-origin access to this API (vault notes, portfolio
// writes, Apify-spending refresh triggers). Loopback + the Tailscale IP +
// *.ts.net MagicDNS names are allowed; anything else is refused.
// ---------------------------------------------------------------------------
const HOST_ALLOW = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (HOST_ALLOW.has(host) || /\.ts\.net(:\d+)?$/.test(host)) return next();
  res.status(403).json({ error: 'unrecognized Host header' });
});
app.disable('x-powered-by');

app.get('/api/data', async (req, res) => {
  const errors = [];
  const [youtube, social, projects, metrics, trends, localDemand, netWorth] = await Promise.all([
    settle('youtube', getYouTube, errors),
    settle('social', getSocial, errors),
    settle('projects', getProjects, errors),
    settle('metrics', getMetrics, errors),
    settle('trends', getTrends, errors),
    settle('localDemand', getLocalDemand, errors),
    settle('netWorth', getNetWorth, errors),
  ]);
  const tiktok = await settle('tiktok', getTikTok, errors);
  const comments = await settle('comments', () => getComments(youtube, social, tiktok), errors);
  let content = await settle('content', () => getContent(youtube, social, tiktok), errors);
  content = await settle('seen', () => stampNewContent(content), errors) || content;
  res.json({
    timestamp: new Date().toISOString(),
    skills: SKILLS,
    youtube: youtube || { available: false, reason: 'error', message: 'YouTube fetch failed.' },
    content: content || { available: false, items: [], counts: { all: 0 } },
    tiktok: tiktok || { available: false, reason: 'error', tiktok: null },
    metrics: metrics || defaultMetrics(),
    netWorth: netWorth || { available: false, currency: 'USD', motorcycle: 0, cash: 0, stocks: 0, total: 0 },
    social: social || { available: false, reason: 'error', instagram: null },
    projects: projects || { available: false, reason: 'error', active: [], counts: { active: 0 } },
    trends: trends || { available: false, reason: 'error', trending: [], competitors: [] },
    comments: comments || { available: false, comments: [], counts: { all: 0 } },
    localDemand: localDemand || { available: true, hasLeads: false, leads: [] },
    errors,
  });
});

app.get('/api/todos', async (req, res) => {
  try { res.json(await getTodos()); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e), items: [] }); }
});

app.get('/api/crm', async (req, res) => {
  try { res.json(await getCrm(req.query.force === '1')); }
  catch (e) { res.status(502).json({ available: false, error: String((e && e.message) || e), clients: [], bookings: [] }); }
});

app.get('/api/earnings', async (req, res) => {
  const errors = [];
  res.json(await settle('earnings', getEarnings, errors) || { available: false, reason: 'error', rows: [] });
});

app.get('/api/stocks/month', async (req, res) => {
  const errors = [];
  const ym = (req.query.ym || '').toString().trim();
  if (ym) { res.json(await settle('stocksMonth:' + ym, () => getStocksMonthFor(ym), errors) || { available: false, reason: 'error', monthGain: 0 }); return; }
  res.json(await settle('stocksMonth', getStocksMonth, errors) || { available: false, reason: 'error', monthGain: 0 });
});

app.post('/api/leads/refresh', async (req, res) => {
  if (!NEXTDOOR_IMAP_USER || !NEXTDOOR_IMAP_PASS) return res.status(400).json({ error: 'not_configured' });
  if (isNextdoorPolling()) return res.json({ polling: true });
  try {
    const r = await pollNextdoorLeads(true);
    res.json({ ok: true, ...(r || {}) });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/metrics', async (req, res) => {
  const errors = [];
  res.json(await getMetrics(errors));
});

app.post('/api/metrics', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const next = normalizeMetrics(req.body);
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomic(METRICS_FILE, next);
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/social/refresh', async (req, res) => {
  if (!APIFY_API_TOKEN) return res.status(400).json({ error: 'no_token' });
  if (socialRefreshing) return res.json({ refreshing: true });
  try {
    const payload = await refreshSocial();
    res.json({ ok: true, ...(payload || {}) });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/portfolio', async (req, res) => {
  const errors = [];
  res.json(await settle('portfolio', getPortfolio, errors) || { available: false, reason: 'error', currency: 'USD', positions: [] });
});

app.post('/api/portfolio', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    // Preserve prevClose (the day-change baseline) for existing tickers when the
    // edit form doesn't send it, so a Save never silently zeroes the "Today" stat.
    const prevMap = {};
    try {
      const cur = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
      for (const h of (cur.holdings || [])) {
        if (h && h.prevClose != null) prevMap[String(h.ticker || '').toUpperCase().slice(0, 8)] = toNumber(h.prevClose, 0);
      }
    } catch { /* no prior file is fine */ }
    const holdings = (Array.isArray(body.holdings) ? body.holdings : []).slice(0, 100).map((h) => {
      const row = {
        ticker: String(h.ticker || '').toUpperCase().slice(0, 8),
        name: typeof h.name === 'string' ? h.name.slice(0, 40) : '',
        shares: toNumber(h.shares, 0),
        avgCost: toNumber(h.avgCost, 0),
        price: toNumber(h.price, 0),
      };
      if (h.prevClose != null && h.prevClose !== '') row.prevClose = toNumber(h.prevClose, 0);
      else if (prevMap[row.ticker] != null) row.prevClose = prevMap[row.ticker];
      if (typeof h.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.since)) row.since = h.since;
      return row;
    }).filter((h) => h.ticker);
    const out = { currency: String(body.currency || 'USD').slice(0, 8), holdings, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(PORTFOLIO_FILE, out);
    res.json(computePortfolio(out));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/quotes', async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s)).slice(0, 40);
  const now = Date.now();
  const need = syms.filter((s) => !(quoteCache[s] && now - quoteCache[s].at < QUOTE_TTL));
  await Promise.allSettled(need.map(async (s) => { try { quoteCache[s] = { at: Date.now(), data: await fetchYahooQuote(s) }; } catch { /* keep prior */ } }));
  const quotes = {};
  for (const s of syms) if (quoteCache[s]) quotes[s] = quoteCache[s].data;
  res.json({ quotes, at: new Date().toISOString() });
});

app.get('/api/networth/history', async (req, res) => {
  try {
    const j = JSON.parse(await fsp.readFile(NETWORTH_HISTORY_FILE, 'utf8'));
    res.json({ history: Array.isArray(j) ? j : [] });
  } catch { res.json({ history: [] }); }
});

app.get('/api/brief/history', async (req, res) => {
  res.json({ briefs: await readBriefHistory() });
});

app.get('/api/freshness', async (req, res) => {
  // live-marked sources + file-backed timestamps for the poll-driven ones
  const out = { ...freshness };
  try { const c = await readSocialCache(); if (c && c.fetchedAt) out.social = c.fetchedAt; } catch { /* absent */ }
  try { const n = await readNextdoorStore(); if (n && n.lastPolledAt) out.nextdoor = n.lastPolledAt; } catch { /* absent */ }
  try { const b = await readBrief(); if (b && b.generatedAt) out.brief = b.generatedAt; } catch { /* absent */ }
  res.json({ at: new Date().toISOString(), sources: out });
});

app.get('/api/vault', (req, res) => {
  try { res.json(parseVault()); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e), nodes: [], edges: [], counts: {} }); }
});

app.get('/api/vault/note', (req, res) => {
  const rel = String(req.query.path || '');
  const base = path.resolve(VAULT_DIR);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return res.status(403).json({ error: 'outside vault' });
  if (!resolved.toLowerCase().endsWith('.md')) return res.status(400).json({ error: 'not markdown' });
  fs.readFile(resolved, 'utf8', (err, content) => {
    if (err) return res.status(404).json({ error: 'not found' });
    res.json({ title: path.basename(resolved, '.md'), path: rel, content: content.slice(0, 80000) });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, pty: !!pty, ptyError: pty ? null : String((ptyError && ptyError.message) || ptyError) });
});

app.get('/api/pipeline', async (req, res) => {
  try { res.json(await getPipeline()); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e), ...defaultPipeline() }); }
});

app.post('/api/pipeline', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.cards)) return res.status(400).json({ error: 'cards must be an array' });
    if (body.cards.length > PIPELINE_MAX_CARDS) return res.status(400).json({ error: 'too many cards (max ' + PIPELINE_MAX_CARDS + ')' });
    for (const c of body.cards) {
      if (!c || !PIPELINE_COLUMN_SET.has(c.stage)) return res.status(400).json({ error: 'invalid card stage' });
    }
    const state = { columns: PIPELINE_COLUMNS.slice(), cards: body.cards.map(normalizePipelineCard) };
    await writeJsonAtomic(PIPELINE_FILE, state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/goals', async (req, res) => {
  try { res.json(await getGoals()); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e), goals: [] }); }
});

app.post('/api/goals', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.goals)) return res.status(400).json({ error: 'goals must be an array' });
    if (body.goals.length > 50) return res.status(400).json({ error: 'too many goals (max 50)' });
    for (const g of body.goals) {
      if (!g || typeof g.name !== 'string' || !g.name.trim()) return res.status(400).json({ error: 'every goal needs a name' });
      if (!(toNumber(g.target, 0) > 0)) return res.status(400).json({ error: 'every goal needs a target > 0' });
    }
    await writeJsonAtomic(GOALS_FILE, normalizeGoals(body));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/brief', async (req, res) => {
  const cached = await readBrief();
  if (!cached) return res.json({ status: 'none' });
  // A 'generating' file with no run in flight = the server restarted mid-run;
  // surface it as an error so the client doesn't poll forever.
  if (cached.status === 'generating' && !isBriefGenerating()) {
    return res.json({ ...cached, status: 'error', error: 'generation interrupted' });
  }
  res.json(cached);
});

app.post('/api/brief/generate', (req, res) => {
  if (isBriefGenerating()) return res.json({ status: 'generating' });
  generateBrief().catch(() => {}); // fire-and-forget; client polls GET /api/brief
  res.json({ status: 'started' });
});

// Same-origin image proxy — social CDNs (TikTok/Instagram) send a
// Cross-Origin-Resource-Policy that blocks cross-origin <img> embedding.
// Allowlisted hosts only (no open proxy / SSRF).
const IMG_HOST_ALLOW = /(?:^|\.)(?:tiktokcdn-\w+\.com|tiktokcdn\.com|tiktokcdn-eu\.com|cdninstagram\.com|fbcdn\.net|ytimg\.com|ggpht\.com)$/i;
app.get('/api/img', async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || '')); } catch { return res.status(400).end(); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).end();
  if (!IMG_HOST_ALLOW.test(u.hostname)) return res.status(403).end();
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: u.origin + '/' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

app.use(express.static(path.join(PROJECT_DIR, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
  etag: true,
  // Force the browser to revalidate JS/CSS/HTML on every load so a server
  // restart always serves the latest dashboard code (no stale cached bundles).
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------------------------------------------------------------------------
// Embedded terminal — node-pty over WebSocket
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
]);
const MAX_SESSIONS = 4;
let sessionCount = 0;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

function handleUpgrade(req, socket, head) {
  let pathname = '/';
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch { /* ignore */ }
  if (pathname !== '/terminal') { socket.destroy(); return; }

  // Origin check — WebSockets bypass same-origin policy. Exact scheme+host+port.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Concurrency cap (fork-bomb guard). Reserve the slot now; release on socket end.
  if (sessionCount >= MAX_SESSIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sessionCount++;
  let released = false;
  const release = () => { if (!released) { released = true; sessionCount--; } };
  socket.on('close', release);
  socket.on('error', release);

  if (!pty) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

wss.on('connection', (ws, req) => {
  let params;
  try { params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams; }
  catch { params = new URLSearchParams(); }

  const raw = params.get('skill') || '';
  let skill = '';
  if (raw) {
    if (SKILL_SET.has(raw) && SKILL_RE.test(raw)) skill = raw;
    else { try { ws.send('\r\n\x1b[31m[AIOS] Unknown skill rejected.\x1b[0m\r\n'); } catch {} ws.close(); return; }
  }
  const cols = Math.min(500, Math.max(20, toNumber(params.get('cols'), 80)));
  const rows = Math.min(200, Math.max(5, toNumber(params.get('rows'), 24)));

  let proc;
  try {
    const { file, args } = buildSpawn(skill);
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: CLAUDE_CWD,
      env: ptyEnv(),
    });
  } catch (e) {
    try { ws.send('\r\n\x1b[31m[AIOS] Failed to start Claude: ' + String((e && e.message) || e) + '\x1b[0m\r\n'); } catch {}
    ws.close();
    return;
  }

  let killed = false;
  const kill = () => { if (killed) return; killed = true; try { proc.kill(); } catch {} };

  proc.onData((d) => { try { ws.send(d); } catch {} });
  proc.onExit(() => { killed = true; try { ws.close(); } catch {} });

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m && m.type === 'input' && typeof m.data === 'string') {
      try { proc.write(m.data); } catch {}
    } else if (m && m.type === 'resize') {
      const c = Math.min(500, Math.max(2, toNumber(m.cols, cols)));
      const r = Math.min(200, Math.max(1, toNumber(m.rows, rows)));
      try { proc.resize(c, r); } catch {}
    }
  });
  ws.on('close', kill);
  ws.on('error', kill);
});

// ---------------------------------------------------------------------------
// Listen on loopback — both IPv4 (127.0.0.1) and IPv6 (::1) so `localhost`
// resolves regardless of OS preference. Optionally also on the Tailscale
// interface (see below). Never bound to the LAN or any public interface.
// ---------------------------------------------------------------------------
// Detect a Tailscale-assigned IPv4 (CGNAT range 100.64.0.0/10). Returns the
// address string, or null if Tailscale isn't up. Matches the address range
// rather than the adapter name, so it survives interface renaming.
function findTailscaleIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const m = addr.address.match(/^100\.(\d+)\./);
      if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return addr.address;
    }
  }
  return null;
}
// ---------------------------------------------------------------------------
// Bind both loopback interfaces. Exit fatally only if NEITHER could bind — a
// conflict/failure on one interface must not tear down a healthy listener on
// the other (order-independent via a settle counter).
let bindPending = 0;
let anyListening = false;
function listenOn(host, label) {
  bindPending++;
  const server = http.createServer(app);
  server.on('upgrade', handleUpgrade);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    bindPending--;
    if (bindPending === 0 && !anyListening) {
      console.error(`[AIOS] Port ${PORT} is in use on all loopback interfaces. Stop the other process or set PORT in .env.`);
      process.exit(1);
    }
  };
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[AIOS] ${label}:${PORT} in use; skipping that interface.`);
      settle();
    } else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
      console.warn(`[AIOS] ${label} not available (${err.code}); skipping that interface.`);
      settle();
    } else {
      console.error(`[AIOS] Server error on ${label}:`, err.message);
    }
  });
  server.listen(PORT, host, () => {
    anyListening = true;
    if (!settled) { settled = true; bindPending--; }
    console.log(`[AIOS] http://${label}:${PORT}`);
  });
  return server;
}

listenOn('127.0.0.1', '127.0.0.1');
listenOn('::1', '[::1]');

// Tailscale: if a Tailnet interface is up (CGNAT range 100.64.0.0/10), also bind
// to it so the dashboard is reachable from YOUR devices over the private Tailnet
// — and only there. The LAN/public interface is never bound, so nobody on your
// home WiFi (or the internet) can reach it; only devices signed into your
// Tailscale account can. If Tailscale isn't running, this does nothing.
const tailscaleIp = findTailscaleIp();
if (tailscaleIp) {
  HOST_ALLOW.add(`${tailscaleIp}:${PORT}`);
  listenOn(tailscaleIp, tailscaleIp);
  console.log(`[AIOS] Tailnet access: http://${tailscaleIp}:${PORT} (phone)`);
} else {
  console.log('[AIOS] Tailscale not detected — loopback only (run `tailscale up`, then restart to enable phone access).');
}

console.log(`[AIOS] data dir: ${AIOS_DATA_DIR}`);
console.log(`[AIOS] claude:   ${CLAUDE.value} [${CLAUDE.kind}]  (cwd: ${CLAUDE_CWD})`);
if (!pty) console.warn('[AIOS] node-pty unavailable — terminal disabled.', (ptyError && ptyError.message) || '');

// Warm the social cache once on boot (no-op without an Apify token).
if (APIFY_API_TOKEN) {
  readSocialCache().then((cache) => {
    const ts = cache && cache.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
    const fresh = Number.isFinite(ts) && (Date.now() - ts < SOCIAL_TTL);
    if (!fresh) refreshSocial().catch(() => {});
  });
}

// Nextdoor lead capture — poll on boot + every 15 min (no-op without creds).
if (NEXTDOOR_IMAP_USER && NEXTDOOR_IMAP_PASS) {
  console.log(`[AIOS] Nextdoor leads: watching ${NEXTDOOR_IMAP_USER} for ${NEXTDOOR_KEYWORDS.length} keywords`);
  pollNextdoorLeads(true).catch(() => {});
  setInterval(() => pollNextdoorLeads().catch(() => {}), NEXTDOOR_POLL_TTL);
} else {
  console.log('[AIOS] Nextdoor leads: not configured (set NEXTDOOR_IMAP_USER + NEXTDOOR_IMAP_PASS in .env)');
}

process.on('uncaughtException', (e) => console.error('[AIOS] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[AIOS] unhandledRejection:', e));

// Net-worth history — snapshot on boot (after quote warmup) + every 6 h.
setTimeout(() => snapshotNetWorth(), 25 * 1000);
setInterval(() => snapshotNetWorth(), 6 * 60 * 60 * 1000);
