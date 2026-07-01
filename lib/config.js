'use strict';
// AIOS config — .env loader + all env-derived constants and file paths.
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const PROJECT_DIR = path.join(__dirname, '..');
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
const TODOS_FILE = path.join(AIOS_DATA_DIR, 'todos.json');
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


module.exports = { PROJECT_DIR, PORT, YOUTUBE_HANDLE, INSTAGRAM_USERNAME, TIKTOK_USERNAME, YOUTUBE_API_KEY, APIFY_API_TOKEN, NEXTDOOR_IMAP_USER, NEXTDOOR_IMAP_PASS, NEXTDOOR_IMAP_HOST, NEXTDOOR_MAILBOX, NEXTDOOR_KEYWORDS, AIOS_DATA_DIR, PROJECTS_FILE, METRICS_FILE, SOCIAL_CACHE_FILE, CONTENT_SAMPLE_FILE, PORTFOLIO_FILE, NEXTDOOR_LEADS_FILE, PIPELINE_FILE, META_LEADS_SHEET_URL, GOALS_FILE, BRIEF_FILE, TODOS_FILE, VAULT_DIR, CLAUDE_CWD, SKILLS, SKILL_SET, SKILL_RE };
