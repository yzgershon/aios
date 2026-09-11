'use strict';
// AIOS Jarvis — the voice assistant's brain. Same headless `claude -p` engine as
// the daily brief (free subscription login, no API key), but conversational and
// grounded in the vault so it inherits every skill, MCP connection, and the
// SOUL/CLAUDE.md rules automatically. The prompt is piped over STDIN (not the
// command line) so arbitrary user speech — quotes, %, newlines — can never break
// the spawn or need escaping.
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { CLAUDE_CWD, VAULT_DIR, AIOS_DATA_DIR, PROJECT_DIR } = require('./config');
const { CLAUDE, ptyEnv } = require('./claude');
const { LOCAL_TOOL_SYSTEM_PROMPT, isLocalToolMessage, localToolsForMessage, tryDirectLocalTool, executeLocalToolCall } = require('./jarvis-tools');

// Pinned for consistent quality; override with JARVIS_MODEL in .env. Opus is the
// proven headless model (the brief uses it). Switch to a faster model later for
// lower voice latency once the loop is solid.
const JARVIS_MODEL = (process.env.JARVIS_MODEL || 'claude-opus-4-8').trim();
const LEGACY_BRAIN_ENABLED = String(process.env.JARVIS_LEGACY_BRAIN || '').toLowerCase() === 'true';
// Long enough for tool-using turns that wait on a human approval (90s gate).
const JARVIS_TIMEOUT = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Phase 3 — computer control with the confirm-risky gate. Every Jarvis spawn
// gets: (a) an approval MCP server (scripts/jarvis-approve-mcp.js) wired as the
// --permission-prompt-tool, so any tool call NOT pre-allowed pauses and asks
// Yish in the UI; (b) a pre-allow list for read-only tools so lookups never
// nag. Writes, edits, Bash commands, and anything else hit the gate.
// The MCP config file is (re)written at boot so paths always match this repo.
// ---------------------------------------------------------------------------
const APPROVE_MCP_CONFIG = path.join(AIOS_DATA_DIR, 'jarvis-approve-mcp.json');
if (LEGACY_BRAIN_ENABLED) {
  try {
    fs.writeFileSync(APPROVE_MCP_CONFIG, JSON.stringify({
      mcpServers: { approve: { command: 'node', args: [path.join(PROJECT_DIR, 'scripts', 'jarvis-approve-mcp.js')] } },
    }));
  } catch (e) { console.error('[jarvis] could not write approval MCP config:', (e && e.message) || e); }
}
const SAFE_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch,TodoWrite';
const PERM_ARGS = [
  '--mcp-config', APPROVE_MCP_CONFIG,
  '--permission-prompt-tool', 'mcp__approve__approval_prompt',
  '--allowedTools', SAFE_TOOLS,
];
const JARVIS_STDOUT_CAP = 32 * 1024;
const MAX_HISTORY = 12; // recent turns kept for context

// Built-in persona fallback if memory/JARVIS.md is missing from the vault.
const DEFAULT_PERSONA = [
  'You are JARVIS, Yish\'s spoken assistant inside his AI Operating System.',
  'Answers are read ALOUD, so: keep it to 1-3 sentences, plain spoken English,',
  'no markdown, no bullets, no emoji. Lead with the answer or action, then stop.',
  'Call him Yish. Be sharp, calm, a little dry. If something is not in memory, say so.',
  'Never send, post, spend, or do anything destructive without an explicit yes.',
].join(' ');

async function loadPersona() {
  try { return (await fsp.readFile(path.join(VAULT_DIR, 'memory', 'JARVIS.md'), 'utf8')).slice(0, 8000); }
  catch { return DEFAULT_PERSONA; }
}

// Flatten the recent conversation into a plain transcript the model can follow.
function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const lines = history.slice(-MAX_HISTORY).map((t) => {
    const who = t && t.role === 'assistant' ? 'JARVIS' : 'Yish';
    const text = String((t && t.content) || '').slice(0, 4000).trim();
    return text ? who + ': ' + text : '';
  }).filter(Boolean);
  return lines.length ? '\n\nConversation so far:\n' + lines.join('\n') : '';
}

async function buildPrompt(message, history) {
  const persona = await loadPersona();
  return [
    persona,
    renderHistory(history),
    '\n\nYish just said: ' + String(message || '').slice(0, 8000).trim(),
    '\n\nRespond as JARVIS — short, spoken, plain text only.',
  ].join('');
}

// Spawn `claude -p` with NO prompt argument; the prompt goes over stdin. Mirrors
// lib/claude.js binary resolution: direct for .exe, via cmd.exe for shim/name.
// extraArgs must be plain flags (no user input — they ride through cmd /s /c).
function jarvisSpawn(extraArgs = []) {
  const args = ['-p', '--model', JARVIS_MODEL, ...PERM_ARGS, ...extraArgs];
  if (CLAUDE.kind === 'exe') {
    return spawn(CLAUDE.value, args, { cwd: CLAUDE_CWD, env: ptyEnv(), windowsHide: true });
  }
  const comspec = process.env.ComSpec || 'cmd.exe';
  const ref = CLAUDE.kind === 'name' ? 'claude' : `"${CLAUDE.value}"`;
  const line = `${ref} ${args.join(' ')}`;
  return spawn(comspec, ['/d', '/s', '/c', `"${line}"`], {
    cwd: CLAUDE_CWD, env: ptyEnv(), windowsHide: true, windowsVerbatimArguments: true,
  });
}

// Run one turn. Resolves { reply } or rejects with an Error.
async function jarvisChat(message, history) {
  if (!message || !String(message).trim()) throw new Error('empty message');
  const prompt = await buildPrompt(message, history);

  return new Promise((resolve, reject) => {
    let proc;
    try { proc = jarvisSpawn(); }
    catch (e) { return reject(new Error('spawn failed: ' + String((e && e.message) || e))); }

    let out = '', errOut = '', timedOut = false, settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* ignore */ } }, JARVIS_TIMEOUT);

    proc.stdout.on('data', (d) => { if (out.length < JARVIS_STDOUT_CAP) out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
    proc.on('error', (e) => done(reject, new Error(String((e && e.message) || e))));
    proc.on('close', (code) => {
      const text = out.slice(0, JARVIS_STDOUT_CAP).trim();
      if (timedOut) return done(reject, new Error('Jarvis timed out'));
      if (code === 0 && text) return done(resolve, { reply: text });
      const why = errOut.trim().slice(0, 400) || ('claude exited with code ' + code + (text ? '' : ' and no output'));
      done(reject, new Error(why));
    });

    // Feed the prompt over stdin, then close it so print-mode runs.
    try { proc.stdin.write(prompt); proc.stdin.end(); }
    catch (e) { done(reject, new Error('stdin write failed: ' + String((e && e.message) || e))); }
  });
}

// Streaming turn — same brain, but text is delivered as it's generated so the
// voice can start speaking mid-thought. `claude -p --output-format stream-json
// --include-partial-messages` emits JSONL events on stdout; we forward the
// text deltas via onDelta(chunk) and resolve with the full reply. Falls back
// gracefully: if no deltas ever arrive (older CLI), the final result event
// still carries the whole text.
function jarvisChatStream(message, history, onDelta) {
  if (!message || !String(message).trim()) return Promise.reject(new Error('empty message'));

  return buildPrompt(message, history).then((prompt) => new Promise((resolve, reject) => {
    let proc;
    try { proc = jarvisSpawn(['--output-format', 'stream-json', '--include-partial-messages', '--verbose']); }
    catch (e) { return reject(new Error('spawn failed: ' + String((e && e.message) || e))); }

    let full = '', resultText = '', errOut = '', buf = '', timedOut = false, settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* ignore */ } }, JARVIS_TIMEOUT);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; } // non-JSON noise
      // partial text deltas (the speak-while-thinking payload)
      if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
          && ev.event.delta && ev.event.delta.type === 'text_delta' && ev.event.delta.text) {
        full += ev.event.delta.text;
        if (onDelta) { try { onDelta(ev.event.delta.text); } catch { /* listener error is not our problem */ } }
      } else if (ev.type === 'result' && typeof ev.result === 'string') {
        resultText = ev.result; // authoritative final text
      }
    };

    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      if (buf.length > 1 << 20) buf = ''; // runaway single line — drop it
    });
    proc.stderr.on('data', (d) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
    proc.on('error', (e) => done(reject, new Error(String((e && e.message) || e))));
    proc.on('close', (code) => {
      if (buf) handleLine(buf);
      const reply = (resultText || full).trim();
      if (timedOut) return done(reject, new Error('Jarvis timed out'));
      if (code === 0 && reply) return done(resolve, { reply });
      done(reject, new Error(errOut.trim().slice(0, 400) || ('claude exited with code ' + code + (reply ? '' : ' and no output'))));
    });

    try { proc.stdin.write(prompt); proc.stdin.end(); }
    catch (e) { done(reject, new Error('stdin write failed: ' + String((e && e.message) || e))); }
  }));
}

// ---------------------------------------------------------------------------
// Warm session — the speed fix. Cold `claude -p` spawns cost 5-7s per turn
// (node boot + vault load + MCP connects). Instead we keep ONE claude process
// alive in stream-json input mode: user messages go in as JSONL lines, replies
// stream out, and the session itself remembers the conversation (no history
// replay needed). The persona rides on the first turn only. If the warm
// session is busy/dead, callers fall back to the cold path. Recycled after
// SESSION_MAX_TURNS so context can't grow unbounded.
// ---------------------------------------------------------------------------
const SESSION_MAX_TURNS = 30;
let warm = null; // { proc, busy, dead, turns, buf, onEvent }

function getWarm() {
  if (warm && !warm.dead && warm.proc.exitCode === null && warm.turns < SESSION_MAX_TURNS) return warm;
  if (warm && !warm.dead && warm.proc.exitCode === null) { try { warm.proc.kill(); } catch { /* ignore */ } }
  let proc;
  try {
    proc = jarvisSpawn(['--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']);
  } catch { warm = null; return null; }
  const w = { proc, busy: false, dead: false, turns: 0, buf: '', onEvent: null };
  proc.stdout.on('data', (d) => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, nl); w.buf = w.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (w.onEvent) { try { w.onEvent(ev); } catch { /* handler error */ } }
    }
    if (w.buf.length > 1 << 20) w.buf = '';
  });
  proc.stderr.on('data', () => { /* drain so the pipe never blocks */ });
  const die = () => { w.dead = true; if (w.onEvent) { try { w.onEvent({ type: '_closed' }); } catch { /* ignore */ } } };
  proc.on('close', die);
  proc.on('error', die);
  warm = w;
  return w;
}

// One turn through the warm session. Resolves { reply }, or null synchronously
// if the session is unavailable/busy (caller should use the cold path).
function jarvisChatWarm(message, onDelta) {
  const msg = String(message || '').slice(0, 8000).trim();
  if (!msg) return Promise.reject(new Error('empty message'));
  const w = getWarm();
  if (!w || w.busy || w.dead) return null;
  w.busy = true;
  const first = w.turns === 0;
  w.turns++;

  const personaP = first ? loadPersona() : Promise.resolve('');
  return personaP.then((persona) => new Promise((resolve, reject) => {
    const text = first
      ? persona + '\n\nYish just said: ' + msg + '\n\nRespond as JARVIS — short, spoken, plain text only. Every reply in this conversation gets read aloud.'
      : msg;
    let full = '', settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); w.onEvent = null; w.busy = false; fn(arg); };
    const timer = setTimeout(() => { try { w.proc.kill(); } catch { /* ignore */ } w.dead = true; done(reject, new Error('Jarvis timed out')); }, JARVIS_TIMEOUT);
    w.onEvent = (ev) => {
      if (ev.type === '_closed') return done(reject, new Error('warm session closed'));
      if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
          && ev.event.delta && ev.event.delta.type === 'text_delta' && ev.event.delta.text) {
        full += ev.event.delta.text;
        if (onDelta) { try { onDelta(ev.event.delta.text); } catch { /* ignore */ } }
      } else if (ev.type === 'result') {
        const reply = (typeof ev.result === 'string' && ev.result ? ev.result : full).trim();
        if (reply) return done(resolve, { reply });
        done(reject, new Error('empty reply'));
      }
    };
    try {
      w.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    } catch (e) { w.dead = true; done(reject, new Error('warm write failed: ' + String((e && e.message) || e))); }
  }));
}

// Preheat at server boot so even the first question skips the cold start.
if (LEGACY_BRAIN_ENABLED) setTimeout(() => { try { getWarm(); } catch { /* best effort */ } }, 2000);
// Preheat the fast lane too — pays the model-load + persona-eval cost (~11s)
// at boot instead of on Yish's first question.
if (LEGACY_BRAIN_ENABLED) setTimeout(() => { jarvisChatFast('hello', [], null).catch(() => { /* ollama off - fine */ }); }, 3000);

// Launch greeting — Phase 5. Short, spoken, time-aware; peeks at the calendar
// if the tool is there. Runs through the same warm session (falls back cold).
async function jarvisGreet() {
  const now = new Date();
  const stamp = now.toLocaleDateString('en-US', { weekday: 'long' }) + ' ' +
    now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const msg = 'It is ' + stamp + ' and Yish just opened the AIOS. Give his launch greeting: ' +
    'greet him by time of day in your dry JARVIS style, and if a calendar tool is available quickly check today\'s ' +
    'remaining events and work in the next one in plain words (if the lookup fails or there is nothing, skip it silently ' +
    'and never mention calendars). Two sentences maximum, spoken aloud, no markdown. Do not use any other tools.';
  const warmTry = jarvisChatWarm(msg, null);
  if (warmTry) { try { return await warmTry; } catch { /* fall through to cold */ } }
  return jarvisChatStream(msg, [], null);
}

// ---------------------------------------------------------------------------
// Offline TTS — Jarvis's own voice, fully local, no install and no cloud.
// Windows PowerShell (built-in .NET Framework) exposes System.Speech, so we
// shell to it: the reply text goes over STDIN (never the command line, so no
// injection or quoting issues) and the voice/rate/output path ride in env vars.
// It writes a WAV the browser plays back. Best available SAPI voice by default;
// premium neural voices (Piper / Windows natural voices) are a later upgrade.
// ---------------------------------------------------------------------------
const PS = process.env.ComSpec ? path.join(path.dirname(process.env.ComSpec), 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
const POWERSHELL = fs.existsSync(PS) ? PS : 'powershell.exe';
const TTS_DIR = AIOS_DATA_DIR;
// Prefer a deeper male en voice for the Jarvis feel; override with JARVIS_VOICE.
const TTS_VOICE = (process.env.JARVIS_VOICE || 'Microsoft David Desktop').trim();
const TTS_RATE = Number.isFinite(Number(process.env.JARVIS_VOICE_RATE)) ? Number(process.env.JARVIS_VOICE_RATE) : 0;

// ElevenLabs cloud voice. Keep the key server-side only; the browser still calls
// /api/jarvis/tts and never sees secrets. If ElevenLabs is not configured or a
// request fails, Jarvis falls back to the local Windows voice instead of going mute.
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || '').trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '').trim();
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2').trim();
const ELEVENLABS_OUTPUT_FORMAT = (process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128').trim();
const ELEVENLABS_TIMEOUT = Math.max(5000, Math.min(60000, Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000));
const ELEVENLABS_ENABLED = !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);
const TTS_PROVIDER = ELEVENLABS_ENABLED ? 'elevenlabs' : 'local';
const TTS_CONTENT_TYPE = ELEVENLABS_ENABLED && ELEVENLABS_OUTPUT_FORMAT.startsWith('mp3') ? 'audio/mpeg' : 'audio/wav';
const ELEVENLABS_VOICE_SETTINGS = {
  stability: Number.isFinite(Number(process.env.ELEVENLABS_STABILITY)) ? Number(process.env.ELEVENLABS_STABILITY) : 0.48,
  similarity_boost: Number.isFinite(Number(process.env.ELEVENLABS_SIMILARITY_BOOST)) ? Number(process.env.ELEVENLABS_SIMILARITY_BOOST) : 0.78,
  style: Number.isFinite(Number(process.env.ELEVENLABS_STYLE)) ? Number(process.env.ELEVENLABS_STYLE) : 0.18,
  use_speaker_boost: String(process.env.ELEVENLABS_SPEAKER_BOOST || 'true').toLowerCase() !== 'false',
  speed: Number.isFinite(Number(process.env.ELEVENLABS_SPEED)) ? Number(process.env.ELEVENLABS_SPEED) : 0.96,
};
let ttsSeq = 0;

const LIST_VOICES_PS = 'Add-Type -AssemblyName System.Speech; ' +
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Gender + "|" + $_.VoiceInfo.Culture }; $s.Dispose()';

// If the preferred voice fails mid-synthesis (e.g. an adapter "Online" voice
// with no internet), retry the same text with the built-in offline David so a
// dead network degrades the voice instead of silencing Jarvis.
const SYNTH_PS = 'Add-Type -AssemblyName System.Speech; ' +
  '$t = [Console]::In.ReadToEnd(); ' +
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  'try { $s.SelectVoice($env:JV_VOICE) } catch {}; ' +
  'try { $s.Rate = [int]$env:JV_RATE } catch {}; ' +
  '$s.SetOutputToWaveFile($env:JV_OUT); ' +
  'try { $s.Speak($t) } catch { ' +
  '$s.Dispose(); ' +
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  'try { $s.SelectVoice("Microsoft David Desktop") } catch {}; ' +
  'try { $s.Rate = [int]$env:JV_RATE } catch {}; ' +
  '$s.SetOutputToWaveFile($env:JV_OUT); ' +
  '$s.Speak($t) }; ' +
  '$s.Dispose()';

// Persistent TTS worker — one PowerShell stays alive with the synthesizer
// loaded, taking jobs as `id|outPathB64|textB64` lines and answering `DONE id`.
// Saves the ~0.5-1s process spawn + assembly load on EVERY sentence, which is
// most of the per-sentence voice latency. Falls back to one-shot spawns if the
// worker dies. Voice preference retried per job; David fallback per job.
const TTSD_PS = 'Add-Type -AssemblyName System.Speech; ' +
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  'try { $s.Rate = [int]$env:JV_RATE } catch {}; ' +
  'while ($true) { ' +
  '$line = [Console]::In.ReadLine(); ' +
  'if ($null -eq $line) { break }; ' +
  '$p = $line.Split("|", 3); if ($p.Count -lt 3) { continue }; ' +
  '$id = $p[0]; ' +
  '$out = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])); ' +
  '$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])); ' +
  'try { ' +
  'try { $s.SelectVoice($env:JV_VOICE) } catch {}; ' +
  '$s.SetOutputToWaveFile($out); ' +
  'try { $s.Speak($txt) } catch { ' +
  '$s.Dispose(); $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  'try { $s.Rate = [int]$env:JV_RATE } catch {}; ' +
  'try { $s.SelectVoice("Microsoft David Desktop") } catch {}; ' +
  '$s.SetOutputToWaveFile($out); $s.Speak($txt) }; ' +
  '$s.SetOutputToNull(); ' +
  '[Console]::Out.WriteLine("DONE " + $id) ' +
  '} catch { try { $s.SetOutputToNull() } catch {}; [Console]::Out.WriteLine("FAIL " + $id) } ' +
  '}';

let ttsd = null; // { proc, pending: Map(id -> {resolve, reject, outPath, timer}), seq, buf }

function ttsWorker() {
  if (ttsd && !ttsd.dead) return ttsd;
  let proc;
  try {
    proc = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', TTSD_PS], {
      windowsHide: true,
      env: { ...process.env, JV_VOICE: TTS_VOICE, JV_RATE: String(TTS_RATE) },
    });
  } catch { return null; }
  const w = { proc, pending: new Map(), seq: 0, buf: '', dead: false };
  const die = () => {
    w.dead = true;
    for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new Error('tts worker died')); }
    w.pending.clear();
  };
  proc.stdout.on('data', (d) => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, nl).trim(); w.buf = w.buf.slice(nl + 1);
      const m = /^(DONE|FAIL) (\S+)/.exec(line);
      if (!m) continue;
      const p = w.pending.get(m[2]);
      if (!p) continue;
      w.pending.delete(m[2]);
      clearTimeout(p.timer);
      if (m[1] === 'FAIL') { p.reject(new Error('tts synth failed')); continue; }
      fsp.readFile(p.outPath)
        .then((buf) => { fsp.unlink(p.outPath).catch(() => {}); buf && buf.length ? p.resolve(buf) : p.reject(new Error('empty wav')); })
        .catch((e) => p.reject(e));
    }
  });
  proc.stderr.on('data', () => { /* drain */ });
  proc.on('close', die);
  proc.on('error', die);
  ttsd = w;
  return w;
}
// warm the worker at boot so the first sentence doesn't pay the spawn
setTimeout(() => { try { ttsWorker(); } catch { /* best effort */ } }, 1500);

// List installed SAPI voices — [{ name, gender, culture }]. Empty on any failure.
function listVoices() {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try { proc = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', LIST_VOICES_PS], { windowsHide: true }); }
    catch { return resolve([]); }
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const voices = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, gender, culture] = l.split('|');
        return { name, gender, culture };
      });
      resolve(voices);
    });
  });
}

// Synthesize `text` to audio. ElevenLabs is preferred when configured; local
// System.Speech remains the safety net so Jarvis never loses his voice.
async function synthesizeAudio(text, opts = {}) {
  const say = String(text || '').slice(0, 4000).trim();
  if (!say) throw new Error('empty text');
  if (ELEVENLABS_ENABLED && opts.provider !== 'local') {
    try {
      const buffer = await synthesizeElevenLabs(say);
      return { buffer, contentType: TTS_CONTENT_TYPE, provider: 'elevenlabs' };
    } catch (e) {
      console.error('[jarvis] ElevenLabs TTS failed; falling back local:', (e && e.message) || e);
    }
  }
  return { buffer: await synthesizeLocal(say, opts), contentType: 'audio/wav', provider: 'local' };
}

// Back-compat helper for cached acks/fillers and older call sites.
async function synthesize(text, opts = {}) {
  const audio = await synthesizeAudio(text, opts);
  return audio.buffer;
}

async function synthesizeLocal(say, opts = {}) {
  if (!opts.voice || opts.voice === TTS_VOICE) {
    const w = ttsWorker();
    if (w && !w.dead) {
      try { return await synthesizeViaWorker(w, say); }
      catch { /* worker flaked - one-shot below */ }
    }
  }
  return synthesizeOneShot(say, opts);
}

async function synthesizeElevenLabs(say) {
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(ELEVENLABS_VOICE_ID) +
    '/stream?output_format=' + encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ELEVENLABS_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
      body: JSON.stringify({ text: say, model_id: ELEVENLABS_MODEL_ID, voice_settings: ELEVENLABS_VOICE_SETTINGS }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error('elevenlabs ' + res.status + (err ? ': ' + err.slice(0, 240) : ''));
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function listElevenLabsVoices() {
  if (!ELEVENLABS_API_KEY) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://api.elevenlabs.io/v2/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('elevenlabs voices ' + res.status);
    const j = await res.json();
    return (Array.isArray(j.voices) ? j.voices : []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels || {},
      description: v.description || '',
      previewUrl: v.preview_url || '',
    }));
  } finally {
    clearTimeout(timer);
  }
}
function synthesizeViaWorker(w, say) {
  return new Promise((resolve, reject) => {
    const id = 't' + (w.seq++);
    const outPath = path.join(TTS_DIR, `jv_ttsd_${process.pid}_${id}.wav`);
    const timer = setTimeout(() => {
      w.pending.delete(id);
      try { w.proc.kill(); } catch { /* ignore */ }
      w.dead = true;
      reject(new Error('tts worker timeout'));
    }, 30 * 1000);
    w.pending.set(id, { resolve, reject, outPath, timer });
    const line = id + '|' + Buffer.from(outPath, 'utf8').toString('base64') + '|' + Buffer.from(say, 'utf8').toString('base64') + '\n';
    try { w.proc.stdin.write(line); }
    catch (e) { clearTimeout(timer); w.pending.delete(id); w.dead = true; reject(e); }
  });
}

// One-shot spawn path (original) — slower but self-contained.
async function synthesizeOneShot(say, opts = {}) {
  const voice = String(opts.voice || TTS_VOICE).replace(/[^\w .()-]/g, '').slice(0, 80) || TTS_VOICE;
  const rate = Math.max(-10, Math.min(10, Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : TTS_RATE));
  const outPath = path.join(TTS_DIR, `jv_tts_${process.pid}_${ttsSeq++}.wav`);

  return new Promise((resolve, reject) => {
    let proc, errOut = '';
    const env = { ...process.env, JV_VOICE: voice, JV_RATE: String(rate), JV_OUT: outPath };
    try { proc = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SYNTH_PS], { windowsHide: true, env }); }
    catch (e) { return reject(new Error('tts spawn failed: ' + String((e && e.message) || e))); }

    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 30 * 1000);
    proc.stderr.on('data', (d) => { if (errOut.length < 4096) errOut += d.toString('utf8'); });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(String((e && e.message) || e))); });
    proc.on('close', async (code) => {
      clearTimeout(timer);
      try {
        const buf = await fsp.readFile(outPath);
        fsp.unlink(outPath).catch(() => {});
        if (code === 0 && buf && buf.length) return resolve(buf);
        reject(new Error(errOut.trim().slice(0, 300) || 'tts produced no audio (code ' + code + ')'));
      } catch (e) {
        reject(new Error(errOut.trim().slice(0, 300) || 'tts read failed: ' + String((e && e.message) || e)));
      }
    });

    try { proc.stdin.write(say); proc.stdin.end(); }
    catch (e) { clearTimeout(timer); reject(new Error('tts stdin failed: ' + String((e && e.message) || e))); }
  });
}

// ---------------------------------------------------------------------------
// Wake acknowledgments — 3 canned lines (Yish-approved 2026-07-06) spoken ~1s
// after "Hey Jarvis". Pre-synthesized ONCE through Andrew and cached to disk,
// so playback is instant — no thinking, no synth wait. Regenerate by deleting
// the WAVs in ~/.aios/jarvis-acks.
// ---------------------------------------------------------------------------
const ACK_LINES = [
  'All systems green. Talk to me.',
  'Boot sequence complete. Awaiting instructions.',
  'Voice recognition confirmed. How can I assist?',
];
// thinking fillers — played if the brain hasn't produced audio ~1.3s after a
// voice question, so the silence never feels dead
const FILLER_LINES = ['On it.', 'One moment.', 'Checking.', 'Working on it.'];
const ACK_DIR = path.join(AIOS_DATA_DIR, 'jarvis-acks');

function ackPath(i) { return path.join(ACK_DIR, 'ack-' + i + '.wav'); }
function fillerPath(i) { return path.join(ACK_DIR, 'filler-' + i + '.wav'); }

async function ensureCanned(lines, pather, label) {
  for (let i = 0; i < lines.length; i++) {
    try {
      await fsp.access(pather(i));
    } catch {
      try {
        const wav = await synthesize(lines[i], { provider: 'local' });
        await fsp.writeFile(pather(i), wav);
        console.log('[jarvis] ' + label + ' cached:', lines[i]);
      } catch (e) {
        console.error('[jarvis] ' + label + ' synth failed (will retry next boot):', (e && e.message) || e);
      }
    }
  }
}
async function ensureAcks() {
  try { await fsp.mkdir(ACK_DIR, { recursive: true }); } catch { /* exists */ }
  await ensureCanned(ACK_LINES, ackPath, 'ack');
  await ensureCanned(FILLER_LINES, fillerPath, 'filler');
}
// after the TTS worker has warmed
setTimeout(() => { ensureAcks().catch(() => {}); }, 5000);

// ---------------------------------------------------------------------------
// Fast lane — the latency fix. Simple conversational turns go to a small local
// model (Ollama, already on this machine) that streams its first words in well
// under a second. Anything that smells like it needs tools/vault/actions is
// routed to the deep lane (warm claude session), and the fast model can also
// bail itself out by replying exactly "DEEP". The fast lane has NO tools and
// only sees the last few exchanges + a compact persona.
// ---------------------------------------------------------------------------
const FAST_URL = (process.env.JARVIS_FAST_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// Strongest installed local model. Keep the context small so short voice turns
// do not pay a huge prompt-processing cost.
const FAST_MODEL = (process.env.JARVIS_FAST_MODEL || 'gemma4:latest').trim();
const FAST_PERSONA = 'You are JARVIS, Yish\'s voice assistant (he is a high school junior in Newton MA who runs YDdetailers, a mobile car detailing business). Your replies are read ALOUD: 1-2 short sentences, plain spoken English, no markdown, no emoji, dry and sharp. You can use local AIOS tools for time, health, voice status, Ollama models, goals, todos, portfolio, metrics, pipeline, CRM logging/summary, Nextdoor/local demand, vault notes, freshness/brief status, safe local files, opening local paths/apps, and non-destructive PowerShell. If he asks for Gmail, calendar, email sending, public posting, purchases, deletes, weather/news, or anything outside the local tools, reply with exactly: DEEP';
const DEEP_RE = /(calendar|schedule|event|email|gmail|inbox|crm|booking|book|client|customer|revenue|profit|expense|money|made|earn|lead|nextdoor|instagram|ad(s|vert)|file|folder|desktop|vault|note|memory|remember|remind|log |mark |open |run |launch|execute|create|write|edit|delete|send|draft|post|search|look up|weather|news|brief|due|homework|assignment|essay|apush|stats)/i;
function needsDeep(msg) {
  const s = String(msg || '');
  if (isLocalToolMessage(s)) return false;
  return DEEP_RE.test(s);
}

// rolling context so the deep lane knows what the fast lane just said
const fastTurns = [];
function rememberFastTurn(q, a) { fastTurns.push({ q, a }); while (fastTurns.length > 3) fastTurns.shift(); }
function fastContextPrefix() {
  if (!fastTurns.length) return '';
  return 'Quick-chat context from a moment ago: ' + fastTurns.map((t) => `Yish: ${t.q} / You: ${t.a}`).join(' | ') + '\n\n';
}

const FAST_OPTIONS = { num_ctx: 4096, num_predict: 120, temperature: 0.6 };

function ollamaChatJson(messages, tools, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(FAST_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: FAST_MODEL,
      messages,
      tools,
      stream: false,
      keep_alive: '24h',
      think: false,
      options: { ...FAST_OPTIONS, num_predict: 180 },
    }),
    signal: ctrl.signal,
  }).then(async (res) => {
    clearTimeout(killer);
    if (!res.ok) throw new Error('ollama ' + res.status);
    return res.json();
  }).catch((e) => { clearTimeout(killer); throw e; });
}

function streamOllamaMessages(messages, onDelta) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 30000);
    fetch(FAST_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FAST_MODEL, messages, stream: true, keep_alive: '24h', think: false, options: FAST_OPTIONS }),
      signal: ctrl.signal,
    }).then(async (res) => {
      if (!res.ok || !res.body) throw new Error('ollama ' + res.status);
      let full = '', buf = '', gate = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          const t = ev.message && ev.message.content;
          if (t) {
            full += t;
            if (gate) {
              const head = full.trimStart();
              if ('DEEP'.startsWith(head.slice(0, 4).toUpperCase()) && head.length < 6) continue;
              if (/^DEEP\b/i.test(head)) continue;
              gate = false;
              if (onDelta) { try { onDelta(full); } catch { /* ignore */ } }
            } else if (onDelta) { try { onDelta(t); } catch { /* ignore */ } }
          }
          if (ev.done) {
            clearTimeout(killer);
            const reply = full.trim();
            return resolve({ reply: /^DEEP\b/i.test(reply) ? 'DEEP' : (reply || 'DEEP') });
          }
        }
      }
      clearTimeout(killer);
      const reply = full.trim();
      resolve({ reply: /^DEEP\b/i.test(reply) ? 'DEEP' : (reply || 'DEEP') });
    }).catch((e) => { clearTimeout(killer); reject(e); });
  });
}

async function jarvisChatFastTools(messages, onDelta, originalMessage) {
  const msgs = messages.map((m, i) => i === 0
    ? { role: 'system', content: m.content + ' ' + LOCAL_TOOL_SYSTEM_PROMPT }
    : m);
  for (let round = 0; round < 3; round++) {
    const ev = await ollamaChatJson(msgs, localToolsForMessage(originalMessage), 45000);
    const assistantMsg = ev && ev.message ? ev.message : {};
    const calls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];
    const content = String(assistantMsg.content || '').trim();
    if (!calls.length) {
      const reply = /^DEEP\b/i.test(content) ? 'DEEP' : (content || 'DEEP');
      if (reply !== 'DEEP' && onDelta) { try { onDelta(reply); } catch { /* ignore */ } }
      return { reply };
    }
    msgs.push({ role: 'assistant', content: assistantMsg.content || '', tool_calls: calls });
    for (const call of calls.slice(0, 4)) {
      msgs.push(await executeLocalToolCall(call));
    }
  }
  return streamOllamaMessages(msgs, onDelta);
}
// One fast turn. Resolves { reply } (reply === 'DEEP' means escalate), rejects
// if Ollama is down/slow so the caller can fall through to the deep lane.
function jarvisChatFast(message, history, onDelta) {
  const msgs = [{ role: 'system', content: FAST_PERSONA }];
  for (const t of (Array.isArray(history) ? history.slice(-6) : [])) {
    msgs.push({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '').slice(0, 600) });
  }
  msgs.push({ role: 'user', content: String(message || '').slice(0, 2000) });

  if (isLocalToolMessage(message)) {
    return tryDirectLocalTool(message).then((direct) => {
      if (direct && direct.reply) {
        if (onDelta) { try { onDelta(direct.reply); } catch { /* ignore */ } }
        return direct;
      }
      return jarvisChatFastTools(msgs, onDelta, message);
    });
  }
  return streamOllamaMessages(msgs, onDelta);
}
module.exports = { jarvisChat, jarvisChatStream, jarvisChatWarm, jarvisChatFast, jarvisGreet, needsDeep, rememberFastTurn, fastContextPrefix, synthesize, synthesizeAudio, listVoices, listElevenLabsVoices, TTS_VOICE, TTS_PROVIDER, TTS_CONTENT_TYPE, ELEVENLABS_ENABLED, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, ACK_LINES, ackPath, FILLER_LINES, fillerPath };
