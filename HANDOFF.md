# Handoff

Last updated:
- 2026-07-02 by Codex

Current goal:
- Keep AIOS as a normal C:\Dev project so Claude Code and Codex can both work from the same local workspace.

Current state:
- What works:
  - AIOS project now lives at `C:\Dev\AIOS`.
  - Local dashboard runs at `http://localhost:3000`.
  - Windows scheduled task `AIOS Server` points to `C:\Dev\AIOS\scripts\start-aios-server.vbs`.
  - `node scripts/verify.js` passed after the move.
  - Chrome local check loaded `http://127.0.0.1:3000` and showed `AIOS - Mission Control`.
- What is broken:
  - Nothing known from this move.
- What is intentionally unfinished:
  - Nothing known right now.

Done this session:
- Moved AIOS from `C:\Users\yzger\Desktop\AIOS` to `C:\Dev\AIOS`.
- Updated README manual run path.
- Updated startup VBS current directory.
- Updated the Windows `AIOS Server` scheduled task action.
- Updated SecondBrain active AIOS memory references.
- Restarted AIOS from the new path and verified localhost responds.
- Committed and pushed AIOS move/update as `6b06630 Move AIOS into Dev workspace`.
- Re-ran `node scripts/verify.js`; it passed.
- Re-checked AIOS in Chrome after Yish's later changes; it loaded successfully.

Files changed:
- `README.md`
- `scripts/start-aios-server.vbs`
- `HANDOFF.md`
- `C:\Dev\SecondBrain\memory\MEMORY.md`
- `C:\Dev\SecondBrain\daily\aios\AIOS.md`

Important context:
- Claude Code remains the master memory/source of truth through `C:\Dev\SecondBrain`.
- Codex can now edit AIOS normally because it is under `C:\Dev`.
- Do not push, deploy, send, export, delete customer data, or spend money without Yish's explicit approval.

Do not touch yet:
- `.env`
- `~/.crm-service-creds.json`
- production CRM writes/deletes
- external sends/posts

Next steps:
1. If needed, open the dashboard in Chrome and inspect any page Yish wants edited.
2. For future AIOS work, check git status, this handoff, README current state, and SecondBrain memory before editing.
3. For substantial AIOS work, update this handoff before stopping.

How to verify:
- Open: `http://localhost:3000`
- Check: `node scripts/verify.js`
- Expected result: verifier returns `{"ok": true, "count": 0, "issues": []}`.
