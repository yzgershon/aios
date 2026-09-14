# Handoff

JARVIS approval correction, 13 September 2026: ordinary keyboard input and search submission now auto-approve; the old filter incorrectly matched `send_hotkey`. Consequential actions retain approval. Contract version 3 is active, all 18 tests pass, and eight live decision checks passed. See the approval correction in `C:\Dev\Jarvis\CAPABILITIES-2026-09-13.md`; evidence/backups are in `C:\Dev\.codex-staging\jarvis-approval-fix`.

JARVIS capability update, 13 September 2026: see `C:\Dev\Jarvis\CAPABILITIES-2026-09-13.md` for the computer, personal, project and research workflows, 64-tool catalogue, validation and limitations. This builds on the optimization below. Changes remain local and uncommitted.

JARVIS update, 13 September 2026: see `C:\Dev\Jarvis\OPTIMIZATION-2026-09-13.md` for architecture, fixes, benchmarks, live verification and rollback. The repaired Codex login, cancellation, command routing, speech queue and Flash voice are running locally. Implementation changes remain uncommitted. The older project handoff below is retained for context.

Last updated:
- 2026-07-07 by Codex
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

## 2026-07-07 - Jarvis/Ollama Local Model Handoff

Current Jarvis direction:
- Use local Ollama/Gemma for easy fast-lane voice turns to reduce Claude usage.
- Keep Claude as the deep lane for vault/tool/action/computer requests until local tool calling is safely wired.

What changed:
- `C:\Dev\AIOS\lib\jarvis.js`: `JARVIS_FAST_MODEL` now defaults to `gemma4:latest`.
- AIOS fast-lane Ollama request now uses `num_ctx: 4096`, `think: false`, `keep_alive: "24h"`, `num_predict: 120`, and `temperature: 0.6`.
- `C:\Dev\Flow\src\AppSettings.cs`, `C:\Dev\Flow\ui\index.html`, `C:\Dev\Flow\README.md`, and live `%APPDATA%\Flow\settings.json` now point Flow's AI polish model at `gemma4:latest` instead of the broken `llama3.2` tag.

Model inventory:
- `gemma4:latest`: 8B Q4_K_M, capabilities include completion, vision, audio, tools, thinking. This is the strongest installed local overall model.
- `llama3.1:latest`: 8B Q4_K_M, tools capable. This is the strongest installed Llama-family model.
- `llama3.2:3b`: 3.2B Q4_K_M, tools capable. Flow's old `llama3.2` setting failed because the installed tag is `llama3.2:3b`.
- Ollama CLI is not in PATH, but the local API at `http://localhost:11434` works.

Verification:
- `node --check C:\Dev\AIOS\lib\jarvis.js` passed.
- Direct Ollama `/api/chat` with `gemma4:latest`, `num_ctx: 4096`, and `think: false` worked.
- AIOS restarted successfully and `/api/health` returned ok.
- `/api/jarvis/chat-stream` returned local fast-lane replies in about 8-9 seconds after disabling thinking.

Important unfinished work:
- No local Ollama/Gemma tools were added yet.
- Safe first local tools should be read-only: current time, AIOS health, Jarvis voice status, local model status/list, goals, todos, portfolio, pipeline, Nextdoor lead snapshot, and small vault search.
- Keep write/run/open/send/post/delete/purchase actions behind Claude approval.

Updated by Codex at 2026-07-07 13:21:55 -04:00.

## 2026-07-16 - Jarvis turn endpointing and STT latency

Live now:

- The browser uses `/api/jarvis/listen-stream`; AIOS proxies NDJSON from JarvisVoice without buffering.
- JarvisVoice flushes `speech-ended` as soon as VAD closes capture. The UI removes the red mic state and switches to thinking before Whisper returns the transcript.
- Short turns endpoint after about 560 ms of silence. Turns with at least four seconds of voiced audio receive about 800 ms for safer natural pauses.
- JarvisVoice uses Whisper.net 1.9.1, `ggml-tiny.en.bin`, 4 threads, deterministic single-segment decoding, and automatic 768/full audio context.
- Final staging benchmarks: 321 ms average for a 1.5-second synthetic time question; 1,575 ms average for a seven-second request. Promoted live measurements with the full stack running were 1,515 ms and 3,400 ms respectively.
- Chrome QA passed for Command Center and Second Brain with no console warnings/errors. Live no-speech streaming, direct STT, health, and wake re-arm checks passed.

Jarvis-side details and rollback instructions are in `C:\Dev\Jarvis\HANDOFF.md`. Pre-change snapshot: `C:\Dev\.codex-backups\Jarvis-endpointing-20260716-001040`.
