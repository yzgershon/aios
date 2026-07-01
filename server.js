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
// .env loader — function declaration (hoisted) so we can call it BEFORE any
// `const X = process.env.X`. Only sets keys not already present; strips quotes;
// tolerates \n and \r\n.
// ---------------------------------------------------------------------------
function loadEnv(envPath) {
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); }
  catch { return; } // no .env is fine
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const PROJECT_DIR = __dirname;
loadEnv(path.join(PROJECT_DIR, '.env')); // <-- before reading any env below

// ---------------------------------------------------------------------------
// Config (env with sensible defaults). Secrets read from env only.
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const YOUTUBE_HANDLE = process.env.YOUTUBE_HANDLE || '@yddetailers';
const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME || 'yddetailers';
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || INSTAGRAM_USERNAME;
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const APIFY_API_TOKEN = (process.env.APIFY_API_TOKEN || '').trim();

// Nextdoor lead capture — a dedicated Gmail inbox that all Nextdoor email goes
// to. The server reads it over IMAP (Gmail app password), filters detailing
// posts, and feeds them into the Local Demand tile. All optional/inert if unset.
const NEXTDOOR_IMAP_USER = (process.env.NEXTDOOR_IMAP_USER || '').trim();
const NEXTDOOR_IMAP_PASS = (process.env.NEXTDOOR_IMAP_PASS || '').replace(/\s+/g, ''); // app passwords are shown with spaces
const NEXTDOOR_IMAP_HOST = (process.env.NEXTDOOR_IMAP_HOST || 'imap.gmail.com').trim();
const NEXTDOOR_MAILBOX = (process.env.NEXTDOOR_MAILBOX || 'INBOX').trim();
const NEXTDOOR_KEYWORDS = (process.env.NEXTDOOR_KEYWORDS || 'car detail,auto detail,detailer,detailing,car wash,carwash,wash my car,clean my car,car cleaning,mobile detail,interior clean')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const AIOS_DATA_DIR = path.join(os.homedir(), '.aios');
const PROJECTS_FILE = process.env.PROJECTS_FILE || path.join(AIOS_DATA_DIR, 'projects.md');
const METRICS_FILE = path.join(AIOS_DATA_DIR, 'metrics.json');
const SOCIAL_CACHE_FILE = path.join(AIOS_DATA_DIR, 'social-cache.json');
const CONTENT_SAMPLE_FILE = path.join(AIOS_DATA_DIR, 'content-sample.json');
const PORTFOLIO_FILE = path.join(AIOS_DATA_DIR, 'portfolio.json');
const NEXTDOOR_LEADS_FILE = path.join(AIOS_DATA_DIR, 'nextdoor-leads.json');
const PIPELINE_FILE = path.join(AIOS_DATA_DIR, 'pipeline.json');
// Meta instant-form leads — the form delivers to a Google Sheet; paste that
// sheet's share link (Anyone with the link → Viewer) and the pipeline imports
// new rows as cards. Inert when unset.
const META_LEADS_SHEET_URL = (process.env.META_LEADS_SHEET_URL || '').trim();
const GOALS_FILE = path.join(AIOS_DATA_DIR, 'goals.json');
const BRIEF_FILE = path.join(AIOS_DATA_DIR, 'brief.json');
const VAULT_DIR = (() => {
  const want = process.env.AIOS_VAULT_DIR || process.env.AIOS_CLAUDE_CWD;
  if (want && fs.existsSync(want)) return want;
  return os.homedir();
})();

// Where the embedded terminal runs claude (so project skills + CLAUDE.md load).
const CLAUDE_CWD = (() => {
  const want = process.env.AIOS_CLAUDE_CWD;
  if (want && fs.existsSync(want)) return want;
  return os.homedir();
})();

// Skills exposed as terminal buttons. Server-side allowlist for the WS param.
const SKILLS = [
  { id: 'morning-brief', label: 'Morning Brief', primary: true },
  { id: 'draft-nextdoor-ad', label: 'Nextdoor Ad', primary: true },
  { id: 'reply-customer', label: 'Reply Customer', primary: true },
  { id: 'audit', label: 'Audit', primary: false },
  { id: 'level-up', label: 'Level Up', primary: false },
  { id: 'log', label: 'Log', primary: false },
  { id: 'search', label: 'Search', primary: false },
];
const SKILL_SET = new Set(SKILLS.map((s) => s.id));
const SKILL_RE = /^[a-z0-9][a-z0-9-]*$/;

try { fs.mkdirSync(AIOS_DATA_DIR, { recursive: true }); } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function settle(key, fn, errors) {
  try { return await fn(errors); }
  catch (e) { errors.push({ source: key, message: String((e && e.message) || e) }); return null; }
}

async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    // Windows can throw EPERM/EEXIST renaming over an existing file.
    if (e.code === 'EEXIST' || e.code === 'EPERM') {
      try { await fsp.unlink(file); } catch { /* ignore */ }
      await fsp.rename(tmp, file);
    } else { throw e; }
  }
}

function toNumber(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function abbrevNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function parseISO8601Duration(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(d || '')) || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

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
// YouTube Data API v3 — graceful when no key. ~5 min in-memory cache.
// ---------------------------------------------------------------------------
let ytCache = { at: 0, data: null };
const YT_TTL = 5 * 60 * 1000;

async function ytFetch(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let reason = 'http_' + r.status;
    try { const j = await r.json(); reason = j?.error?.errors?.[0]?.reason || reason; } catch { /* ignore */ }
    const err = new Error('YouTube API ' + r.status + ' (' + reason + ')');
    err.reason = reason;
    throw err;
  }
  return r.json();
}

async function getYouTube() {
  if (!YOUTUBE_API_KEY) {
    return {
      available: false,
      reason: 'no_api_key',
      message: 'Add a YouTube Data API v3 key to .env to show channel stats + thumbnails.',
      setupHint: 'README → "YouTube setup (5 min)".',
    };
  }
  if (ytCache.data && Date.now() - ytCache.at < YT_TTL) return ytCache.data;

  const base = 'https://www.googleapis.com/youtube/v3';
  const handle = encodeURIComponent(String(YOUTUBE_HANDLE).replace(/^@/, ''));
  try {
    const ch = await ytFetch(`${base}/channels?part=statistics,snippet,contentDetails&forHandle=${handle}&key=${YOUTUBE_API_KEY}`);
    const item = ch.items && ch.items[0];
    if (!item) {
      const r = { available: false, reason: 'channel_not_found', message: `No channel found for ${YOUTUBE_HANDLE}.` };
      ytCache = { at: Date.now(), data: r };
      return r;
    }
    const stats = item.statistics || {};
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;

    let recentVideos = [];
    if (uploads) {
      const pl = await ytFetch(`${base}/playlistItems?part=snippet,contentDetails&playlistId=${uploads}&maxResults=30&key=${YOUTUBE_API_KEY}`);
      const ids = (pl.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
      const vmap = {};
      if (ids.length) {
        const v = await ytFetch(`${base}/videos?part=statistics,contentDetails,snippet&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`);
        for (const vid of v.items || []) vmap[vid.id] = vid;
      }
      recentVideos = (pl.items || []).map((i) => {
        const id = i.contentDetails?.videoId;
        const vid = vmap[id];
        if (!vid) return null;
        const durationSec = parseISO8601Duration(vid.contentDetails?.duration);
        return {
          id,
          title: vid.snippet?.title || '',
          url: `https://www.youtube.com/watch?v=${id}`,
          thumbnail: vid.snippet?.thumbnails?.medium?.url || vid.snippet?.thumbnails?.default?.url || '',
          viewCount: toNumber(vid.statistics?.viewCount, 0),
          publishedAt: vid.snippet?.publishedAt || null,
          durationSec,
        };
      }).filter(Boolean).slice(0, 12); // include Shorts — Yish posts short-form
    }

    const result = {
      available: true,
      channel: { title: item.snippet?.title || '', thumbnail: item.snippet?.thumbnails?.default?.url || '' },
      stats: {
        subscriberCount: toNumber(stats.subscriberCount, 0),
        viewCount: toNumber(stats.viewCount, 0),
        videoCount: toNumber(stats.videoCount, 0),
      },
      recentVideos,
    };
    ytCache = { at: Date.now(), data: result };
    return result;
  } catch (e) {
    return { available: false, reason: e.reason || 'error', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// Apify — Instagram (followers + recent-post engagement). 12h file cache,
// fire-and-forget background refresh, single-flight guard so the 5-min poll
// never triggers a paid run.
// ---------------------------------------------------------------------------
const SOCIAL_TTL = 6 * 60 * 60 * 1000; // re-pull IG/TikTok every 6h so view counts stay current
const SOCIAL_ERROR_BACKOFF = 60 * 60 * 1000; // after a failed Apify run, wait 1h before retrying
let socialRefreshing = false;

async function readSocialCache() {
  try { return JSON.parse(await fsp.readFile(SOCIAL_CACHE_FILE, 'utf8')); }
  catch { return null; }
}

async function fetchInstagramApify() {
  const actor = 'apify~instagram-profile-scraper';
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=290&memory=1024`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [INSTAGRAM_USERNAME] }), // no maxItems — a 1-cap returns HTTP 400
    signal: AbortSignal.timeout(295000),
  });
  if (!r.ok) throw new Error('Apify Instagram run failed (HTTP ' + r.status + ')');
  const items = await r.json();
  const it = Array.isArray(items) ? items[0] : null;
  if (!it) return null;
  const posts = Array.isArray(it.latestPosts) ? it.latestPosts : [];
  const nums = (key) => posts.map((p) => Number(p[key])).filter((n) => Number.isFinite(n) && n >= 0);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const mapComments = (p) => {
    const raw = Array.isArray(p.latestComments) ? p.latestComments : (Array.isArray(p.comments) ? p.comments : []);
    return raw.slice(0, 5).map((c) => ({
      text: typeof c === 'string' ? c : String(c.text || ''),
      owner: (c && (c.ownerUsername || c.owner)) || '',
      likes: toNumber(c && c.likesCount, 0),
    })).filter((c) => c.text.trim());
  };
  const viewsOf = (p) => {
    const v = p.videoPlayCount ?? p.videoViewCount ?? p.igPlayCount ?? p.playCount ?? p.viewCount;
    return v != null && Number.isFinite(Number(v)) ? toNumber(v, 0) : null;
  };
  const latestPosts = posts.slice(0, 12).map((p) => ({
    thumbnail: p.displayUrl || p.thumbnailSrc || p.thumbnailUrl || '',
    url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''),
    caption: typeof p.caption === 'string' ? p.caption.slice(0, 140) : '',
    likesCount: toNumber(p.likesCount, 0),
    commentsCount: toNumber(p.commentsCount, 0),
    viewsCount: viewsOf(p),
    comments: mapComments(p),
  }));
  return {
    username: it.username || INSTAGRAM_USERNAME,
    followers: toNumber(it.followersCount, 0),
    avgLikes: avg(nums('likesCount')),
    avgComments: avg(nums('commentsCount')),
    postsSampled: posts.length,
    latestPosts,
  };
}

// Instagram comment text — the profile scraper only returns counts, so pull
// actual comments for posts that have them via the dedicated comment actor.
// Returns { shortcode: [{text, owner, likes}] }.
async function fetchInstagramComments(urls) {
  const list = (urls || []).slice(0, 6);
  if (!list.length) return {};
  const actor = 'apify~instagram-comment-scraper';
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=180&memory=1024`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ directUrls: list, resultsLimit: 8 }),
    signal: AbortSignal.timeout(185000),
  });
  if (!r.ok) throw new Error('Apify IG comments failed (HTTP ' + r.status + ')');
  const items = await r.json();
  const byCode = {};
  const code = (u) => { const m = /\/p\/([^/]+)/.exec(String(u || '')); return m ? m[1] : String(u || ''); };
  for (const it of (Array.isArray(items) ? items : [])) {
    const text = String(it.text || '').trim();
    if (!text) continue;
    const key = code(it.postUrl || it.url || '');
    (byCode[key] = byCode[key] || []).push({ text: text.slice(0, 200), owner: it.ownerUsername || it.owner || '', likes: toNumber(it.likesCount, 0) });
  }
  return byCode;
}

async function fetchTikTokApify() {
  const actor = 'clockworks~free-tiktok-scraper';
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=290&memory=1024`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles: [TIKTOK_USERNAME], resultsPerPage: 12, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false }),
    signal: AbortSignal.timeout(295000),
  });
  if (!r.ok) throw new Error('Apify TikTok run failed (HTTP ' + r.status + ')');
  const items = await r.json();
  if (!Array.isArray(items) || !items.length) return null;
  // The scraper returns a single {error, errorCode} item when TikTok blocks the
  // request or won't resolve the profile (e.g. NOT_FOUND) — even for handles that
  // load fine in a browser. Treat that as a FAILED pull, not an empty 0-follower
  // profile, so we keep prior good data instead of caching bogus zeros.
  if (items[0] && (items[0].error || items[0].errorCode)) {
    throw new Error('Apify TikTok: ' + (items[0].error || items[0].errorCode || 'unknown'));
  }
  const author = items[0].authorMeta || {};
  const posts = items.filter((it) => it && (it.webVideoUrl || it.id)).slice(0, 12).map((it) => ({
    thumbnail: (Array.isArray(it.covers) ? it.covers[0] : '') || (it.videoMeta && it.videoMeta.coverUrl) || it.coverUrl || '',
    url: it.webVideoUrl || '',
    caption: typeof it.text === 'string' ? it.text.slice(0, 140) : '',
    playCount: toNumber(it.playCount, 0),
    diggCount: toNumber(it.diggCount, 0),
  }));
  return {
    username: author.name || author.nickName || TIKTOK_USERNAME,
    followers: toNumber(author.fans, 0),
    hearts: toNumber(author.heart, 0),
    videoCount: toNumber(author.video, 0),
    latestPosts: posts,
  };
}

// TikTok comment text — dedicated actor, best-effort (engagement is low so any
// failure just yields no TikTok comments). Returns { videoUrl: [{text,owner,likes}] }.
async function fetchTikTokComments(urls) {
  const list = (urls || []).slice(0, 4);
  if (!list.length) return {};
  const actor = 'clockworks~tiktok-comments-scraper';
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=160&memory=512`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${APIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postURLs: list, commentsPerPost: 8, maxItems: 40 }),
    signal: AbortSignal.timeout(165000),
  });
  if (!r.ok) throw new Error('Apify TikTok comments failed (HTTP ' + r.status + ')');
  const items = await r.json();
  const byUrl = {};
  for (const it of (Array.isArray(items) ? items : [])) {
    const text = String(it.text || it.comment || '').trim();
    if (!text) continue;
    const vurl = it.videoWebUrl || it.postUrl || it.videoUrl || it.submittedVideoUrl || '';
    const key = String(vurl).split('?')[0];
    (byUrl[key] = byUrl[key] || []).push({ text: text.slice(0, 200), owner: it.uniqueId || it.user || it.username || '', likes: toNumber(it.diggCount || it.likesCount, 0) });
  }
  return byUrl;
}

async function refreshSocial() {
  if (socialRefreshing) return null;
  socialRefreshing = true;
  try {
    // Fetch Instagram + TikTok together (one cached run-cycle keeps Apify cost down).
    const [igRes, ttRes] = await Promise.allSettled([fetchInstagramApify(), fetchTikTokApify()]);
    const instagram = igRes.status === 'fulfilled' ? igRes.value : null;
    const tiktok = ttRes.status === 'fulfilled' ? ttRes.value : null;
    const prev = await readSocialCache();
    if (!instagram && !tiktok) {
      // Both failed → negative cache so the poll backs off instead of re-firing paid runs.
      try {
        await writeJsonAtomic(SOCIAL_CACHE_FILE, {
          fetchedAt: (prev && prev.fetchedAt) || null,
          lastErrorAt: new Date().toISOString(),
          instagram: (prev && prev.instagram) || null,
          tiktok: (prev && prev.tiktok) || null,
        });
      } catch { /* ignore */ }
      throw new Error('Apify: Instagram and TikTok both failed');
    }
    // Attach real comment text to Instagram posts that have comments (one extra
    // actor run, only for posts where commentsCount > 0).
    if (instagram && Array.isArray(instagram.latestPosts)) {
      const code = (u) => { const m = /\/p\/([^/]+)/.exec(String(u || '')); return m ? m[1] : String(u || ''); };
      const urls = instagram.latestPosts.filter((p) => toNumber(p.commentsCount, 0) > 0 && p.url).map((p) => p.url);
      if (urls.length) {
        try {
          const byCode = await fetchInstagramComments(urls);
          for (const p of instagram.latestPosts) {
            const c = byCode[code(p.url)];
            if (c && c.length) p.comments = c;
          }
        } catch { /* counts-only is fine */ }
      }
    }
    // Same for TikTok — attach comment text to videos that have plays.
    if (tiktok && Array.isArray(tiktok.latestPosts)) {
      const urls = tiktok.latestPosts.filter((p) => toNumber(p.playCount, 0) > 0 && p.url).map((p) => p.url).slice(0, 4);
      if (urls.length) {
        try {
          const byUrl = await fetchTikTokComments(urls);
          for (const p of tiktok.latestPosts) {
            const c = byUrl[String(p.url).split('?')[0]];
            if (c && c.length) p.comments = c;
          }
        } catch { /* no tiktok comments is fine */ }
      }
    }
    // Keep prior data for whichever platform failed this round.
    const payload = {
      fetchedAt: new Date().toISOString(),
      instagram: instagram || (prev && prev.instagram) || null,
      tiktok: tiktok || (prev && prev.tiktok) || null,
    };
    await writeJsonAtomic(SOCIAL_CACHE_FILE, payload);
    return payload;
  } finally {
    socialRefreshing = false;
  }
}

async function getSocial() {
  if (!APIFY_API_TOKEN) {
    return { available: false, reason: 'no_token', message: 'Connect Apify to pull Instagram followers + engagement.', username: INSTAGRAM_USERNAME, instagram: null };
  }
  const cache = await readSocialCache();
  const ts = cache && cache.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
  const fresh = Number.isFinite(ts) && (Date.now() - ts < SOCIAL_TTL);

  // Treat as done only if TikTok has also been attempted (cache.tiktok defined) —
  // an older cache from before TikTok was wired should refresh once to fill it.
  if (cache && fresh && cache.tiktok !== undefined) {
    return { available: true, stale: false, refreshing: socialRefreshing, fetchedAt: cache.fetchedAt, username: INSTAGRAM_USERNAME, instagram: cache.instagram || null };
  }
  // Stale/missing: fire a background refresh only if not already running AND past
  // the error-backoff window, so a persistent Apify failure can't loop a paid run.
  const errTs = cache && cache.lastErrorAt ? Date.parse(cache.lastErrorAt) : NaN;
  const inBackoff = Number.isFinite(errTs) && (Date.now() - errTs < SOCIAL_ERROR_BACKOFF);
  const willRefresh = !socialRefreshing && !inBackoff;
  if (willRefresh) refreshSocial().catch(() => {}); // background, never blocks the poll

  if (cache && cache.instagram) {
    return { available: true, stale: true, refreshing: socialRefreshing || willRefresh, fetchedAt: cache.fetchedAt, username: INSTAGRAM_USERNAME, instagram: cache.instagram };
  }
  return { available: false, reason: inBackoff ? 'error' : 'pending', refreshing: socialRefreshing || willRefresh, username: INSTAGRAM_USERNAME, instagram: null };
}

async function getTikTok() {
  if (!APIFY_API_TOKEN) return { available: false, reason: 'no_token', username: TIKTOK_USERNAME, tiktok: null };
  // getSocial() owns the refresh trigger (the shared run fetches both); we just read.
  const cache = await readSocialCache();
  if (cache && cache.tiktok) {
    const ts = cache.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
    const stale = !(Number.isFinite(ts) && Date.now() - ts < SOCIAL_TTL);
    return { available: true, stale, username: cache.tiktok.username || TIKTOK_USERNAME, tiktok: cache.tiktok };
  }
  return { available: false, reason: socialRefreshing ? 'refreshing' : 'pending', username: TIKTOK_USERNAME, tiktok: null };
}

// ---------------------------------------------------------------------------
// Content carousel — unified Instagram / TikTok / YouTube feed. Uses live data
// when available, else falls back to the seeded sample file so the tile fills.
// ---------------------------------------------------------------------------
async function readContentSample() {
  try { return JSON.parse(await fsp.readFile(CONTENT_SAMPLE_FILE, 'utf8')); }
  catch { return null; }
}

function ytToContent(y) {
  if (!y || !y.available || !Array.isArray(y.recentVideos)) return [];
  return y.recentVideos.map((v) => ({
    platform: 'youtube',
    title: v.title || '',
    thumbnail: v.thumbnail || '',
    url: v.url || '',
    stat: v.viewCount != null ? abbrevNum(v.viewCount) + ' views' : '',
    time: v.publishedAt || '',
    durationSec: v.durationSec || 0,
  }));
}

function igToContent(s) {
  if (!s || !s.available || !s.instagram || !Array.isArray(s.instagram.latestPosts)) return [];
  return s.instagram.latestPosts.map((p) => ({
    platform: 'instagram',
    title: p.caption || '',
    thumbnail: p.thumbnail || '',
    url: p.url || '',
    likes: p.likesCount != null ? toNumber(p.likesCount, 0) : null,
    views: p.viewsCount != null ? toNumber(p.viewsCount, 0) : null,
    // Default stat shows views when available (toggleable in the UI); falls back to likes.
    stat: p.viewsCount != null ? abbrevNum(p.viewsCount) + ' views'
      : (p.likesCount != null ? abbrevNum(p.likesCount) + ' likes' : ''),
  }));
}

function ttToContent(t) {
  if (!t || !t.available || !t.tiktok || !Array.isArray(t.tiktok.latestPosts)) return [];
  return t.tiktok.latestPosts.map((p) => ({
    platform: 'tiktok',
    title: p.caption || '',
    thumbnail: p.thumbnail || '',
    url: p.url || '',
    stat: p.playCount != null ? abbrevNum(p.playCount) + ' views' : '',
  }));
}

async function getContent(youtube, social, tiktok) {
  let items = [...ytToContent(youtube), ...igToContent(social), ...ttToContent(tiktok)];
  let sample = false;
  if (items.length === 0) {
    const s = await readContentSample();
    if (s) {
      sample = true;
      const norm = (arr, platform) => (Array.isArray(arr) ? arr : []).map((x) => ({ platform, ...x }));
      items = [].concat(norm(s.youtube, 'youtube'), norm(s.instagram, 'instagram'), norm(s.tiktok, 'tiktok'));
    }
  }
  const counts = items.reduce((a, i) => { a[i.platform] = (a[i.platform] || 0) + 1; a.all = (a.all || 0) + 1; return a; }, { all: 0 });
  return { available: items.length > 0, sample, items, counts };
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
// Small concurrency pool — run fn over items, max n at a time. Failures → null.
// ---------------------------------------------------------------------------
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  }));
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
// Trends engine (YouTube Data API) — live "trending to copy" short-form + a
// competitor watch (top recent hits, distinct channels). Cached 6 h (search
// costs 100 quota units each; 2 searches × 4/day ≈ 800 units, well under 10k).
// ---------------------------------------------------------------------------
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
let trendsCache = { at: 0, data: null };
const TRENDS_TTL = 6 * 60 * 60 * 1000;

async function ytSearch(q, opts) {
  const o = opts || {};
  const since = new Date(Date.now() - (o.days || 30) * 86400000).toISOString();
  let u = `${YT_BASE}/search?part=snippet&type=video&order=${o.order || 'viewCount'}&maxResults=${o.max || 8}&publishedAfter=${since}&q=${encodeURIComponent(q)}&relevanceLanguage=en&key=${YOUTUBE_API_KEY}`;
  if (o.duration) u += '&videoDuration=' + o.duration;
  const j = await ytFetch(u);
  const ids = (j.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  const vmap = {};
  if (ids.length) {
    const v = await ytFetch(`${YT_BASE}/videos?part=statistics,contentDetails&id=${ids.join(',')}&key=${YOUTUBE_API_KEY}`);
    for (const it of v.items || []) vmap[it.id] = it;
  }
  return (j.items || []).map((i) => {
    const id = i.id && i.id.videoId;
    const vid = vmap[id];
    if (!id) return null;
    return {
      id,
      title: (i.snippet && i.snippet.title) || '',
      channel: (i.snippet && i.snippet.channelTitle) || '',
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: (i.snippet && i.snippet.thumbnails && (i.snippet.thumbnails.medium || i.snippet.thumbnails.default) || {}).url || '',
      views: toNumber(vid && vid.statistics && vid.statistics.viewCount, 0),
      durationSec: parseISO8601Duration(vid && vid.contentDetails && vid.contentDetails.duration),
      publishedAt: (i.snippet && i.snippet.publishedAt) || null,
    };
  }).filter(Boolean);
}

async function getTrends() {
  if (!YOUTUBE_API_KEY) return { available: false, reason: 'no_api_key', trending: [], competitors: [] };
  if (trendsCache.data && Date.now() - trendsCache.at < TRENDS_TTL) return trendsCache.data;
  try {
    const [trendRaw, compRaw] = await Promise.all([
      ytSearch('car detailing satisfying', { order: 'viewCount', days: 30, duration: 'short', max: 10 }),
      ytSearch('car detailing transformation', { order: 'viewCount', days: 90, max: 12 }),
    ]);
    const myHandle = String(YOUTUBE_HANDLE).replace(/^@/, '').toLowerCase();
    const trending = trendRaw.filter((v) => v.views > 0).slice(0, 8);
    const seen = new Set();
    const competitors = [];
    for (const v of compRaw.sort((a, b) => b.views - a.views)) {
      const key = v.channel.toLowerCase();
      if (!v.channel || seen.has(key) || key === myHandle) continue;
      seen.add(key); competitors.push(v);
      if (competitors.length >= 6) break;
    }
    const data = { available: trending.length > 0 || competitors.length > 0, timestamp: new Date().toISOString(), trending, competitors };
    if (data.available) trendsCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return trendsCache.data || { available: false, reason: e.reason || 'error', message: e.message, trending: [], competitors: [] };
  }
}

// ---------------------------------------------------------------------------
// Comments — genuine, per platform, each tagged with the video/post it's from.
// YouTube: live commentThreads on your top recent videos (1 quota unit each).
// Instagram: latestComments captured from the Apify profile run (no extra cost).
// Cached 6 h for YouTube.
// ---------------------------------------------------------------------------
let ytCommentsCache = { at: 0, data: null };
const YT_COMMENTS_TTL = 6 * 60 * 60 * 1000;

async function getYouTubeComments(youtube) {
  if (!YOUTUBE_API_KEY) return [];
  if (ytCommentsCache.data && Date.now() - ytCommentsCache.at < YT_COMMENTS_TTL) return ytCommentsCache.data;
  const vids = (youtube && youtube.available && Array.isArray(youtube.recentVideos))
    ? youtube.recentVideos.slice().sort((a, b) => b.viewCount - a.viewCount).slice(0, 6)
    : [];
  const out = [];
  for (const v of vids) {
    try {
      const j = await ytFetch(`${YT_BASE}/commentThreads?part=snippet&videoId=${v.id}&order=relevance&maxResults=5&textFormat=plainText&key=${YOUTUBE_API_KEY}`);
      for (const it of j.items || []) {
        const c = it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet;
        if (!c) continue;
        const text = (c.textOriginal || c.textDisplay || '').trim();
        if (!text) continue;
        out.push({ platform: 'youtube', text: text.slice(0, 280), author: c.authorDisplayName || '', likes: toNumber(c.likeCount, 0), video: v.title, url: v.url });
      }
    } catch (e) { /* commentsDisabled / private → skip this video */ }
  }
  out.sort((a, b) => b.likes - a.likes);
  if (out.length) ytCommentsCache = { at: Date.now(), data: out };
  return out;
}

function igCommentsFrom(social) {
  const posts = (social && social.instagram && Array.isArray(social.instagram.latestPosts)) ? social.instagram.latestPosts : [];
  const out = [];
  for (const p of posts) {
    for (const c of (Array.isArray(p.comments) ? p.comments : [])) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      out.push({ platform: 'instagram', text: text.slice(0, 280), author: c.owner || '', likes: toNumber(c.likes, 0), video: (p.caption || 'post').slice(0, 60), url: p.url || '' });
    }
  }
  return out;
}

function ttCommentsFrom(tiktok) {
  const posts = (tiktok && tiktok.tiktok && Array.isArray(tiktok.tiktok.latestPosts)) ? tiktok.tiktok.latestPosts : [];
  const out = [];
  for (const p of posts) {
    for (const c of (Array.isArray(p.comments) ? p.comments : [])) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      out.push({ platform: 'tiktok', text: text.slice(0, 280), author: c.owner || '', likes: toNumber(c.likes, 0), video: (p.caption || 'video').slice(0, 60), url: p.url || '' });
    }
  }
  return out;
}

async function getComments(youtube, social, tiktok) {
  const yt = await getYouTubeComments(youtube).catch(() => []);
  const ig = igCommentsFrom(social);
  const tt = ttCommentsFrom(tiktok);
  const all = [...yt, ...ig, ...tt];
  return { available: all.length > 0, comments: all, counts: { all: all.length, youtube: yt.length, instagram: ig.length, tiktok: tt.length } };
}

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
// AI daily briefing — headless `claude -p` run, cached in brief.json. Same
// binary resolution + env strip as the terminal spawn, but plain child_process
// (no PTY needed for a one-shot print). Single-flight; client polls GET.
// NOTE: must stay one line, no double quotes, no `%` — it rides through
// `cmd /s /c "..."` for the shim/name spawn kinds.
// ---------------------------------------------------------------------------
const BRIEF_PROMPT = "Write Yish's daily AIOS briefing. First check his Google Calendar for today's and tomorrow morning's events using the calendar tool if one is available - if the lookup fails or no calendar tool exists, skip it silently and never mention it. A LIVE MARKET DATA block with real numbers is appended at the end of this prompt - use ONLY those numbers for anything about the market or his stocks, never look prices up or invent them, and if the block is absent just skip the money line. Plain text only, no markdown syntax, max 160 words. Lead with what needs action today (calendar events with their times, YDdetailers leads/bookings, school, anything urgent in memory). Then one line each: SCHEDULE (today's events), BUSINESS (YDdetailers), MONEY (how the market is doing today AND a quick read on his portfolio - overall day change, all-time gain, and the single biggest mover - in plain words, not just numbers), PERSONAL. End with exactly one specific suggested next action. Be specific and direct, no filler, talk to him like a sharp assistant who knows his world.";
const BRIEF_MODEL = 'claude-opus-4-8'; // pin the model - headless default was Fable 5 (now unavailable)
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
      finish({ status: 'ready', generatedAt: new Date().toISOString(), text });
    } else {
      const why = errOut.trim().slice(0, 500) || ('claude exited with code ' + code + (text ? '' : ' and no output'));
      finish({ status: 'error', startedAt, error: why });
    }
  });
}

// ---------------------------------------------------------------------------
// New-post detection — stamp each content item the first time we see it. Items
// first seen within 48 h are flagged isNew so the Command Center can surface
// "you just posted X". A cold start seeds without flooding everything as new.
// ---------------------------------------------------------------------------
const SEEN_FILE = path.join(AIOS_DATA_DIR, 'seen-content.json');
const NEW_WINDOW = 48 * 60 * 60 * 1000;
async function stampNewContent(content) {
  if (!content || !Array.isArray(content.items) || !content.items.length) return content;
  let seen = {};
  try { seen = JSON.parse(await fsp.readFile(SEEN_FILE, 'utf8')) || {}; } catch { /* first run */ }
  // Cold start: everything already posted is recorded as "old" (timestamp 0) so
  // we don't flag the whole back catalogue as new. Only posts that first appear
  // AFTER we've started tracking light up — and only for 48 h.
  const firstRun = Object.keys(seen).length === 0;
  const now = Date.now();
  let changed = false;
  for (const it of content.items) {
    const id = it.platform + ':' + (it.url || it.title || '');
    if (seen[id] == null) {
      seen[id] = firstRun ? 0 : now;
      changed = true;
      it.isNew = !firstRun;
    } else {
      it.isNew = seen[id] > 0 && (now - seen[id]) < NEW_WINDOW;
    }
  }
  if (changed) { try { await writeJsonAtomic(SEEN_FILE, seen); } catch { /* ignore */ } }
  content.newCount = content.items.filter((i) => i.isNew).length;
  content.newest = content.items.find((i) => i.isNew) || null;
  return content;
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
// Express app — serves ONLY ./public (no dotfiles, no project root)
// ---------------------------------------------------------------------------
const app = express();
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
  if (nextdoorPolling) return res.json({ polling: true });
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

// Live stock quotes — Yahoo v8 chart (per-symbol), server-cached ~4s. No API key.
const quoteCache = {};
const QUOTE_TTL = 4000;
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
  const out = { price, prevClose: prev, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, currency: m.currency || 'USD', state };
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
app.get('/api/quotes', async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s)).slice(0, 40);
  const now = Date.now();
  const need = syms.filter((s) => !(quoteCache[s] && now - quoteCache[s].at < QUOTE_TTL));
  await Promise.allSettled(need.map(async (s) => { try { quoteCache[s] = { at: Date.now(), data: await fetchYahooQuote(s) }; } catch { /* keep prior */ } }));
  const quotes = {};
  for (const s of syms) if (quoteCache[s]) quotes[s] = quoteCache[s].data;
  res.json({ quotes, at: new Date().toISOString() });
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
  if (cached.status === 'generating' && !briefGenerating) {
    return res.json({ ...cached, status: 'error', error: 'generation interrupted' });
  }
  res.json(cached);
});

app.post('/api/brief/generate', (req, res) => {
  if (briefGenerating) return res.json({ status: 'generating' });
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

// Resolve the claude binary once at boot. { kind, value }:
//  'exe'  → spawn directly;
//  'shim' → run via cmd.exe with the quoted path (.cmd/.bat that cmd can exec);
//  'name' → run via cmd.exe as bare `claude` so PATHEXT finds claude.cmd
//           (npm also drops an extensionless Unix shim that cmd can't run — so
//            never quote a full path to that; rely on the bare name instead).
const CLAUDE = (() => {
  const explicit = process.env.AIOS_CLAUDE_BIN;
  if (explicit) {
    return { kind: path.extname(explicit).toLowerCase() === '.exe' ? 'exe' : 'shim', value: explicit };
  }
  let onPath = false;
  try { execSync('where claude', { stdio: 'ignore' }); onPath = true; } catch { /* not on PATH */ }
  if (onPath) return { kind: 'name', value: 'claude' };
  const exe = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(exe)) return { kind: 'exe', value: exe };
  const cmd = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
  if (fs.existsSync(cmd)) return { kind: 'shim', value: cmd };
  return { kind: 'name', value: 'claude' };
})();

function buildSpawn(skill) {
  const slash = skill ? '/' + skill : '';
  if (CLAUDE.kind === 'exe') return { file: CLAUDE.value, args: slash ? [slash] : [] };
  // .cmd / bare name → run through the shell (ConPTY can't exec a shim directly).
  const comspec = process.env.ComSpec || 'cmd.exe';
  const ref = CLAUDE.kind === 'name' ? 'claude' : `"${CLAUDE.value}"`;
  return { file: comspec, args: ['/d', '/s', '/c', ref + (slash ? ' ' + slash : '')] };
}

function ptyEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // use the claude.ai subscription login, not the paid API
  env.TERM = 'xterm-256color';
  if (CLAUDE.value.includes(path.sep)) {
    env.PATH = path.dirname(CLAUDE.value) + path.delimiter + (env.PATH || '');
  }
  return env;
}

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
