# AIOS — Yish's Mission Control

A local, single-pane dashboard at **http://localhost:3000** — business metrics,
portfolio, lead pipeline, goals, a vault graph, and an embedded Claude Code
terminal. Express + ws + node-pty, plain HTML/CSS/JS, no build step.

---

## CURRENT STATE / WHERE WE LEFT OFF

> Keep this section honest. When a work session ends, update it. If a session
> dies mid-task, add a one-line `IN PROGRESS:` note so the next resume is exact.

**Last updated: 2026-07-01**

- v2 "Mission Control" (June 12 rebuild) + the July 1 hardening pass:
  git + private GitHub (`yzgershon/aios`), Host-header allowlist,
  CRM reads server-side (`/api/crm`), to-do seeds in `~/.aios/todos.json`,
  revenue hero has month navigation (‹ › pages back through past months).
- Ads page is intentionally static — Meta campaign not launched yet.
  When it launches: wire the Meta Marketing API.
- Server runs via the `AIOS Server` scheduled task at logon (see below).

---

## Run it

Normally the **`AIOS Server` scheduled task** starts it at logon. Manually:

```powershell
cd $env:USERPROFILE\Desktop\AIOS
node server.js
```

Open **http://localhost:3000**. Server binds loopback + the Tailscale
interface only — never the LAN. Phone access via Tailscale (dashboard works;
the terminal is deliberately desktop-only since it's a real shell).

**After editing `server.js`: restart the server.** Frontend-only edits just
need a browser refresh (static files are served `no-cache`).

## Pages

| Page | What it shows |
|---|---|
| **Command Center** | Revenue hero (CRM detailing + live stock P/L, month nav), Net Worth, AI Daily Briefing, Revenue Trend, Bookings Heatmap, Content/Trending/Competitors/Comments, Local Demand (Nextdoor leads), Focus·To-Do |
| **Pipeline** | 4-column lead kanban; Nextdoor leads auto-import |
| **Portfolio** | Live quotes (5s), allocation, upcoming earnings |
| **Advertisements** | Meta-ads cockpit (static until campaign launch) |
| **Goals** | Savings targets w/ milestones + projections |
| **Second Brain** | Force-directed graph of the Obsidian vault |

Global: Ctrl+K palette, notification bell, privacy blur (eye), sounds,
Robbie the dog mascot (`public/js/mascot.js`), embedded terminal (bottom bar).

## Data sources

| Source | Mechanism | Config |
|---|---|---|
| CRM (clients/bookings) | server-side Firestore REST via `~/.crm-service-creds.json` (read-only login), `GET /api/crm` | creds file |
| Stocks/quotes | Yahoo Finance (unofficial), cookie+crumb for earnings | none |
| YouTube | Data API v3 | `YOUTUBE_API_KEY` |
| Instagram/TikTok | Apify actors, 6h cache | `APIFY_API_TOKEN` |
| Nextdoor leads | IMAP poll of the leads Gmail every 15 min | `NEXTDOOR_IMAP_*` |
| AI Briefing | headless `claude -p` from the SecondBrain vault | claude CLI login |
| Vault graph | reads `C:\Dev\SecondBrain` markdown | `AIOS_CLAUDE_CWD` |

Every source fails independently — a broken one shows a CTA/empty state, never
a blank dashboard.

## Files that matter

- `server.js` — Express server (all APIs, terminal WebSocket, pollers)
- `public/js/core.js` — AIOS namespace, page registry, 5-min data poll
- `public/js/pages/*.js` — one module per page
- `public/js/{os,charts,terminal,mascot}.js` — palette/notifications/sounds, canvas charts, xterm terminal, Robbie
- `~/.aios/*.json` — all persistent data (metrics, portfolio, goals, pipeline, todos, leads, brief, caches)
- `.env` — secrets + config (never committed; see `.env.example`)
- `scripts/verify.js` — headless-Chrome QA: walks all 6 pages, fails on any
  console error. Run `node scripts/verify.js` after changes.

## Security posture

- Binds **loopback + Tailscale only**; never the LAN.
- **Host-header allowlist** on every request (blocks DNS rebinding).
- Terminal WebSocket: origin-checked, desktop-only, max 4 sessions,
  skill names validated against an allowlist.
- CRM credential lives in `~/.crm-service-creds.json` — server-side only,
  never served to a browser.
- `.env`, `node_modules`, logs: gitignored. Only `public/` is served.

## Scheduled tasks (Windows Task Scheduler)

- **AIOS Server** — starts `node server.js` hidden at logon.
- **AIOS Data Backup** — daily copy of `~/.aios` → `~/.aios-backups/`
  (30-day retention), script at `scripts/backup-aios-data.ps1`.

## Git

Private repo: **github.com/yzgershon/aios**. Commit after every working
change; push regularly. `.env` and data never leave the machine.
