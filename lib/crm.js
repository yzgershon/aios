'use strict';
// AIOS CRM reader — YDdetailers Firestore via the read-only service login.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { settle, writeJsonAtomic, toNumber, abbrevNum, parseISO8601Duration, slugify, parseMarkdownTable, pool, freshness, markFresh } = require('./util');

// ---------------------------------------------------------------------------
// CRM (YDdetailers Firestore) — read server-side via the read-only service
// login in ~/.crm-service-creds.json, so no credential is ever served to the
// browser. Firestore REST + Identity Toolkit sign-in; token cached ~50 min,
// collections cached 60 s (the dashboard polls every 5 min anyway).
// ---------------------------------------------------------------------------
const CRM_CREDS_FILE = path.join(os.homedir(), '.crm-service-creds.json');
let crmAuth = { at: 0, idToken: null };
let crmCache = { at: 0, data: null };
const CRM_TOKEN_TTL = 50 * 60 * 1000;
const CRM_TTL = 60 * 1000;

async function crmToken() {
  if (crmAuth.idToken && Date.now() - crmAuth.at < CRM_TOKEN_TTL) return crmAuth;
  const c = JSON.parse(await fsp.readFile(CRM_CREDS_FILE, 'utf8'));
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(c.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: c.reader.email, password: c.reader.password, returnSecureToken: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('crm sign-in ' + r.status);
  const j = await r.json();
  crmAuth = { at: Date.now(), idToken: j.idToken, projectId: c.projectId };
  return crmAuth;
}

// Firestore typed value → plain JS
function fsVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return fsFields(v.mapValue.fields || {});
  if (v.arrayValue) return (v.arrayValue.values || []).map(fsVal);
  return null;
}
function fsFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fsVal(fields[k]);
  return out;
}

async function crmCollection(name) {
  const auth = await crmToken();
  const docs = [];
  let pageToken = '';
  do {
    const u = `https://firestore.googleapis.com/v1/projects/${auth.projectId}/databases/(default)/documents/${encodeURIComponent(name)}?pageSize=300` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + auth.idToken }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401) { crmAuth = { at: 0, idToken: null }; throw new Error('crm auth expired'); }
    if (!r.ok) throw new Error('crm read ' + r.status);
    const j = await r.json();
    for (const d of j.documents || []) docs.push({ id: String(d.name || '').split('/').pop(), ...fsFields(d.fields || {}) });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function getCrm(force) {
  if (!force && crmCache.data && Date.now() - crmCache.at < CRM_TTL) return crmCache.data;
  const [clients, bookings] = await Promise.all([crmCollection('clients'), crmCollection('bookings')]);
  const data = { available: true, fetchedAt: new Date().toISOString(), clients, bookings };
  crmCache = { at: Date.now(), data };
  markFresh('crm');
  return data;
}


module.exports = { getCrm };
