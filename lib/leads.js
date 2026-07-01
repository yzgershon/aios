'use strict';
// AIOS lead capture — Local Demand tile data + the Nextdoor IMAP poller.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, parseMarkdownTable, pool, freshness, markFresh } = require('./util');

// ---------------------------------------------------------------------------
// Local demand — real leads if you (or a skill) drop them into
// ~/.aios/local-leads.json; otherwise the frontend shows an actionable
// Nextdoor/Facebook/Google launchpad for your service towns.
// ---------------------------------------------------------------------------
const LOCAL_LEADS_FILE = path.join(AIOS_DATA_DIR, 'local-leads.json');

async function readManualLeads() {
  try {
    const raw = JSON.parse(await fsp.readFile(LOCAL_LEADS_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.leads) ? raw.leads : []);
    return arr.map((l) => ({
      title: String(l.title || '').slice(0, 220),
      area: String(l.area || '').slice(0, 40),
      source: String(l.source || 'Manual').slice(0, 40),
      time: String(l.time || '').slice(0, 40),
      capturedAt: typeof l.capturedAt === 'string' ? l.capturedAt : null,
      link: typeof l.link === 'string' ? l.link : '',
      note: String(l.note || '').slice(0, 200),
    })).filter((l) => l.title);
  } catch { return []; }
}

async function readNextdoorStore() {
  try {
    const s = JSON.parse(await fsp.readFile(NEXTDOOR_LEADS_FILE, 'utf8'));
    return { processed: s.processed || {}, leads: Array.isArray(s.leads) ? s.leads : [], lastPolledAt: s.lastPolledAt || null, lastError: s.lastError || null };
  } catch { return { processed: {}, leads: [], lastPolledAt: null, lastError: null }; }
}

const LEAD_FRESH_WINDOW = 48 * 60 * 60 * 1000;
async function getLocalDemand() {
  const [manual, nd] = await Promise.all([readManualLeads(), readNextdoorStore()]);
  const all = [...manual, ...nd.leads];
  const ts = (l) => Date.parse(l.capturedAt || l.time || '') || 0;
  all.sort((a, b) => ts(b) - ts(a));
  const now = Date.now();
  const leads = all.slice(0, 25).map((l) => ({ ...l, fresh: ts(l) > 0 && (now - ts(l)) < LEAD_FRESH_WINDOW }));
  const freshCount = leads.filter((l) => l.fresh).length;
  return {
    available: true,
    hasLeads: leads.length > 0,
    leads,
    freshCount,
    nextdoor: { configured: !!(NEXTDOOR_IMAP_USER && NEXTDOOR_IMAP_PASS), lastPolledAt: nd.lastPolledAt, lastError: nd.lastError, count: nd.leads.length },
  };
}

// ---------------------------------------------------------------------------
// Nextdoor → leads poller. Reads the dedicated Gmail inbox over IMAP, keeps
// only posts mentioning detailing/car-wash keywords, writes them to
// nextdoor-leads.json (which getLocalDemand merges). Inert without creds.
// ---------------------------------------------------------------------------
let nextdoorPolling = false;
const NEXTDOOR_POLL_TTL = 15 * 60 * 1000;

// Brand tokens to scrub before matching — so "yddetailers" (in the recipient
// address, the .com domain, @handles, footers) never trips "detailer"/"detail".
// Substring match after scrubbing keeps real phrasings like "car washed".
const BRAND_TOKENS = Array.from(new Set([
  (NEXTDOOR_IMAP_USER.split('@')[0] || '').toLowerCase(),
  String(INSTAGRAM_USERNAME || '').toLowerCase(),
  String(TIKTOK_USERNAME || '').toLowerCase(),
  String(YOUTUBE_HANDLE || '').replace(/^@/, '').toLowerCase(),
  'yddetailers',
].filter((t) => t && t.length >= 5)));

function matchedKeyword(text) {
  let t = String(text || '').toLowerCase();
  for (const b of BRAND_TOKENS) t = t.split(b).join(' ');
  return NEXTDOOR_KEYWORDS.find((k) => t.includes(k)) || null;
}

function extractNextdoorLink(html, text) {
  const hay = String(html || '') + ' ' + String(text || '');
  const all = hay.match(/https?:\/\/[^\s"'<>)]+nextdoor\.com[^\s"'<>)]*/gi) || [];
  const clean = all.map((u) => u.replace(/[.,)]+$/, ''));
  return clean.find((u) => /\/(p|news_feed|post|for_sale_and_free)\//i.test(u)) || clean[0] || '';
}

function snippetAround(text, keyword) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(keyword);
  if (i < 0) return t.slice(0, 180);
  const start = Math.max(0, i - 70);
  return (start > 0 ? '…' : '') + t.slice(start, start + 180).trim() + (t.length > start + 180 ? '…' : '');
}

function extractArea(subject, text) {
  const m = /\bfrom\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2})\b/.exec(String(subject || '') + ' ' + String(text || ''));
  return m ? m[1].slice(0, 40) : '';
}

async function pollNextdoorLeads(force) {
  if (!NEXTDOOR_IMAP_USER || !NEXTDOOR_IMAP_PASS) return null;
  if (nextdoorPolling) return null;
  const store = await readNextdoorStore();
  if (!force && store.lastPolledAt && (Date.now() - Date.parse(store.lastPolledAt) < NEXTDOOR_POLL_TTL)) return null;
  nextdoorPolling = true;
  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (e) { nextdoorPolling = false; return null; }
  const client = new ImapFlow({ host: NEXTDOOR_IMAP_HOST, port: 993, secure: true, auth: { user: NEXTDOOR_IMAP_USER, pass: NEXTDOOR_IMAP_PASS }, logger: false });
  const processed = store.processed || {};
  const leads = store.leads || [];
  let added = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(NEXTDOOR_MAILBOX);
    try {
      const since = new Date(Date.now() - 30 * 86400000); // last 30 days
      let uids = [];
      try { uids = await client.search({ since }, { uid: true }) || []; } catch { uids = []; }
      uids = uids.slice(-200); // cap work per poll
      for (const uid of uids) {
        if (processed[uid]) continue;
        let msg;
        try { msg = await client.fetchOne(uid, { source: true }, { uid: true }); } catch { continue; }
        if (!msg || !msg.source) { processed[uid] = 1; continue; }
        let parsed;
        try { parsed = await simpleParser(msg.source); } catch { processed[uid] = 1; continue; }
        const fromAddr = (parsed.from && parsed.from.text) || '';
        const isNextdoor = /nextdoor/i.test(fromAddr) || /nextdoor/i.test(parsed.subject || '');
        processed[uid] = 1;
        if (!isNextdoor) continue;
        const body = (parsed.text || '') + ' ' + (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');
        const kw = matchedKeyword((parsed.subject || '') + ' ' + body);
        if (!kw) continue;
        const link = extractNextdoorLink(parsed.html, parsed.text);
        const dedupeKey = link || (parsed.messageId || '') || snippetAround(body, kw);
        if (leads.some((l) => l._key === dedupeKey)) continue;
        leads.push({
          _key: dedupeKey,
          title: snippetAround(body, kw) || (parsed.subject || 'Nextdoor post'),
          area: extractArea(parsed.subject, body),
          source: 'Nextdoor',
          matched: kw,
          time: (parsed.date && parsed.date.toISOString()) || new Date().toISOString(),
          capturedAt: new Date().toISOString(),
          link,
          note: '',
        });
        added++;
      }
    } finally { lock.release(); }
    await client.logout().catch(() => {});
    // Keep newest 60 leads + processed ids bounded.
    leads.sort((a, b) => (Date.parse(b.capturedAt || b.time) || 0) - (Date.parse(a.capturedAt || a.time) || 0));
    const trimmed = leads.slice(0, 60);
    const procEntries = Object.keys(processed).slice(-2000).reduce((o, k) => (o[k] = 1, o), {});
    await writeJsonAtomic(NEXTDOOR_LEADS_FILE, { lastPolledAt: new Date().toISOString(), lastError: null, processed: procEntries, leads: trimmed });
    return { added, total: trimmed.length };
  } catch (e) {
    try { await writeJsonAtomic(NEXTDOOR_LEADS_FILE, { ...store, lastPolledAt: new Date().toISOString(), lastError: String((e && e.message) || e) }); } catch { /* ignore */ }
    try { await client.logout(); } catch { /* ignore */ }
    return { error: String((e && e.message) || e) };
  } finally {
    nextdoorPolling = false;
  }
}


function isNextdoorPolling() { return nextdoorPolling; }

module.exports = { getLocalDemand, pollNextdoorLeads, readNextdoorStore, readManualLeads, isNextdoorPolling, NEXTDOOR_POLL_TTL };
