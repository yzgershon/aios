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
const { synthesizeAudio, listVoices, listElevenLabsVoices, TTS_VOICE, TTS_PROVIDER, ELEVENLABS_ENABLED, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, ACK_LINES, ackPath, FILLER_LINES, fillerPath } = require('./lib/jarvis');
const { codexChat, codexChatStream, getCodexStatus, initializeCodex, resetCodexThread } = require('./lib/codex-brain');
const { tryDirectLocalTool } = require('./lib/jarvis-tools');
const { approvalReason } = require('./lib/jarvis-approval-policy');
const { CLAUDE, buildSpawn, ptyEnv } = require('./lib/claude');

// ---------------------------------------------------------------------------
// Express app — serves ONLY ./public (no dotfiles, no project root)
// ---------------------------------------------------------------------------
const app = express();

// Small in-memory trace for Jarvis. It intentionally stores only event names,
// timings, and status fields - never prompts, transcripts, or secrets.
const jarvisRuntime = {
  startedAt: new Date().toISOString(),
  events: [],
  requests: [],
  voiceStatus: null,
};
function recordJarvisEvent(event, fields = {}) {
  const row = { at: new Date().toISOString(), event: String(event || '').slice(0, 80), ...fields };
  jarvisRuntime.events.push(row);
  if (jarvisRuntime.events.length > 200) jarvisRuntime.events.splice(0, jarvisRuntime.events.length - 200);
  return row;
}
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/jarvis')) return next();
  const started = performance.now();
  res.once('finish', () => {
    jarvisRuntime.requests.push({
      at: new Date().toISOString(), method: req.method, path: req.path,
      status: res.statusCode, ms: Math.round(performance.now() - started),
    });
    if (jarvisRuntime.requests.length > 100) jarvisRuntime.requests.shift();
  });
  next();
});

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
  res.json({
    ok: true,
    pty: !!pty,
    ptyError: pty ? null : String((ptyError && ptyError.message) || ptyError),
    uptimeSec: Math.round(process.uptime()),
    jarvis: { brain: 'codex', brainStatus: getCodexStatus(), voice: jarvisRuntime.voiceStatus },
  });
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

// Jarvis — one conversational turn through the headless claude brain (Phase 0).
// Blocking request/response; streaming comes in a later phase.
app.post('/api/jarvis/chat', express.json({ limit: '32kb' }), async (req, res) => {
  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message : '';
  const history = Array.isArray(body.history) ? body.history : [];
  if (!message.trim()) return res.status(400).json({ error: 'empty message' });
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
  try {
    const direct = await tryDirectLocalTool(message);
    const result = direct && direct.reply
      ? { reply: direct.reply, provider: 'local-direct', model: null, latencyMs: 0, ttftMs: 0 }
      : await codexChat(message, history, { signal: aborter.signal });
    res.json({ ...result, at: new Date().toISOString() });
  } catch (e) {
    if (!res.destroyed) res.status(e.code === 'BUSY' ? 409 : 502).json({ error: String((e && e.message) || e), code: e.code || 'BRAIN_ERROR' });
  }
});

// Jarvis voice — offline local TTS (System.Speech). Returns a WAV the browser
// plays. The frontend falls back to browser speechSynthesis if this 502s.
app.get('/api/jarvis/voices', async (req, res) => {
  try {
    let elevenlabs = [];
    if (ELEVENLABS_ENABLED || process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY) {
      try { elevenlabs = await listElevenLabsVoices(); } catch { elevenlabs = []; }
    }
    res.json({
      provider: TTS_PROVIDER,
      voices: await listVoices(),
      default: TTS_VOICE,
      elevenlabs: {
        configured: ELEVENLABS_ENABLED,
        voiceId: ELEVENLABS_VOICE_ID || null,
        modelId: ELEVENLABS_MODEL_ID,
        voices: elevenlabs,
      },
    });
  }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e), voices: [] }); }
});

// Jarvis streaming turn. Text deltas flow from Codex so the frontend can speak
// sentence-by-sentence while the turn completes.
// Events: {type:'delta', text} ... {type:'done', reply} | {type:'error', error}.
app.post('/api/jarvis/chat-stream', express.json({ limit: '32kb' }), async (req, res) => {
  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message : '';
  const history = Array.isArray(body.history) ? body.history : [];
  if (!message.trim()) return res.status(400).json({ error: 'empty message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const aborter = new AbortController();
  let responseClosed = false;
  res.on('close', () => {
    responseClosed = true;
    if (!res.writableEnded) aborter.abort(new Error('Jarvis client disconnected'));
  });
  const sse = (obj) => {
    if (responseClosed || res.writableEnded) return;
    try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* client gone */ }
  };

  try {
    const onDelta = (text) => sse({ type: 'delta', text });
    const started = performance.now();
    const direct = await tryDirectLocalTool(message);
    const result = direct && direct.reply
      ? { reply: direct.reply, provider: 'local-direct', model: null, latencyMs: Math.round(performance.now() - started), ttftMs: 0 }
      : await codexChatStream(message, history, onDelta, { signal: aborter.signal, onStatus: (status) => sse({ type: 'status', ...status }) });
    if (direct && direct.reply) onDelta(direct.reply);
    recordJarvisEvent('brain.done', {
      provider: result.provider, ms: result.latencyMs, ttftMs: result.ttftMs,
    });
    sse({ type: 'done', ...result });
  } catch (e) {
    const error = String((e && e.message) || e);
    recordJarvisEvent('brain.error', { error: error.slice(0, 160) });
    sse({ type: 'error', error, code: e.code || 'BRAIN_ERROR' });
  }
  if (!responseClosed && !res.writableEnded) res.end();
});

app.get('/api/jarvis/brain-status', (req, res) => res.json(getCodexStatus()));
app.get('/api/jarvis/capabilities', (req, res) => res.json({ capabilities: require('./lib/jarvis-capabilities').catalogue, webSearch: getCodexStatus().webSearch }));
app.post('/api/jarvis/brain-reset', async (req, res) => {
  try { res.json({ ok: true, brain: await resetCodexThread() }); }
  catch (e) {
    const error = String((e && e.message) || e);
    res.status(/busy/i.test(error) ? 409 : 500).json({ ok: false, error });
  }
});

// ---------------------------------------------------------------------------
// Jarvis approvals — the confirm-risky gate (Phase 3). The approval MCP bridge
// POSTs here when the brain wants to run a gated tool; we broadcast the ask to
// the Jarvis UI over SSE and block until Yish clicks Approve/Deny (90s → deny).
// ---------------------------------------------------------------------------
const pendingApprovals = new Map(); // id -> { resolve, info }
const approvalClients = new Set();  // SSE responses
const APPROVAL_TIMEOUT = 90 * 1000;
let approvalSeq = 0;

function approvalBroadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const client of approvalClients) { try { client.write(line); } catch { /* gone */ } }
}

app.post('/api/jarvis/approval-request', express.json({ limit: '64kb' }), async (req, res) => {
  const body = req.body || {};
  const risk = ['read', 'write', 'open', 'execute', 'screen', 'control', 'external', 'destructive', 'money', 'unknown'].includes(String(body.risk))
    ? String(body.risk) : 'unknown';
  const info = {
    id: 'ap-' + Date.now().toString(36) + '-' + (approvalSeq++),
    tool: String(body.tool_name || 'unknown').slice(0, 80),
    input: body.input && typeof body.input === 'object' ? body.input : {},
    risk,
    summary: String(body.summary || '').slice(0, 240),
    at: new Date().toISOString(),
  };
  const reason = body.require_approval === true ? 'tool-policy' : approvalReason(info.tool, info.input);
  const requiresApproval = !!reason;
  if (!requiresApproval) {
    recordJarvisEvent('approval.auto', { tool: info.tool, risk: info.risk });
    return res.json({ allow: true, mode: 'preauthorized-local' });
  }
  recordJarvisEvent('approval.requested', { tool: info.tool, risk: info.risk, reason });
  const decision = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(info.id);
      approvalBroadcast({ type: 'resolved', id: info.id, allow: false });
      resolve({ allow: false, reason: 'timed out waiting for Yish (90s) — denied by default' });
    }, APPROVAL_TIMEOUT);
    pendingApprovals.set(info.id, { info, resolve: (d) => { clearTimeout(timer); resolve(d); } });
    approvalBroadcast({ type: 'approval', ...info });
  });
  res.json(decision);
});

app.post('/api/jarvis/tool-event', express.json({ limit: '8kb' }), (req, res) => {
  const body = req.body || {};
  const fields = {
    tool: String(body.tool || 'unknown').slice(0, 80),
    risk: String(body.risk || 'unknown').slice(0, 20),
  };
  if (Number.isFinite(Number(body.ms))) fields.ms = Math.round(Number(body.ms));
  if (body.ok !== undefined) fields.ok = !!body.ok;
  const event = String(body.event || 'event').replace(/[^a-z0-9_.-]/gi, '').slice(0, 40);
  recordJarvisEvent('tool.' + event, fields);
  if (Number(body.ownerPid) === process.pid) approvalBroadcast({ type: 'tool-activity', event, ...fields });
  res.json({ ok: true });
});

app.get('/api/jarvis/approvals', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  approvalClients.add(res);
  // replay anything already pending so a fresh page can still answer
  for (const { info } of pendingApprovals.values()) {
    try { res.write('data: ' + JSON.stringify({ type: 'approval', ...info }) + '\n\n'); } catch { /* ignore */ }
  }
  const bye = () => approvalClients.delete(res);
  req.on('close', bye);
  res.on('error', bye);
});

app.get('/api/jarvis/approvals-pending', (req, res) => {
  res.json({ pending: [...pendingApprovals.values()].map((p) => p.info) });
});

// Wake acknowledgments - short canned lines spoken after "Hey Jarvis". They use
// the same TTS provider path as normal replies, so ElevenLabs and local Andrew
// stay consistent. Results are cached in memory per server run for instant reuse.
const cannedVoiceCache = new Map();
async function sendCannedVoice(res, key, text, legacyPath) {
  try {
    let audio = cannedVoiceCache.get(key);
    if (!audio) {
      audio = await synthesizeAudio(text);
      cannedVoiceCache.set(key, audio);
    }
    res.setHeader('Content-Type', audio.contentType || 'audio/wav');
    res.setHeader('X-Jarvis-TTS-Provider', audio.provider || 'local');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(audio.buffer);
  } catch {
    res.setHeader('X-Jarvis-TTS-Provider', 'legacy-local');
    return res.sendFile(legacyPath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'canned voice unavailable' });
    });
  }
}
app.get('/api/jarvis/acks', (req, res) => res.json({ count: ACK_LINES.length, lines: ACK_LINES }));
app.get('/api/jarvis/ack', async (req, res) => {
  const i = Math.max(0, Math.min(ACK_LINES.length - 1, Number(req.query.i) || 0));
  await sendCannedVoice(res, 'ack:' + i + ':' + ACK_LINES[i], ACK_LINES[i], ackPath(i));
});
app.get('/api/jarvis/fillers', (req, res) => res.json({ count: FILLER_LINES.length }));
app.get('/api/jarvis/filler', async (req, res) => {
  const i = Math.max(0, Math.min(FILLER_LINES.length - 1, Number(req.query.i) || 0));
  await sendCannedVoice(res, 'filler:' + i + ':' + FILLER_LINES[i], FILLER_LINES[i], fillerPath(i));
});
// Launch greeting — the "Good evening, sir" moment. Frontend calls this once
// per day on first open; the reply is spoken client-side.
app.post('/api/jarvis/greet', async (req, res) => {
  const hour = new Date().getHours();
  const period = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  res.json({ text: `Good ${period}, sir. All systems are online.`, at: new Date().toISOString(), provider: 'local-direct' });
});

// Lead nudges — watch the Nextdoor store and push new leads to the Jarvis UI
// over the same SSE channel as approvals (event type 'nudge', spoken client-side).
// Seeded with current leads on boot so a restart never replays old ones.
const seenLeads = new Set();
let leadsSeeded = false;
async function pollLeadNudges() {
  let store;
  try { store = await readNextdoorStore(); } catch { return; }
  const leads = (store && Array.isArray(store.leads)) ? store.leads : [];
  if (!leadsSeeded) { for (const l of leads) seenLeads.add(l._key || l.title); leadsSeeded = true; return; }
  for (const l of leads) {
    const key = l._key || l.title;
    if (!key || seenLeads.has(key)) continue;
    seenLeads.add(key);
    const what = String(l.title || 'a detailing post').slice(0, 140);
    const where = l.area ? ' in ' + l.area : '';
    approvalBroadcast({ type: 'nudge', kind: 'lead', text: 'New Nextdoor lead' + where + ': ' + what });
  }
}
setTimeout(() => pollLeadNudges().catch(() => {}), 20 * 1000);
setInterval(() => pollLeadNudges().catch(() => {}), 5 * 60 * 1000);

// Durable local reminders share the nudge channel, so a due reminder appears
// and is spoken even when it was created in an earlier Jarvis session.
const JARVIS_REMINDERS_FILE = path.resolve(process.env.JARVIS_REMINDERS_FILE || path.join(AIOS_DATA_DIR, 'jarvis-reminders.json'));
let reminderPollBusy = false;
async function pollReminderNudges() {
  if (reminderPollBusy || !approvalClients.size) return;
  reminderPollBusy = true;
  try {
    const due = await require('./lib/jarvis-capabilities').personal.claimDue();
    if (!due.length) return;
    for (const item of due) {
      const title = String(item.title || 'Reminder').slice(0, 180);
      const note = String(item.note || '').slice(0, 220);
      approvalBroadcast({ type: 'nudge', kind: 'reminder', id: item.id, text: 'Reminder: ' + title + (note ? '. ' + note : '') });
      recordJarvisEvent('reminder.fired', { reminderId: String(item.id || '').slice(0, 100) });
    }
  } finally { reminderPollBusy = false; }
}
setTimeout(() => pollReminderNudges().catch(() => {}), 8 * 1000);
setInterval(() => pollReminderNudges().catch(() => {}), 15 * 1000);

app.post('/api/jarvis/approval-response', express.json({ limit: '16kb' }), (req, res) => {
  const { id, allow } = req.body || {};
  const pending = pendingApprovals.get(String(id || ''));
  if (!pending) return res.status(404).json({ error: 'no such pending approval' });
  pendingApprovals.delete(String(id));
  approvalBroadcast({ type: 'resolved', id: String(id), allow: !!allow });
  pending.resolve({ allow: !!allow, reason: allow ? undefined : 'Yish denied this action.' });
  res.json({ ok: true });
});

// Jarvis offline STT — proxy the browser's captured audio to the local
// JarvisVoice service (Whisper) so the page stays same-origin. voice-status lets
// the frontend know whether offline STT is available (else it uses browser voice).
const VOICE_SERVICE = process.env.JARVIS_VOICE_URL || 'http://127.0.0.1:3100';

async function refreshVoiceStatus() {
  const started = performance.now();
  try {
    const r = await fetch(VOICE_SERVICE + '/health', { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    jarvisRuntime.voiceStatus = {
      stt: !!(j && j.ok), model: j && j.model, mode: j && j.mode,
      audioAgeSec: j && j.audioAgeSec, latencyMs: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    jarvisRuntime.voiceStatus = {
      stt: false, error: String((e && e.message) || e),
      latencyMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString(),
    };
  }
  return { ...jarvisRuntime.voiceStatus, tts: TTS_PROVIDER, elevenlabs: ELEVENLABS_ENABLED };
}
app.get('/api/jarvis/voice-status', async (req, res) => {
  res.json(await refreshVoiceStatus());
});

// Coordinated listening: JarvisVoice keeps the one physical mic stream and
// returns a transcript after its server-side VAD sees the utterance end.
app.post('/api/jarvis/listen', async (req, res) => {
  const followup = String(req.query.followup || '') === '1';
  const started = performance.now();
  recordJarvisEvent('listen.start', { followup });
  try {
    const r = await fetch(VOICE_SERVICE + '/listen?followup=' + (followup ? '1' : '0'), {
      method: 'POST', signal: AbortSignal.timeout(70000),
    });
    const j = await r.json().catch(() => ({ text: '', speech: false, reason: 'invalid-response' }));
    recordJarvisEvent('listen.done', {
      followup, status: r.status, speech: !!j.speech, reason: String(j.reason || '').slice(0, 40),
      captureMs: Number(j.captureMs) || 0, sttMs: Number(j.sttMs) || 0,
      proxyMs: Math.round(performance.now() - started),
    });
    res.status(r.status).json(j);
  } catch (e) {
    const error = String((e && e.message) || e);
    recordJarvisEvent('listen.error', { followup, error: error.slice(0, 160), ms: Math.round(performance.now() - started) });
    res.status(502).json({ text: '', speech: false, reason: 'voice-service-unreachable', error });
  }
});

// Streaming voice proxy. JarvisVoice flushes a speech-ended NDJSON event as
// soon as its VAD closes the microphone, then sends the transcript after
// Whisper finishes. Keeping those phases separate prevents STT time from
// looking like extra listening time in the HUD.
app.post('/api/jarvis/listen-stream', async (req, res) => {
  const followup = String(req.query.followup || '') === '1';
  const started = performance.now();
  recordJarvisEvent('listen.stream.start', { followup });
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), 40000);
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
  try {
    const r = await fetch(VOICE_SERVICE + '/listen/stream?followup=' + (followup ? '1' : '0'), {
      method: 'POST', signal: aborter.signal,
    });
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    if (!r.body) throw new Error('voice service returned no stream');
    res.flushHeaders();

    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) {
        await reader.cancel().catch(() => {});
        break;
      }
      res.write(Buffer.from(value));
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    recordJarvisEvent('listen.stream.done', {
      followup, status: r.status, proxyMs: Math.round(performance.now() - started),
    });
  } catch (e) {
    const error = String((e && e.message) || e);
    recordJarvisEvent('listen.stream.error', {
      followup, error: error.slice(0, 160), ms: Math.round(performance.now() - started),
    });
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(JSON.stringify({ type: 'error', speech: false, reason: 'voice-service-unreachable', error }) + '\n');
        res.end();
      }
    } else if (!res.destroyed) {
      res.status(502).json({ type: 'error', text: '', speech: false, reason: 'voice-service-unreachable', error });
    }
  } finally {
    clearTimeout(timer);
  }
});

app.post('/api/jarvis/listen/cancel', async (req, res) => {
  try {
    const r = await fetch(VOICE_SERVICE + '/listen/cancel', { method: 'POST', signal: AbortSignal.timeout(2000) });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/api/jarvis/wake-suppress', async (req, res) => {
  const ms = Math.min(120000, Math.max(0, toNumber(req.query.ms, 3000)));
  try {
    const r = await fetch(VOICE_SERVICE + '/wake/suppress?ms=' + ms, { method: 'POST', signal: AbortSignal.timeout(2000) });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/api/jarvis/telemetry', express.json({ limit: '16kb' }), (req, res) => {
  const body = req.body || {};
  const fields = {};
  for (const key of ['state', 'from', 'to', 'mode', 'reason', 'provider']) {
    if (body[key] != null) fields[key] = String(body[key]).slice(0, 80);
  }
  for (const key of ['ms', 'captureMs', 'sttMs', 'ttftMs', 'ttsMs']) {
    if (Number.isFinite(Number(body[key]))) fields[key] = Math.round(Number(body[key]));
  }
  recordJarvisEvent(body.event || 'client', fields);
  res.json({ ok: true });
});

app.get('/api/jarvis/diagnostics', async (req, res) => {
  const scheduled = performance.now();
  setTimeout(async () => {
    const eventLoopLagMs = Math.round(performance.now() - scheduled);
    const voice = await refreshVoiceStatus();
    res.json({
      startedAt: jarvisRuntime.startedAt,
      uptimeSec: Math.round(process.uptime()),
      eventLoopLagMs,
      brain: getCodexStatus(),
      voice,
      events: jarvisRuntime.events.slice(-80),
      requests: jarvisRuntime.requests.slice(-50),
    });
  }, 0);
});

app.post('/api/jarvis/stt', express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '12mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty audio', text: '' });
  try {
    const r = await fetch(VOICE_SERVICE + '/stt', {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: req.body, signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({ text: '' }));
    res.status(r.status).json(j);
  } catch (e) {
    res.status(502).json({ error: 'voice service unreachable: ' + String((e && e.message) || e), text: '' });
  }
});

app.post('/api/jarvis/tts', express.json({ limit: '32kb' }), async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'empty text' });
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
  try {
    const audio = await synthesizeAudio(text, { voice: body.voice, rate: body.rate, signal: aborter.signal });
    res.setHeader('Content-Type', audio.contentType || 'audio/wav');
    res.setHeader('X-Jarvis-TTS-Provider', audio.provider || 'local');
    res.setHeader('Cache-Control', 'no-store');
    res.end(audio.buffer);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
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
initializeCodex()
  .then((status) => console.log(`[AIOS] Jarvis brain: ${status.model} via Codex SDK (${status.isolatedHome ? 'isolated' : 'shared'} home)`))
  .catch((e) => console.error('[AIOS] Jarvis Codex initialization failed:', String((e && e.message) || e)));
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
