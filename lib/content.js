'use strict';
// AIOS content intelligence — YouTube channel + trends + comments, Apify
// Instagram/TikTok, the unified content carousel, and new-post stamping.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE } = require('./config');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, parseMarkdownTable, pool, freshness, markFresh } = require('./util');

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
    markFresh('youtube');
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
    if (data.available) { trendsCache = { at: Date.now(), data }; markFresh('trends'); }
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


module.exports = { getYouTube, getSocial, getTikTok, getTrends, getContent, getComments, refreshSocial, readSocialCache, stampNewContent, SOCIAL_TTL };
