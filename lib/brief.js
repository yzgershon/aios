'use strict';
// AIOS daily briefing — headless claude -p run grounded in live market data,
// cached in brief.json, last 14 kept in brief-history.json.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, pool, freshness, markFresh } = require('./util');
const { quoteCache, fetchYahooQuote } = require('./market');
const { CLAUDE, ptyEnv } = require('./claude');

// ---------------------------------------------------------------------------
// AI daily briefing — headless `claude -p` run, cached in brief.json. Same
// binary resolution + env strip as the terminal spawn, but plain child_process
// (no PTY needed for a one-shot print). Single-flight; client polls GET.
// NOTE: must stay one line, no double quotes, no `%` — it rides through
// `cmd /s /c "..."` for the shim/name spawn kinds.
// ---------------------------------------------------------------------------
const BRIEF_PROMPT = "Write Yish's daily AIOS briefing. First check his Google Calendar for today's and tomorrow morning's events using the calendar tool if one is available - if the lookup fails or no calendar tool exists, skip it silently and never mention it. A LIVE MARKET DATA block with real numbers is appended at the end of this prompt - use ONLY those numbers for anything about the market or his stocks, never look prices up or invent them, and if the block is absent just skip the money line. Plain text only, no markdown syntax, max 160 words. Lead with what needs action today (calendar events with their times, YDdetailers leads/bookings, school, anything urgent in memory). Then one line each: SCHEDULE (today's events), BUSINESS (YDdetailers), MONEY (how the market is doing today AND a quick read on his portfolio - overall day change, all-time gain, and the single biggest mover - in plain words, not just numbers), PERSONAL. End with exactly one specific suggested next action. Be specific and direct, no filler, talk to him like a sharp assistant who knows his world.";
const BRIEF_MODEL = 'claude-opus-4-8'; // pinned for consistent brief quality (headless default drifts with the CLI)
const BRIEF_TIMEOUT = 3 * 60 * 1000;
const BRIEF_STDOUT_CAP = 64 * 1024;
let briefGenerating = false;

async function readBrief() {
  try { return JSON.parse(await fsp.readFile(BRIEF_FILE, 'utf8')); }
  catch { return null; }
}

// Live market + holdings snapshot, injected into the brief so the headless run
// has real numbers (it can't reliably fetch quotes itself). One line, and
// strictly cmd-safe: NO double-quotes and NO percent signs (it rides through
// `cmd /s /c "..."`) — percentages are written as "pct". '' if nothing to say.
const BRIEF_INDICES = [['^GSPC', 'the S&P 500'], ['^IXIC', 'the Nasdaq'], ['^DJI', 'the Dow']];
async function buildBriefContext() {
  let holdings = [];
  try {
    const pf = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    holdings = Array.isArray(pf.holdings) ? pf.holdings : [];
  } catch { /* no portfolio is fine */ }

  const held = holdings.map((h) => String(h.ticker || '').toUpperCase()).filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s));
  const syms = Array.from(new Set([...BRIEF_INDICES.map((i) => i[0]), ...held]));
  const now = Date.now();
  const need = syms.filter((s) => !(quoteCache[s] && now - quoteCache[s].at < 60000));
  await Promise.allSettled(need.map(async (s) => { try { quoteCache[s] = { at: Date.now(), data: await fetchYahooQuote(s) }; } catch { /* keep prior */ } }));
  const q = (s) => quoteCache[s] && quoteCache[s].data;

  const pctStr = (v) => (v >= 0 ? 'up ' : 'down ') + Math.abs(v).toFixed(2) + ' pct';
  const usd = (v) => '$' + Math.abs(Math.round(v));
  const pieces = [];

  // market status + the three big indices
  let stateWord = '';
  const idx = [];
  for (const [sym, label] of BRIEF_INDICES) {
    const d = q(sym); if (!d) continue;
    if (!stateWord) {
      const st = d.state || '';
      stateWord = st === 'REGULAR' ? 'regular trading hours' : st === 'PRE' ? 'pre-market' : st === 'POST' ? 'after hours' : 'closed for the day';
    }
    let chg = d.changePct, tag = '';
    if (d.ext && /^(PRE|POST)/.test(d.state)) { chg = d.ext.changePct; tag = ' in extended trading'; }
    idx.push(label + ' ' + pctStr(chg) + tag);
  }
  if (stateWord) pieces.push('The market is ' + stateWord + '.');
  if (idx.length) pieces.push('Today: ' + idx.join(', ') + '.');

  // live portfolio valuation
  if (holdings.length) {
    let value = 0, cost = 0, dayChg = 0, prevTotal = 0; let mover = null;
    const moves = [];
    for (const h of holdings) {
      const t = String(h.ticker || '').toUpperCase();
      const shares = toNumber(h.shares, 0), avg = toNumber(h.avgCost, 0);
      const d = q(t);
      const price = d && d.price != null ? d.price : toNumber(h.price, 0);
      const prev = d && d.prevClose != null ? d.prevClose : (h.prevClose != null ? toNumber(h.prevClose, price) : price);
      const dpct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      value += shares * price; cost += shares * avg; dayChg += shares * (price - prev); prevTotal += shares * prev;
      const nm = (h.ticker || '').toUpperCase();
      moves.push(nm + ' ' + pctStr(dpct));
      if (!mover || Math.abs(dpct) > Math.abs(mover.pct)) mover = { nm, pct: dpct };
    }
    const gain = value - cost, gainPct = cost > 0 ? (gain / cost) * 100 : 0;
    const dayPct = prevTotal > 0 ? (dayChg / prevTotal) * 100 : 0;
    pieces.push('His portfolio is worth ' + usd(value) + ', ' + pctStr(dayPct) + ' today (' + (dayChg >= 0 ? 'up ' : 'down ') + usd(dayChg) + ') and ' + pctStr(gainPct) + ' all-time (' + (gain >= 0 ? 'up ' : 'down ') + usd(gain) + ').');
    if (moves.length) pieces.push('Holdings today: ' + moves.join(', ') + '.');
    if (mover) pieces.push('Biggest mover: ' + mover.nm + ' ' + pctStr(mover.pct) + '.');
  }

  if (!pieces.length) return '';
  // final scrub — guarantee no prompt-breaking chars survive
  return (' LIVE MARKET DATA (real, use these): ' + pieces.join(' ')).replace(/[%"]/g, '');
}

// CLAUDE / ptyEnv are declared after the Express section — fine, this only
// runs at request time (same module-scope pattern as quoteCache).
function briefSpawn(prompt) {
  if (CLAUDE.kind === 'exe') {
    return spawn(CLAUDE.value, ['-p', '--model', BRIEF_MODEL, prompt], { cwd: CLAUDE_CWD, env: ptyEnv(), windowsHide: true });
  }
  // .cmd shim / bare name can't be spawned directly on Windows — go through
  // cmd.exe. Node's default arg quoting mangles the nested quotes cmd /s /c
  // needs, so build the line ourselves and pass it verbatim: the outer quotes
  // are stripped by /s, leaving `"shim" -p --model M "prompt"`.
  const comspec = process.env.ComSpec || 'cmd.exe';
  const ref = CLAUDE.kind === 'name' ? 'claude' : `"${CLAUDE.value}"`;
  const line = `${ref} -p --model ${BRIEF_MODEL} "${prompt}"`;
  return spawn(comspec, ['/d', '/s', '/c', `"${line}"`], {
    cwd: CLAUDE_CWD, env: ptyEnv(), windowsHide: true, windowsVerbatimArguments: true,
  });
}

async function generateBrief() {
  briefGenerating = true; // set before any await so a double-POST can't race
  const startedAt = new Date().toISOString();
  writeJsonAtomic(BRIEF_FILE, { status: 'generating', startedAt }).catch(() => {});

  // Ground the brief in real market/holdings numbers (best-effort; never blocks).
  let prompt = BRIEF_PROMPT;
  try { prompt += await buildBriefContext(); } catch { /* market data optional */ }

  let proc;
  try { proc = briefSpawn(prompt); }
  catch (e) {
    briefGenerating = false;
    writeJsonAtomic(BRIEF_FILE, { status: 'error', startedAt, error: 'spawn failed: ' + String((e && e.message) || e) }).catch(() => {});
    return;
  }

  let out = '', errOut = '', timedOut = false, settled = false;
  proc.stdout.on('data', (d) => { if (out.length < BRIEF_STDOUT_CAP) out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* ignore */ } }, BRIEF_TIMEOUT);

  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    briefGenerating = false;
    writeJsonAtomic(BRIEF_FILE, payload).catch(() => {});
  };
  proc.on('error', (e) => finish({ status: 'error', startedAt, error: String((e && e.message) || e) }));
  proc.on('close', (code) => {
    const text = out.slice(0, BRIEF_STDOUT_CAP).trim();
    if (timedOut) {
      finish({ status: 'error', startedAt, error: 'timed out after 3 minutes' });
    } else if (code === 0 && text) {
      const ready = { status: 'ready', generatedAt: new Date().toISOString(), text };
      finish(ready);
      appendBriefHistory(ready).catch(() => {});
    } else {
      const why = errOut.trim().slice(0, 500) || ('claude exited with code ' + code + (text ? '' : ' and no output'));
      finish({ status: 'error', startedAt, error: why });
    }
  });
}

// Brief history — keep the last 14 briefs so yesterday's plan is one click away.
const BRIEF_HISTORY_FILE = path.join(AIOS_DATA_DIR, 'brief-history.json');
async function readBriefHistory() {
  try { const j = JSON.parse(await fsp.readFile(BRIEF_HISTORY_FILE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
async function appendBriefHistory(b) {
  const hist = await readBriefHistory();
  hist.push({ generatedAt: b.generatedAt, text: b.text });
  await writeJsonAtomic(BRIEF_HISTORY_FILE, hist.slice(-14));
}


function isBriefGenerating() { return briefGenerating; }

module.exports = { readBrief, generateBrief, readBriefHistory, isBriefGenerating };
