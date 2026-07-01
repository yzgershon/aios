# AIOS — Yish's AI Operating System

A single-pane, dark "editorial / Riso-print" dashboard that runs locally at
**http://localhost:3000**. It shows your content intelligence, social + business
metrics, active projects, and an **embedded interactive Claude Code terminal**
that runs your skills inside the app.

Everything binds to loopback only (`127.0.0.1` + `::1`). The server runs a real
shell, so it is **never** exposed to the network. Only `public/` is served over
HTTP — `server.js`, `.env`, and `node_modules` are unreachable.

---

## Run it

From PowerShell:

```powershell
cd $env:USERPROFILE\Desktop\AIOS
node server.js
```

Then open **http://localhost:3000**. To stop it: `Ctrl+C` in that window.

(First run only: `npm install` — already done during setup.)

---

## What each tile shows

| Tile | Source | Today |
|---|---|---|
| **Drops** (lead) | `~/.aios/content-intel.json` → `drops[]` | "No data yet" CTA until you populate the file |
| **Signal** | `content-intel.json` → `signal[]` | same |
| **YouTube** (hero) | YouTube Data API v3, handle `@yddetailers` | "Add a key" CTA until `YOUTUBE_API_KEY` is set |
| **Competitors** | `content-intel.json` → `competitors[]` | "No data yet" |
| **Top Comments** | `content-intel.json` → `topComments[]` | "No data yet" |
| **Net Worth** | `motorcycle + cash` from `~/.aios/metrics.json` + live brokerage value from `portfolio.json` | `💸💸💸` until bike/bank are set — click **edit** |
| **Instagram** | Apify (live) → falls back to manual | "Connect Apify" / manual number — click **edit** |
| **Projects** | `~/.aios/projects.md` (a markdown table) | Your active projects (pre-filled, editable) |
| **Terminal** | your local `claude` CLI | Fully working now — your subscription login |

Each source fails independently: a broken or missing one shows a clean CTA
instead of blanking the dashboard.

---

## Where your keys go

All secrets live in **`.env`** (in the project root, never served, never in
source). Open it and paste:

```
YOUTUBE_API_KEY=...your key...
APIFY_API_TOKEN=...your token...
```

Save, then hit **Refresh** in the masthead (or restart). The matching tile
flips from its CTA state to live data.

### YouTube Data API v3 key (5 minutes)
1. Go to https://console.cloud.google.com and create a project (or pick one).
2. **APIs & Services → Library →** search **"YouTube Data API v3" → Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. (Recommended) **Restrict key → API restrictions → YouTube Data API v3**.
5. Paste it as `YOUTUBE_API_KEY=` in `.env`.

The tile uses cheap quota paths (channel by handle + `playlistItems` + batched
`videos`), filters out Shorts (< 120s), keeps your latest ~10 long-form, and
caches for 5 minutes.

### Apify token (Instagram)
1. Sign up at https://apify.com (free tier ≈ $5/mo credit — plenty for a daily pull).
2. **Settings → Integrations → Personal API tokens** → copy.
3. Paste as `APIFY_API_TOKEN=` in `.env`.

Apify costs money per run, so AIOS **never** calls it on the 5-minute poll. It
caches results to `~/.aios/social-cache.json` for 12 hours and only refreshes in
the background when stale. Force a pull any time:

```powershell
curl.exe -X POST http://localhost:3000/api/social/refresh
```

---

## The embedded terminal

- The bar at the bottom is **collapsed by default**. Click `▸_` or any skill button to expand.
- Buttons run real Claude Code skills: **Morning Brief · Nextdoor Ad · Reply Customer · Audit · Level Up · Log · Search**, plus a bare **Claude** session.
- It runs `claude` from your **SecondBrain vault** (`C:\Dev\SecondBrain`) so your
  skills, `CLAUDE.md`, and memory all load — it *is* your second brain, not a blank Claude.
- It uses your **claude.ai subscription** (the server strips `ANTHROPIC_API_KEY` from the terminal's environment so it never bills the paid API).
- Type and approve prompts live, exactly like a normal Claude Code session.

**Resize / collapse:**
- Drag the two **vertical bars** between columns to rebalance them.
- Drag the **horizontal bar** above the terminal to change its height.
- Click `▸_` (or the caret) to collapse/expand the terminal.
- Your column sizes, terminal height, and collapsed state persist in the browser (`localStorage`).

Under ~1100px wide the layout stacks into one column and the splitters hide.

---

## Config (non-secret), in `.env`

| Key | Default | Meaning |
|---|---|---|
| `YOUTUBE_HANDLE` | `@yddetailers` | Channel handle for the YouTube tile |
| `INSTAGRAM_USERNAME` | `yddetailers` | IG username for Apify + the metric |
| `PORT` | `3000` | Server port |
| `AIOS_CLAUDE_CWD` | `C:\Dev\SecondBrain` | Folder the terminal's claude runs in |
| `AIOS_CLAUDE_BIN` | auto-detect | Pin the claude binary if needed |
| `PROJECTS_FILE` | `~/.aios/projects.md` | Markdown table for the Projects tile |
| `CONTENT_INTEL_FILE` | `~/.aios/content-intel.json` | Content-intelligence JSON |

---

## Populate content intelligence

Copy the example and edit:

```powershell
Copy-Item $env:USERPROFILE\.aios\content-intel.example.json $env:USERPROFILE\.aios\content-intel.json
```

Shape: `{ timestamp, drops[], signal[], competitors[], topComments[] }`. Fill it
however you like — a news script, a Scheduled Task, or by hand. AIOS just reads it.

---

## Optional: start AIOS automatically on login

Not installed by default (it's OS-level persistence). Pick one:

**A. Startup-folder shortcut (simplest, no admin).** Create a `.cmd` in
`shell:startup`:
```powershell
$cmd = "@echo off`r`ncd /d `"$env:USERPROFILE\Desktop\AIOS`"`r`nnode server.js"
$cmd | Out-File -Encoding ascii "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\AIOS.cmd"
```

**B. Task Scheduler (runs at logon, can restart on failure):**
```powershell
schtasks /Create /SC ONLOGON /TN AIOS /TR "node \"$env:USERPROFILE\Desktop\AIOS\server.js\""
```

**C. pm2** if you want process supervision (`npm i -g pm2 pm2-windows-startup`).

Ask Claude to set any of these up — it won't install persistence without your go-ahead.

---

## Troubleshooting

- **Terminal says "unavailable":** `node-pty`'s native binary didn't load on your
  Node version. The server auto-falls-back to `@homebridge/node-pty-prebuilt-multiarch`.
  If both fail, run `npm install @homebridge/node-pty-prebuilt-multiarch` in the
  project — `server.js` will pick it up. Check `http://localhost:3000/api/health`.
- **Port 3000 busy:** set `PORT=` in `.env` to a free port.
- **Verify the API:** `Invoke-RestMethod http://localhost:3000/api/data | ConvertTo-Json -Depth 6`

---

*Built with Express + ws + node-pty. No front-end framework, no build step.*
