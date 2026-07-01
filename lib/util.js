'use strict';
// AIOS shared helpers — small pure utilities + the freshness registry.
const fs = require('fs');
const fsp = fs.promises;

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
// Freshness — when did each upstream source last actually succeed? (Cache
// reads don't count.) Feeds the Command Center freshness strip so a silently
// dead source is visible instead of hiding behind per-tile empty states.
// ---------------------------------------------------------------------------
const freshness = {};
function markFresh(key) { freshness[key] = new Date().toISOString(); }


module.exports = { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, pool, freshness, markFresh };
