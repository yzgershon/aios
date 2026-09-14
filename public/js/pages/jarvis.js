'use strict';
/*
 * AIOS page: Jarvis voice assistant.
 * JarvisVoice owns the physical microphone and offline Whisper capture; this
 * page coordinates wake/listen/think/speak state, streams the Codex brain, and
 * plays server-side ElevenLabs or local fallback speech.
 *
 * State machine drives the orb: idle -> listening -> thinking -> speaking -> idle.
 */
(() => {
  const { esc } = AIOS.util;
  const $ = (id) => document.getElementById(id);

  const history = [];        // [{ role:'user'|'assistant', content }]
  let state = 'idle';        // idle | listening | thinking | speaking
  let raf = null;
  let visible = false;
  let ttsVoice = null;

  // -------------------------------------------------------------- scoped styles
  const CSS = `
  #page-jarvis{position:relative;overflow:hidden}
  .jv-wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,420px);gap:22px;height:100%;min-height:0}
  @media(max-width:900px){.jv-wrap{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}}
  .jv-stage{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;min-height:0}
  .jv-orb{position:relative;width:min(58vh,420px);aspect-ratio:1;display:grid;place-items:center}
  .jv-orb canvas{position:absolute;inset:0;width:100%;height:100%}
  .jv-orb .jv-core-label{position:relative;font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:13px;letter-spacing:.42em;color:var(--accent,#64d2ff);text-shadow:0 0 18px var(--accent,#64d2ff);opacity:.9;padding-left:.42em}
  .jv-status{font-family:var(--font-mono,monospace);font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted,#7a8aa6);min-height:16px}
  .jv-status.on{color:var(--accent,#64d2ff)}
  .jv-badges{display:flex;gap:16px;align-items:center}
  .jv-voice{font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#5a6a86);opacity:.75;display:flex;align-items:center;gap:6px}
  .jv-voice::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--muted,#5a6a86)}
  .jv-voice.local::before{background:#3ddc84;box-shadow:0 0 6px #3ddc84}
  .jv-voice.browser::before{background:#ffb454;box-shadow:0 0 6px #ffb454}
  .jv-controls{display:flex;align-items:center;gap:14px}
  .jv-mic{width:64px;height:64px;border-radius:50%;border:1px solid var(--line,#22314d);background:radial-gradient(circle at 50% 35%,rgba(100,210,255,.18),rgba(10,20,40,.6));color:var(--accent,#64d2ff);cursor:pointer;display:grid;place-items:center;transition:all .2s;box-shadow:0 0 0 0 rgba(100,210,255,.4)}
  .jv-mic:hover{border-color:var(--accent,#64d2ff);transform:translateY(-1px)}
  .jv-mic.live{background:radial-gradient(circle at 50% 35%,rgba(255,90,110,.35),rgba(40,10,20,.6));color:#ff8a9b;border-color:#ff5a6e;animation:jvpulse 1.4s ease-in-out infinite}
  @keyframes jvpulse{0%,100%{box-shadow:0 0 0 0 rgba(255,90,110,.45)}50%{box-shadow:0 0 0 12px rgba(255,90,110,0)}}
  .jv-mic svg{width:26px;height:26px}
  .jv-conv{width:44px;height:44px;border-radius:50%;border:1px solid var(--line,#22314d);background:rgba(10,20,40,.6);color:var(--muted,#7a8aa6);cursor:pointer;display:grid;place-items:center;transition:all .2s}
  .jv-conv svg{width:20px;height:20px}
  .jv-conv.on{color:#3ddc84;border-color:rgba(61,220,132,.55);box-shadow:0 0 10px rgba(61,220,132,.25)}
  .jv-conv:hover{transform:translateY(-1px)}
  .jv-hint{font-size:12px;color:var(--muted,#7a8aa6);max-width:260px;text-align:center;line-height:1.4}
  .jv-side{display:flex;flex-direction:column;min-height:0;background:var(--panel,rgba(12,20,36,.5));border:1px solid var(--line,#22314d);border-radius:16px;overflow:hidden}
  .jv-side-head{padding:12px 16px;border-bottom:1px solid var(--line,#22314d);display:flex;align-items:center;justify-content:space-between}
  .jv-side-head b{font-size:13px;letter-spacing:.06em}
  .jv-clear{background:none;border:none;color:var(--muted,#7a8aa6);font-size:12px;cursor:pointer}
  .jv-clear:hover{color:var(--accent,#64d2ff)}
  .jv-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
  .jv-msg{max-width:88%;padding:9px 13px;border-radius:13px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
  .jv-msg.user{align-self:flex-end;background:rgba(100,210,255,.14);border:1px solid rgba(100,210,255,.28);color:var(--text,#e8eefc)}
  .jv-msg.jarvis{align-self:flex-start;background:rgba(14,22,40,.8);border:1px solid var(--line,#22314d);color:var(--text,#dce6fb)}
  .jv-msg.err{align-self:flex-start;background:rgba(255,80,90,.12);border:1px solid rgba(255,80,90,.35);color:#ff9aa6}
  .jv-msg.think{align-self:flex-start;color:var(--muted,#7a8aa6);font-style:italic}
  .jv-empty{margin:auto;text-align:center;color:var(--muted,#7a8aa6);font-size:13px;line-height:1.6}
  .jv-approve{align-self:stretch;background:rgba(255,180,84,.08);border:1px solid rgba(255,180,84,.4);border-radius:13px;padding:12px 14px}
  .jv-approve .ttl{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#ffb454;margin-bottom:6px;display:flex;align-items:center;gap:6px}
  .jv-approve .what{font-family:var(--font-mono,monospace);font-size:12.5px;color:var(--text,#e8eefc);white-space:pre-wrap;word-break:break-all;max-height:130px;overflow-y:auto;background:rgba(0,0,0,.25);border-radius:8px;padding:8px 10px;margin-bottom:10px}
  .jv-approve .row{display:flex;gap:8px}
  .jv-approve button{flex:1;border:none;border-radius:9px;padding:9px 0;font-weight:600;font-size:13px;cursor:pointer}
  .jv-approve .ok{background:#2ea86b;color:#04120a}
  .jv-approve .no{background:rgba(255,90,110,.2);color:#ff8a9b;border:1px solid rgba(255,90,110,.45)}
  .jv-approve.resolved{opacity:.55}
  .jv-approve.resolved .row{display:none}
  .jv-inputrow{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line,#22314d)}
  .jv-input{flex:1;background:rgba(6,12,24,.7);border:1px solid var(--line,#22314d);border-radius:10px;color:var(--text,#e8eefc);padding:10px 12px;font-size:14px;font-family:inherit;resize:none;outline:none}
  .jv-input:focus{border-color:var(--accent,#64d2ff)}
  .jv-send{background:var(--accent,#0a84ff);border:none;border-radius:10px;color:#04101f;font-weight:600;padding:0 16px;cursor:pointer;font-size:14px}
  .jv-send:disabled{opacity:.5;cursor:default}
  `;

  // -------------------------------------------------------------------- the orb
  // Concentric HUD rings drawn on canvas. Amplitude/spin ramp up per state and
  // the whole orb shifts hue: cyan idle → rose listening → amber thinking →
  // bright cyan speaking. Rotating arc segments + orbiting particles for the
  // J.A.R.V.I.S. HUD feel.
  const STATE_COLOR = { idle: [100, 210, 255], listening: [255, 90, 110], thinking: [255, 180, 84], speaking: [61, 242, 255] };
  const orbRgb = [100, 210, 255]; // lerps toward the state color each frame
  const PARTICLES = Array.from({ length: 26 }, (_, i) => ({
    a: (i / 26) * Math.PI * 2,
    r: 0.62 + (i % 5) * 0.055,
    sp: 0.12 + (i % 7) * 0.05,
    sz: 1 + (i % 3) * 0.7,
  }));
  let ctx = null, canvas = null, t0 = 0, energy = 0, energyTarget = 0;
  function drawOrb(ts) {
    if (!ctx || !canvas) return;
    if (!t0) t0 = ts;
    const time = (ts - t0) / 1000;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;

    energy += (energyTarget - energy) * 0.08;
    const tgt = STATE_COLOR[state] || STATE_COLOR.idle;
    for (let i = 0; i < 3; i++) orbRgb[i] += (tgt[i] - orbRgb[i]) * 0.06;
    const accent = 'rgb(' + Math.round(orbRgb[0]) + ',' + Math.round(orbRgb[1]) + ',' + Math.round(orbRgb[2]) + ')';
    const oc = (a) => 'rgba(' + Math.round(orbRgb[0]) + ',' + Math.round(orbRgb[1]) + ',' + Math.round(orbRgb[2]) + ',' + a + ')';
    const breathe = 1 + Math.sin(time * 1.4) * 0.02;
    const pulse = 1 + Math.sin(time * 6) * 0.03 * energy;

    // outer static ring
    ring(cx, cy, R * 0.98 * breathe, accent, 0.22, 1.5);
    // rotating dashed ring
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * (0.15 + energy * 0.6));
    ctx.beginPath();
    ctx.setLineDash([R * 0.06, R * 0.10]);
    ctx.arc(0, 0, R * 0.82, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(accent, 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    // counter-rotating tick ring
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-time * (0.2 + energy * 0.4));
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r1 = R * 0.64, r2 = R * (0.64 + (i % 4 === 0 ? 0.06 : 0.03));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.strokeStyle = withAlpha(accent, 0.28);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
    // reactive inner glow core
    const coreR = R * 0.42 * pulse;
    const g = ctx.createRadialGradient(cx, cy, coreR * 0.1, cx, cy, coreR);
    g.addColorStop(0, withAlpha(accent, 0.55 + energy * 0.35));
    g.addColorStop(0.6, withAlpha(accent, 0.12));
    g.addColorStop(1, withAlpha(accent, 0));
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    ring(cx, cy, coreR, accent, 0.6, 1.5);
    // audio-ish waveform when speaking/listening
    if (energy > 0.05) {
      ctx.beginPath();
      const segs = 90;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const noise = Math.sin(a * 6 + time * 8) * Math.sin(a * 3 - time * 5);
        const rr = R * 0.52 + noise * R * 0.05 * energy;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = withAlpha(accent, 0.5 * energy + 0.2);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // HUD arc segments — three partial arcs orbiting the core at differing speeds
    const arcs = [
      { r: 0.50, w: 2.5, span: 1.1, sp: 0.5, al: 0.55 },
      { r: 0.56, w: 1.5, span: 0.6, sp: -0.8, al: 0.4 },
      { r: 0.90, w: 2.0, span: 0.8, sp: 0.25, al: 0.35 },
    ];
    for (const A of arcs) {
      const a0 = time * (A.sp + energy * A.sp * 1.5);
      ctx.beginPath();
      ctx.arc(cx, cy, R * A.r, a0, a0 + Math.PI * A.span);
      ctx.strokeStyle = oc(A.al + energy * 0.25);
      ctx.lineWidth = A.w;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    // orbiting particles — drift faster with energy
    for (const p of PARTICLES) {
      const a = p.a + time * p.sp * (1 + energy * 2.2);
      const wob = Math.sin(time * 1.7 + p.a * 3) * 0.02;
      const px = cx + Math.cos(a) * R * (p.r + wob);
      const py = cy + Math.sin(a) * R * (p.r + wob);
      ctx.beginPath();
      ctx.arc(px, py, p.sz, 0, Math.PI * 2);
      ctx.fillStyle = oc(0.25 + 0.45 * energy * Math.abs(Math.sin(a * 2 + time)));
      ctx.fill();
    }
    raf = requestAnimationFrame(drawOrb);
  }
  function ring(cx, cy, r, color, alpha, lw) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, alpha); ctx.lineWidth = lw || 1; ctx.stroke();
  }
  function withAlpha(color, a) {
    if (color.startsWith('rgb')) { const m = color.match(/\d+/g) || [100, 210, 255]; return `rgba(${m[0]},${m[1]},${m[2]},${a})`; }
    const h = color.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ------------------------------------------------------------- state + status
  let stateChangedAt = performance.now();
  function trace(event, fields = {}) {
    const payload = { event, state, ...fields };
    try {
      fetch('/api/jarvis/telemetry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), keepalive: true,
      }).catch(() => {});
    } catch { /* diagnostics must never affect the conversation */ }
  }
  function setState(s) {
    if (state === s) return;
    const previous = state;
    const now = performance.now();
    state = s;
    trace('state', { from: previous, to: s, ms: now - stateChangedAt });
    stateChangedAt = now;
    energyTarget = (s === 'speaking') ? 1 : (s === 'listening') ? 0.7 : (s === 'thinking') ? 0.35 : 0;
    const label = { idle: 'standing by', listening: 'listening', thinking: 'thinking', speaking: 'speaking' }[s] || '';
    const el = $('jvStatus');
    if (el) { el.textContent = label; el.classList.toggle('on', s !== 'idle'); }
    AIOS.bus.emit('jarvis:state', s); // mini-orbs elsewhere (Cortex 3D) mirror this
  }

  // -------------------------------------------------------------------- the log
  function addMsg(role, text, cls) {
    const log = $('jvLog');
    if (!log) return null;
    const empty = log.querySelector('.jv-empty'); if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'jv-msg ' + (cls || (role === 'user' ? 'user' : 'jarvis'));
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  // ---------------------------------------------------------------- send a turn
  // Streaming: text deltas arrive over SSE and render live into the reply
  // bubble; complete sentences are handed to the speech queue immediately, so
  // Jarvis starts talking while the rest of the reply is still being generated.
  let inflight = false; // guards double-submits; NOT tied to orb state (the STT
                        // path parks the orb on 'thinking' before calling send)
  let turnSerial = 0;
  let turnController = null;
  function cancelTurn() {
    turnSerial++;
    if (turnController) turnController.abort();
    turnController = null;
    inflight = false;
    lastInputWasVoice = false;
    stopSpeaking();
    setSendEnabled(true);
    setState('idle');
  }
  async function send(text, opts) {
    const msg = (text || '').trim();
    if (!msg) return;
    if (inflight) cancelTurn();
    inflight = true;
    const serial = ++turnSerial;
    const controller = new AbortController();
    turnController = controller;
    let timeout;
    const armTimeout = (ms) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(new Error('JARVIS took too long to respond. Please try again.')), ms);
    };
    armTimeout(60000);
    const turnStarted = performance.now();
    let firstDeltaSeen = false;
    trace('brain.start', { mode: opts && opts.voice ? 'voice' : 'text' });
    lastInputWasVoice = !!(opts && opts.voice);
    stopSpeaking();
    moreComing = true;
    if (capturing) stopCapture(true); // typed mid-listen: drop the open mic
    // dead-air filler: if no audio has started ~1.3s in, say "On it." etc.
    let fillerTimer = null;
    if (lastInputWasVoice && fillerBlobs.length) {
      fillerTimer = setTimeout(() => {
        if (serial === turnSerial && inflight && !firstDeltaSeen && !speaking && !speechQ.length) {
          speechQ.push({ text: '', gen: qGen, wav: Promise.resolve({ blob: fillerBlobs[Math.floor(Math.random() * fillerBlobs.length)], provider: 'local' }) });
          drainSpeech();
        }
      }, 1300);
    }
    addMsg('user', msg);
    AIOS.bus.emit('jarvis:task-start', msg);
    history.push({ role: 'user', content: msg });
    setState('thinking');
    setSendEnabled(false);
    let bubble = null, shown = '', speakBuf = '';

    const takeSentences = (flushAll) => {
      // peel complete sentences off speakBuf and queue them for speech
      for (;;) {
        const m = speakBuf.match(/[.!?…]["')\]]*(\s+|$)|\n+/);
        if (!m) break;
        const cut = m.index + m[0].length;
        const prefix = speakBuf.slice(0, cut);
        if (prefix.lastIndexOf('[') > prefix.lastIndexOf(']') || /\]\([^)]*$/.test(prefix)) break;
        const sentence = speakBuf.slice(0, cut).trim();
        speakBuf = speakBuf.slice(cut);
        if (sentence) enqueueSpeech(sentence);
      }
      if (flushAll && speakBuf.trim()) { enqueueSpeech(speakBuf.trim()); speakBuf = ''; }
    };
    const onDelta = (t) => {
      if (serial !== turnSerial) return;
      if (fillerTimer) clearTimeout(fillerTimer);
      if (!firstDeltaSeen) {
        firstDeltaSeen = true;
        trace('brain.first-delta', { ttftMs: performance.now() - turnStarted });
      }
      if (!bubble) bubble = addMsg('jarvis', '');
      shown += t;
      AIOS.bus.emit('jarvis:delta', shown);
      bubble.textContent = shown;
      const log = $('jvLog'); if (log) log.scrollTop = log.scrollHeight;
      speakBuf += t;
      takeSentences(false);
    };

    try {
      const res = await fetch('/api/jarvis/chat-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: history.slice(0, -1) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('stream ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sseBuf = '', finalReply = '', streamErr = null, completed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf('\n\n')) !== -1) {
          const frame = sseBuf.slice(0, nl); sseBuf = sseBuf.slice(nl + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'delta' && ev.text) onDelta(ev.text);
          else if (ev.type === 'status') {
            armTimeout(ev.status === 'in_progress' ? 125000 : 60000);
            AIOS.bus.emit('jarvis:activity', { tool: ev.tool, event: ev.status === 'in_progress' ? 'started' : 'completed' });
          }
          else if (ev.type === 'done') { finalReply = ev.reply || ''; completed = true; }
          else if (ev.type === 'error') streamErr = ev.error || 'stream error';
        }
      }
      if (serial !== turnSerial) return;
      if (streamErr) throw new Error(streamErr);
      if (!completed) throw new Error('The connection ended before JARVIS finished. Please try again.');
      const reply = (finalReply || shown).trim();
      if (!reply) throw new Error('JARVIS returned an empty response. Please try again.');
      if (!bubble) bubble = addMsg('jarvis', '');
      bubble.textContent = reply;
      // speak whatever the sentence-splitter hasn't flushed (plus any tail the
      // final result had that deltas missed)
      if (reply.length > shown.length) speakBuf += reply.slice(shown.length);
      takeSentences(true);
      history.push({ role: 'assistant', content: reply });
      AIOS.bus.emit('jarvis:reply', { q: msg, a: reply });
      speechDone(); // signal: no more sentences coming
      trace('brain.done', { ms: performance.now() - turnStarted });
    } catch (e) {
      if (serial !== turnSerial) return;
      // A failed stream may already have executed tools. Never replay the turn.
      const error = controller.signal.aborted ? (controller.signal.reason?.message || 'Request cancelled.') : String(e?.message || e);
      lastInputWasVoice = false;
      stopSpeaking();
      trace('brain.error', { reason: error.slice(0, 80), ms: performance.now() - turnStarted });
      if (bubble) { bubble.className = 'jv-msg err'; bubble.textContent = shown + '\n\n' + error; }
      else addMsg('jarvis', error, 'err');
      AIOS.bus.emit('jarvis:error', error);
      setState('idle');
    } finally {
      clearTimeout(timeout);
      if (fillerTimer) clearTimeout(fillerTimer);
      if (serial === turnSerial) {
        turnController = null;
        inflight = false;
        setSendEnabled(true);
        if (!speaking && !speechQ.length && !moreComing) maybeFollowUp();
      }
    }
  }

  // ------------------------------------------------------------- speech queue
  // Sentences stream in during generation; each one's WAV is fetched the moment
  // it's queued (so synthesis overlaps playback), but playback stays strictly
  // in order. `speechDone()` tells the worker no more sentences are coming, so
  // it can drop the orb back to idle after the last one.
  const speechQ = [];
  let speaking = false;
  let moreComing = false;
  let qGen = 0; // bumped by stopSpeaking() to cancel a superseded queue
  const ttsRequests = new Set();
  let cancelPlayback = null;

  function fetchTtsBlob(text) {
    const started = performance.now();
    const controller = new AbortController();
    ttsRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    return fetch('/api/jarvis/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      signal: controller.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error('tts ' + r.status);
      const provider = r.headers.get('X-Jarvis-TTS-Provider') || 'local';
      const blob = await r.blob();
      trace('tts.ready', { provider, ttsMs: performance.now() - started });
      return { blob, provider };
    }).finally(() => { clearTimeout(timer); ttsRequests.delete(controller); });
  }

  function enqueueSpeech(text) {
    text = String(text || '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '').replace(/[^]*/g, '')
      .replace(/(^|\n)\s*#{1,6}\s*/g, '$1').replace(/[*`]/g, '').trim();
    if (!text) return;
    moreComing = true;
    const item = { text, gen: qGen, wav: fetchTtsBlob(text).catch(() => null) };
    speechQ.push(item);
    if (!speaking) drainSpeech();
  }
  function speechDone() {
    moreComing = false;
    if (!speaking && !speechQ.length) setState('idle');
  }

  async function drainSpeech() {
    speaking = true;
    while (speechQ.length) {
      const item = speechQ.shift();
      if (item.gen !== qGen) continue; // superseded by stopSpeaking
      const audio = await item.wav;
      if (item.gen !== qGen) continue;
      if (audio && audio.blob) {
        localTtsOk = true;
        setVoiceBadge(audio.provider === 'elevenlabs' ? 'elevenlabs' : 'local');
        await playBlob(audio.blob, item.gen);
      } else {
        localTtsOk = null;
        await browserSpeakAsync(item.text);
      }
    }
    speaking = false;
    if (!moreComing && !inflight && !capturing) {
      setState('idle');
      // conversation loop: the barge-in monitor (if still open) becomes the
      // follow-up window; otherwise open a fresh one
      maybeFollowUp();
    } else if (inflight && !capturing) {
      setState('thinking');
    }
  }

  function setWakeSuppressed(active) {
    fetch('/api/jarvis/wake-suppress?ms=' + (active ? 120000 : 150), { method: 'POST' }).catch(() => {});
  }

  function playBlob(blob, gen) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let finished = false;
      let watch = null;
      currentAudio = audio;
      setWakeSuppressed(true);
      setState('speaking');
      const fin = () => {
        if (finished) return;
        finished = true;
        if (watch) clearInterval(watch);
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        if (cancelPlayback === fin) cancelPlayback = null;
        setWakeSuppressed(false);
        resolve();
      };
      audio.onended = fin;
      audio.onerror = fin;
      cancelPlayback = fin;
      audio.play().catch(fin);
      watch = setInterval(() => {
        if (gen !== qGen) { try { audio.pause(); } catch { /* ignore */ } fin(); }
        else if (audio.ended) fin();
      }, 250);
    });
  }

  function browserSpeakAsync(text) {
    return new Promise((resolve) => {
      if (!text || !window.speechSynthesis) return resolve();
      if (!ttsVoice) ttsVoice = pickVoice();
      const u = new SpeechSynthesisUtterance(text);
      if (ttsVoice) u.voice = ttsVoice;
      u.rate = 1.0; u.pitch = 0.9;
      u.onstart = () => { setWakeSuppressed(true); setState('speaking'); };
      const timer = setTimeout(() => { speechSynthesis.cancel(); finish(); }, 30000);
      const finish = () => { clearTimeout(timer); if (cancelPlayback === finish) cancelPlayback = null; setWakeSuppressed(false); resolve(); };
      cancelPlayback = finish;
      u.onend = finish;
      u.onerror = finish;
      setVoiceBadge('browser');
      speechSynthesis.speak(u);
    });
  }

  // ---------------------------------------------------------------------- speak
  // Prefer the offline local voice (POST /api/jarvis/tts → WAV). If that endpoint
  // is unavailable, fall back to the browser's speechSynthesis so voice never
  // fully breaks. `localTtsOk` remembers the outcome to avoid retrying a dead
  // service every turn.
  let currentAudio = null;
  let localTtsOk = null; // server TTS status hint only; never disables future server attempts

  async function speak(text) {
    stopSpeaking();
    enqueueSpeech(text);
    speechDone();
  }

  function pickVoice() {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    if (!voices.length) return null;
    const pref = [/Guy/i, /UK English Male/i, /Daniel/i, /George/i, /Arthur/i, /Ryan/i];
    for (const re of pref) { const v = voices.find((x) => re.test(x.name) && /en/i.test(x.lang)); if (v) return v; }
    return voices.find((x) => /en-GB/i.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang)) || voices[0];
  }

  function stopSpeaking() {
    qGen++; // invalidate anything queued or mid-playback
    speechQ.length = 0;
    moreComing = false;
    for (const controller of ttsRequests) controller.abort();
    ttsRequests.clear();
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* ignore */ }
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } currentAudio = null; }
    if (cancelPlayback) cancelPlayback();
    if (wakeAckCancel) wakeAckCancel();
    setWakeSuppressed(false);
  }

  function setVoiceBadge(kind) {
    const el = $('jvVoice');
    if (!el) return;
    el.textContent = kind === 'elevenlabs' ? 'elevenlabs voice' : kind === 'local' ? 'jarvis voice' : 'browser voice';
    el.className = 'jv-voice ' + (kind === 'elevenlabs' ? 'local' : kind);
  }

  // ------------------------------------------------------------------- listen
  // JarvisVoice owns the NAudio stream and returns one transcript per coordinated
  // listen request. If JarvisVoice is unavailable, fail closed while the app supervisor restarts it.
  let sttMode = 'browser';
  let capturing = false;
  let captureController = null;
  let captureSerial = 0;
  let captureCancelPending = Promise.resolve();
  let lastInputWasVoice = false;
  let convMode = true;       // Phase 6: hands-free conversation loop
  try { convMode = localStorage.getItem('jarvis.conv') !== '0'; } catch { /* default on */ }
  let isFollowup = false;        // auto-opened window (stricter, ends conv on empty)
  // Whisper invents these on silence/noise — never treat them as real turns
  const HALLUCINATIONS = /^(thank you|thanks|thank you for watching|thanks for watching|you|bye|\.|uh|um|okay|so|the)[.!?\s]*$/i;

  async function probeStt() {
    let status = null;
    for (let attempt = 0; attempt < 3 && !status; attempt++) {
      try {
        const candidate = await AIOS.api.get('/api/jarvis/voice-status');
        if (candidate && candidate.stt) status = candidate;
      } catch { /* retry below */ }
      if (!status && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    sttMode = status ? 'offline' : 'unavailable';
    trace('stt.probe', { mode: sttMode, ms: status && status.latencyMs });
    const badge = $('jvStt'); if (badge) { badge.textContent = sttMode === 'offline' ? 'offline hearing' : 'hearing offline'; badge.className = 'jv-voice ' + (sttMode === 'offline' ? 'local' : 'browser'); }
  }

  // Conversation loop: when a spoken reply finishes and conv mode is on, the
  // mic re-opens for a follow-up. Say nothing for 8s and it closes by itself.
  function maybeFollowUp() {
    if (!convMode || !lastInputWasVoice || sttMode !== 'offline' || capturing || inflight) return;
    startCapture({ followup: true }).catch(() => { /* mic denied — silent */ });
  }

  // Voice yes/no for approval cards: a short affirmative/negative while a card
  // is pending answers the newest card instead of becoming a chat message.
  function tryVoiceApproval(text) {
    if (!approvalCards.size) return false;
    const t = text.toLowerCase().replace(/[.!,?]/g, '').trim();
    const yes = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|approve|approved|confirm|run it|send it)( please)?( jarvis)?$/.test(t);
    const no = /^(no|nope|deny|denied|stop|cancel|negative|don'?t)( jarvis)?$/.test(t);
    if (!yes && !no) return false;
    const id = [...approvalCards.keys()].pop();
    AIOS.api.post('/api/jarvis/approval-response', { id, allow: yes }).catch(() => { /* raced timeout */ });
    markResolved(id, yes);
    return true;
  }

  // Normal voice turns use JarvisVoice's already-open NAudio stream. The
  // browser never opens the microphone, which removes the Windows device race.
  async function startCapture(opts = {}) {
    await captureCancelPending;
    if (capturing) return;

    const serial = ++captureSerial;
    const followup = !!opts.followup;
    const retry = !!opts.retry;
    isFollowup = followup;
    capturing = true;
    captureController = new AbortController();
    const started = performance.now();
    const mic = $('jvMic'); if (mic) mic.classList.add('live');
    setState('listening');
    trace('listen.client-start', { mode: followup ? 'followup' : 'normal' });

    try {
      const res = await fetch('/api/jarvis/listen-stream?followup=' + (followup ? '1' : '0'), {
        method: 'POST', signal: captureController.signal,
      });
      let result = null;
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let ndjson = '';
        const handleLine = (line) => {
          if (!line.trim()) return;
          let event; try { event = JSON.parse(line); } catch { return; }
          if (event.type === 'speech-ended') {
            if (mic) mic.classList.remove('live');
            setState('thinking');
            trace('listen.speech-ended', {
              mode: followup ? 'followup' : 'normal', reason: event.reason,
              captureMs: event.captureMs, ms: event.endpointMs,
            });
          } else if (event.type === 'transcript' || event.type === 'done' || event.type === 'error') {
            result = event;
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          ndjson += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = ndjson.indexOf('\n')) !== -1) {
            handleLine(ndjson.slice(0, newline));
            ndjson = ndjson.slice(newline + 1);
          }
        }
        ndjson += decoder.decode();
        handleLine(ndjson);
      } else {
        result = await res.json().catch(() => null);
      }
      if (serial !== captureSerial) return;

      capturing = false;
      captureController = null;
      if (mic) mic.classList.remove('live');
      trace('listen.client-done', {
        mode: followup ? 'followup' : 'normal', reason: result && result.reason,
        ms: performance.now() - started, captureMs: result && result.captureMs, sttMs: result && result.sttMs,
      });

      if (!result) throw new Error('voice service returned no result');
      if (!res.ok || result.type === 'error') throw new Error(result.error || result.reason || ('listen ' + res.status));
      const text = String(result.text || '').trim();
      if (!text || HALLUCINATIONS.test(text)) {
        trace('listen.empty', { mode: followup ? 'followup' : 'normal', reason: result.reason, retry });
        if (!followup) {
          addMsg('jarvis', text ? 'I heard something, but couldn\'t make it out. Try once more.' : 'I didn\'t hear that. Go ahead once more.', 'think');
        }
        setState('idle');
        if (!followup && !retry) {
          setTimeout(() => startCapture({ retry: true }).catch(() => setState('idle')), 300);
        }
        return;
      }
      if (/^(hey |hi |yo )?jarvis[.!,?\s]*$/i.test(text)) {
        setState('idle');
        setTimeout(() => startCapture().catch(() => setState('idle')), 120);
        return;
      }
      if (tryVoiceApproval(text)) { setState('idle'); return; }
      send(text, { voice: true });
    } catch (e) {
      if (serial !== captureSerial) return;
      capturing = false;
      captureController = null;
      if (mic) mic.classList.remove('live');
      if (e && e.name === 'AbortError') { setState('idle'); return; }
      trace('listen.client-error', { reason: String((e && e.message) || e).slice(0, 80), ms: performance.now() - started });
      addMsg('jarvis', 'Voice engine unavailable: ' + String((e && e.message) || e), 'err');
      setState('idle');
    }
  }

  function stopCapture(discard = true) {
    if (!capturing) return;
    captureSerial++;
    capturing = false;
    const controller = captureController;
    captureController = null;
    try { if (controller) controller.abort(); } catch { /* already closed */ }
    const mic = $('jvMic'); if (mic) mic.classList.remove('live');
    captureCancelPending = fetch('/api/jarvis/listen/cancel', { method: 'POST' }).catch(() => null);
    trace('listen.client-cancel', { reason: discard ? 'discard' : 'manual' });
    if (state === 'listening') setState('idle');
  }

  async function toggleMic() {
    if (capturing) { stopCapture(); return; }
    if (inflight) cancelTurn();
    if (sttMode !== 'offline') await probeStt();
    if (sttMode !== 'offline') {
      addMsg('jarvis', 'JarvisVoice is restarting. Try the mic again in a moment.', 'err');
      setState('idle');
      return;
    }
    stopSpeaking();
    startCapture().catch((e) => { addMsg('jarvis', 'Mic error: ' + String((e && e.message) || e), 'err'); setState('idle'); });
  }

  function setSendEnabled(on) { const b = $('jvSend'); if (b) b.disabled = !on; }

  // ---------------------------------------------------------------- approvals
  // Phase 3 confirm-risky gate: when the brain wants to run a gated tool, the
  // server pushes an approval ask over SSE. We render an Approve/Deny card in
  // the chat and Jarvis asks out loud. No answer in 90s = denied server-side.
  const approvalCards = new Map(); // id -> card element

  function describeAction(tool, input) {
    input = input || {};
    if (tool === 'Bash' || tool === 'PowerShell') return 'Run command:\n' + (input.command || '(unknown)');
    if (tool === 'Write') return 'Write file: ' + (input.file_path || '?');
    if (tool === 'Edit') return 'Edit file: ' + (input.file_path || '?');
    if (tool.startsWith('mcp__')) return 'Use connected service: ' + tool.replace(/^mcp__/, '').replace(/__/g, ' → ');
    const keys = Object.keys(input).slice(0, 3).map((k) => k + ': ' + String(input[k]).slice(0, 120)).join('\n');
    return tool + (keys ? '\n' + keys : '');
  }

  // Floating host on <body> — approval cards must be visible on EVERY tab now
  // that the Jarvis page is hidden from the nav.
  function approvalHost() {
    let h = $('jvApprovalHost');
    if (!h) {
      h = document.createElement('div');
      h.id = 'jvApprovalHost';
      h.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:90;display:flex;flex-direction:column;gap:10px;width:min(420px,calc(100vw - 36px))';
      document.body.appendChild(h);
    }
    return h;
  }

  function renderApproval(info) {
    const log = approvalHost();
    if (approvalCards.has(info.id)) return;
    const card = document.createElement('div');
    card.className = 'jv-msg jv-approve';
    card.style.maxWidth = '100%';
    const what = info.summary || describeAction(info.tool, info.input);
    const risk = String(info.risk || 'action').replace(/[^a-z -]/gi, '').slice(0, 24);
    card.innerHTML = `
      <div class="ttl">permission needed · ${esc(risk)}</div>
      <div class="what">${esc(what)}</div>
      <div class="row"><button class="ok">Approve</button><button class="no">Deny</button></div>`;
    const answer = async (allow) => {
      try { await AIOS.api.post('/api/jarvis/approval-response', { id: info.id, allow }); } catch { /* resolved elsewhere */ }
      markResolved(info.id, allow);
    };
    card.querySelector('.ok').addEventListener('click', () => answer(true));
    card.querySelector('.no').addEventListener('click', () => answer(false));
    log.appendChild(card);
    approvalCards.set(info.id, card);
    // short spoken ask (doesn't disturb the queue order — jumps the line)
    const spoken = info.summary
      ? 'Permission needed. ' + String(info.summary).slice(0, 140) + '?'
      : (info.tool === 'Bash' || info.tool === 'PowerShell'
        ? 'Permission to run a command?' : 'Permission to use ' + info.tool + '?');
    enqueueSpeech(spoken);
  }

  function markResolved(id, allow) {
    const card = approvalCards.get(id);
    if (!card) return;
    card.classList.add('resolved');
    const ttl = card.querySelector('.ttl');
    if (ttl) ttl.textContent = (allow ? '✓ approved' : '✗ denied') + ' · ' + ttl.textContent.split('·').pop().trim();
    approvalCards.delete(id);
    setTimeout(() => { try { card.remove(); } catch { /* gone */ } }, 4000);
  }

  function connectApprovals() {
    try {
      const es = new EventSource('/api/jarvis/approvals');
      es.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'approval') renderApproval(ev);
        else if (ev.type === 'tool-activity' && inflight) AIOS.bus.emit('jarvis:activity', ev);
        else if (ev.type === 'resolved') markResolved(ev.id, ev.allow);
        else if (ev.type === 'nudge' && ev.text) {
          addMsg('jarvis', ev.text);
          enqueueSpeech(ev.text);
          speechDone();
          AIOS.bus.emit('jarvis:reply', { q: '', a: ev.text });
          AIOS.notify({ id: 'jarvis-nudge:' + Date.now(), kind: 'lead', title: 'Jarvis', body: ev.text, page: 'jarvis' });
        }
      };
      // EventSource auto-reconnects on error; nothing to do
    } catch { /* unsupported — approvals still enforceable via timeout-deny */ }
  }

  // ------------------------------------------------------------ launch greeting
  // Once per day, on the first open of the AIOS, Jarvis says hello out loud
  // (time-aware, calendar-aware). Browsers may block autoplay until the first
  // click — the text still lands in the chat; JarvisApp allows autoplay.
  async function greetIfDue() {
    const today = new Date().toDateString();
    try { if (localStorage.getItem('jarvis.greetDay') === today) return; } catch { /* private mode */ }
    try { localStorage.setItem('jarvis.greetDay', today); } catch { /* ignore */ }
    try {
      const r = await AIOS.api.post('/api/jarvis/greet');
      if (!r || !r.text) return;
      addMsg('jarvis', r.text);
      history.push({ role: 'assistant', content: r.text });
      AIOS.bus.emit('jarvis:reply', { q: '', a: r.text });
      enqueueSpeech(r.text);
      speechDone();
    } catch { /* greeting is best-effort, never an error state */ }
  }

  // ------------------------------------------------------------------- mount
  function mount(el) {
    if (!document.getElementById('jarvis-css')) {
      const s = document.createElement('style'); s.id = 'jarvis-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    el.innerHTML = `
      <div class="jv-wrap">
        <div class="jv-stage">
          <div class="jv-orb"><canvas id="jvCanvas"></canvas><span class="jv-core-label">JARVIS</span></div>
          <div class="jv-status" id="jvStatus">standing by</div>
          <div class="jv-badges">
            <div class="jv-voice" id="jvStt" title="How Jarvis hears you">checking hearing</div>
            <div class="jv-voice" id="jvVoice" title="Which voice is speaking">offline voice</div>
          </div>
          <div class="jv-controls">
            <button class="jv-mic" id="jvMic" title="Talk to Jarvis">
              <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0014 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
            <button class="jv-conv" id="jvConv" title="Conversation mode — hands-free back-and-forth">
              <svg viewBox="0 0 24 24" fill="none"><path d="M4 6h13a3 3 0 013 3v2a3 3 0 01-3 3h-2l-3 3v-3H7a3 3 0 01-3-3V6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="jv-hint" id="jvHint">Click the mic and talk. Jarvis answers, then listens for a follow-up. Click the mic or press Ctrl+Alt+J to interrupt. Say "yes" or "no" to permission cards.</div>
        </div>
        <div class="jv-side">
          <div class="jv-side-head"><b>Conversation</b><button class="jv-clear" id="jvClear">clear</button></div>
          <div class="jv-log" id="jvLog"><div class="jv-empty">Ask me anything about your world, Yish.<br>"What's due in APUSH?" · "How's YDdetailers doing?"</div></div>
          <div class="jv-inputrow">
            <textarea class="jv-input" id="jvInput" rows="1" placeholder="Type or talk to Jarvis…"></textarea>
            <button class="jv-send" id="jvSend">Send</button>
          </div>
        </div>
      </div>`;

    canvas = $('jvCanvas');
    ctx = canvas ? canvas.getContext('2d') : null;

    $('jvMic').addEventListener('click', toggleMic);
    const convBtn = $('jvConv');
    convBtn.classList.toggle('on', convMode);
    convBtn.addEventListener('click', () => {
      convMode = !convMode;
      convBtn.classList.toggle('on', convMode);
      try { localStorage.setItem('jarvis.conv', convMode ? '1' : '0'); } catch { /* ignore */ }
      AIOS.toast(convMode ? 'Conversation mode on — talk freely' : 'Conversation mode off — click to talk each turn');
    });
    $('jvSend').addEventListener('click', () => { const i = $('jvInput'); const v = i.value; i.value = ''; send(v); });
    $('jvClear').addEventListener('click', async () => {
      cancelTurn(); if (capturing) stopCapture(true); history.length = 0;
      setSendEnabled(false);
      try {
        await AIOS.api.post('/api/jarvis/brain-reset', {});
        $('jvLog').innerHTML = '<div class="jv-empty">Cleared. What next, Yish?</div>';
      } catch (e) { addMsg('jarvis', 'Could not clear the conversation: ' + String(e?.message || e), 'err'); }
      finally { setSendEnabled(true); }
    });
    const inp = $('jvInput');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = inp.value; inp.value = ''; send(v); } });

    // speechSynthesis voice list can load async
    if (window.speechSynthesis) {
      ttsVoice = pickVoice();
      speechSynthesis.onvoiceschanged = () => { ttsVoice = pickVoice(); };
    }

    probeStt();
    connectApprovals(); // Phase 3 confirm-risky gate cards + Phase 5 nudges
    preloadAcks(); // wake-ack lines, cached for instant playback
    setTimeout(greetIfDue, 2500); // Phase 5: first-open-of-the-day hello
  }

  function onShow() {
    visible = true;
    t0 = 0;
    if (!raf) raf = requestAnimationFrame(drawOrb);
  }
  function onHide() {
    visible = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    stopSpeaking();
    if (capturing) stopCapture(true);
  }

  // Hooks for the rest of the OS:
  //  - activate(): desktop shell hotkey/wake word → jump to tab + open mic
  //  - ask(text):  other pages (Cortex 3D bar) pipe a question to the brain;
  //                reply speaks everywhere and lands in the Jarvis transcript
  //  - mic():      toggle voice capture without switching pages
  //  - state():    current orb state for mini-orbs
  // ---------------------------------------------------------- wake ack lines
  // 3 canned Jarvis lines, pre-synthesized server-side and preloaded here as
  // Audio objects — spoken ~instantly on wake (no thinking, no synth wait).
  const ackAudios = [];
  const fillerBlobs = []; // queued into the speech pipeline while the brain works
  let wakeAckCancel = null;
  let activationSerial = 0;
  async function preloadAcks() {
    try {
      const meta = await AIOS.api.get('/api/jarvis/acks');
      for (let i = 0; i < (meta.count || 0); i++) {
        try {
          const r = await fetch('/api/jarvis/ack?i=' + i);
          if (!r.ok) continue;
          const a = new Audio(URL.createObjectURL(await r.blob()));
          a.preload = 'auto';
          ackAudios.push(a);
        } catch { /* this ack not cached yet — skip */ }
      }
    } catch { /* endpoint missing — acks just don't play */ }
    try {
      const meta = await AIOS.api.get('/api/jarvis/fillers');
      for (let i = 0; i < (meta.count || 0); i++) {
        try {
          const r = await fetch('/api/jarvis/filler?i=' + i);
          if (r.ok) fillerBlobs.push(await r.blob());
        } catch { /* skip */ }
      }
    } catch { /* no fillers — fine */ }
  }
  // Wake word / hotkey = "make sure you're listening" — NEVER a toggle. With
  // conversation mode auto-opening follow-up windows, a toggle would close an
  // already-open mic and eat the user's words (the "wake word stopped working"
  // bug of 2026-07-06).
  // Resolve from the media event, never from an estimated duration. Listening
  // cannot begin until the acknowledgement has actually left the speakers.
  function playWakeAck() {
    if (!ackAudios.length) return Promise.resolve();
    const source = ackAudios[Math.floor(Math.random() * ackAudios.length)];
    const audio = source.cloneNode(true);
    return new Promise((resolve) => {
      let finished = false;
      let safety = null;
      const done = () => {
        if (finished) return;
        finished = true;
        if (safety) clearTimeout(safety);
        if (wakeAckCancel === done) wakeAckCancel = null;
        setWakeSuppressed(false);
        trace('wake.ack-done');
        resolve();
      };
      wakeAckCancel = () => { try { audio.pause(); } catch { /* ignore */ } done(); };
      audio.onended = done;
      audio.onerror = done;
      setWakeSuppressed(true);
      setState('speaking');
      trace('wake.ack-start');
      safety = setTimeout(done, 10000);
      try { audio.play().catch(done); } catch { done(); }
    });
  }

  async function wakeListen() {
    stopSpeaking(); // wake mid-speech = interrupt
    if (sttMode !== 'offline') await probeStt();
    if (sttMode !== 'offline') {
      addMsg('jarvis', 'JarvisVoice is restarting. Try again in a moment.', 'err');
      setState('idle');
      return;
    }
    if (capturing) return; // already listening — leave it alone
    startCapture().catch((e) => { addMsg('jarvis', 'Mic error: ' + String((e && e.message) || e), 'err'); setState('idle'); });
  }

  // Cinematic HUD boot when summoned (~2.8s): the arc reactor assembles —
  // rings draw themselves in, ticks spin up, the amber arc sweeps, the core
  // blooms — J.A.R.V.I.S. materializes letter by letter over boot readouts,
  // then the whole thing COLLAPSES INTO the actual HUD orb on the Second Brain
  // page. Subtle synthesized swell + ping via WebAudio (no assets).
  function playSummonAnimation(opts = {}) {
    if (document.getElementById('jvSummon')) return;
    if (!document.getElementById('jvSummon-css')) {
      const st = document.createElement('style'); st.id = 'jvSummon-css';
      st.textContent = `
      #jvSummon{position:fixed;inset:0;z-index:9998;pointer-events:none;overflow:hidden}
      #jvSummon .jvs-bg{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 46%,rgba(8,18,34,.88) 0%,rgba(2,4,9,.97) 70%);opacity:0;transition:opacity .35s ease}
      #jvSummon .jvs-grid{position:absolute;inset:0;opacity:0;background-image:linear-gradient(rgba(100,210,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(100,210,255,.05) 1px,transparent 1px);background-size:64px 64px;animation:jvsGrid 2.4s ease forwards}
      #jvSummon .jvs-scan{position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent 5%,rgba(100,210,255,.75) 50%,transparent 95%);box-shadow:0 0 24px rgba(100,210,255,.5);animation:jvsScan 1.15s cubic-bezier(.6,.1,.35,.95) forwards}
      #jvSummon .jvs-stage{position:absolute;inset:0;display:grid;place-items:center}
      #jvSummon .jvs-rig{position:relative;width:420px;height:420px;display:grid;place-items:center;will-change:transform,opacity}
      #jvSummon svg{position:absolute;inset:0;overflow:visible}
      #jvSummon .rA{transform-origin:center;animation:jvsSpinA 8s linear infinite;opacity:0;animation:jvsTickIn .7s ease .25s forwards,jvsSpinA 9s linear infinite}
      #jvSummon .rB circle{stroke-dasharray:100;stroke-dashoffset:100;animation:jvsDraw 1s cubic-bezier(.3,0,.2,1) .35s forwards}
      #jvSummon .rB{transform-origin:center;animation:jvsSpinB 14s linear infinite}
      #jvSummon .rC circle{stroke-dasharray:100;stroke-dashoffset:100;animation:jvsDraw 1s cubic-bezier(.3,0,.2,1) .55s forwards}
      #jvSummon .rC{transform-origin:center;animation:jvsSpinA 11s linear infinite reverse}
      #jvSummon .rAmber path{stroke-dasharray:100;stroke-dashoffset:100;animation:jvsDraw .9s cubic-bezier(.4,0,.2,1) .8s forwards}
      #jvSummon .rAmber{transform-origin:center;animation:jvsSpinB 7s linear infinite}
      #jvSummon .core{opacity:0;animation:jvsCore 1s ease .7s forwards}
      #jvSummon .corePulse{transform-origin:center;animation:jvsPulse 1.1s ease-in-out .9s infinite alternate}
      #jvSummon .jvs-t{position:relative;text-align:center;z-index:2}
      #jvSummon .jvsL{display:inline-block;font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:30px;font-weight:600;color:#dbeeff;text-shadow:0 0 18px rgba(100,210,255,.95),0 0 46px rgba(100,210,255,.4);opacity:0;filter:blur(10px);animation:jvsLetter .5s cubic-bezier(.2,.6,.25,1) forwards}
      #jvSummon .jvs-boot{margin-top:14px;font-family:var(--font-mono,monospace);font-size:10.5px;letter-spacing:.28em;color:#59c8f7}
      #jvSummon .jvsB{display:block;opacity:0;animation:jvsBoot .45s ease forwards}
      #jvSummon .jvsB i{font-style:normal;color:#3ddc84}
      @keyframes jvsGrid{0%{opacity:0}25%{opacity:1}80%{opacity:1}100%{opacity:0}}
      @keyframes jvsScan{0%{top:-3px;opacity:0}12%{opacity:1}100%{top:100%;opacity:0}}
      @keyframes jvsTickIn{from{opacity:0}to{opacity:1}}
      @keyframes jvsSpinA{to{transform:rotate(360deg)}}
      @keyframes jvsSpinB{to{transform:rotate(-360deg)}}
      @keyframes jvsDraw{to{stroke-dashoffset:0}}
      @keyframes jvsCore{from{opacity:0}to{opacity:1}}
      @keyframes jvsPulse{from{transform:scale(.94)}to{transform:scale(1.06)}}
      @keyframes jvsLetter{from{opacity:0;filter:blur(10px);transform:translateY(10px) scale(1.35)}to{opacity:1;filter:blur(0);transform:none}}
      @keyframes jvsBoot{from{opacity:0;transform:translateX(-8px)}to{opacity:.95;transform:none}}`;
      document.head.appendChild(st);
    }

    // ---- build the overlay ----
    const o = document.createElement('div');
    o.id = 'jvSummon';
    const title = 'J.A.R.V.I.S.';
    const letters = [...title].map((ch, i) =>
      `<span class="jvsL" style="animation-delay:${(0.85 + i * 0.06).toFixed(2)}s">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
    const nodes = (AIOS.state && AIOS.state.data && AIOS.state.data.vaultNotes) || '';
    o.innerHTML = `
      <div class="jvs-bg"></div>
      <div class="jvs-grid"></div>
      <div class="jvs-scan"></div>
      <div class="jvs-stage"><div class="jvs-rig">
        <svg viewBox="0 0 420 420">
          <g class="rA"></g>
          <g class="rB"><circle cx="210" cy="210" r="150" fill="none" stroke="rgba(100,210,255,.85)" stroke-width="2" pathLength="100"/></g>
          <g class="rC"><circle cx="210" cy="210" r="122" fill="none" stroke="rgba(61,242,255,.5)" stroke-width="1.5" stroke-dasharray="100" pathLength="100" stroke-linecap="round"/></g>
          <g class="rAmber"><path d="M 210 96 A 114 114 0 0 1 318 173" fill="none" stroke="rgba(255,180,84,.9)" stroke-width="4" stroke-linecap="round" pathLength="100"/></g>
          <g class="core corePulse">
            <circle cx="210" cy="210" r="58" fill="url(#jvsGlow)"/>
            <circle cx="210" cy="210" r="58" fill="none" stroke="rgba(150,225,255,.8)" stroke-width="1.6"/>
          </g>
          <defs><radialGradient id="jvsGlow"><stop offset="0%" stop-color="rgba(190,240,255,.95)"/><stop offset="45%" stop-color="rgba(100,210,255,.45)"/><stop offset="100%" stop-color="rgba(100,210,255,0)"/></radialGradient></defs>
        </svg>
        <div class="jvs-t">
          <div>${letters}</div>
          <div class="jvs-boot">
            <span class="jvsB" style="animation-delay:1.25s">NEURAL CORTEX <i>LINKED</i></span>
            <span class="jvsB" style="animation-delay:1.45s">VAULT ${nodes ? nodes + ' NODES ' : ''}<i>MOUNTED</i></span>
            <span class="jvsB" style="animation-delay:1.65s">VOICE <i>ONLINE</i></span>
          </div>
        </div>
      </div></div>`;
    document.body.appendChild(o);

    // tick ring built programmatically (60 radial ticks)
    const rA = o.querySelector('.rA');
    let ticks = '';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const big = i % 5 === 0;
      const r1 = big ? 176 : 182, r2 = 190;
      ticks += `<line x1="${210 + Math.cos(a) * r1}" y1="${210 + Math.sin(a) * r1}" x2="${210 + Math.cos(a) * r2}" y2="${210 + Math.sin(a) * r2}" stroke="rgba(100,210,255,${big ? 0.8 : 0.35})" stroke-width="${big ? 2.4 : 1.2}"/>`;
    }
    rA.innerHTML = ticks;
    requestAnimationFrame(() => { o.querySelector('.jvs-bg').style.opacity = '1'; });

    // ---- score: soft swell + ping, synthesized ----
    if (opts.sound !== false) try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const master = ac.createGain(); master.gain.value = 0.0001; master.connect(ac.destination);
      const osc = ac.createOscillator(); osc.type = 'sawtooth';
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90;
      osc.frequency.setValueAtTime(46, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(120, ac.currentTime + 1.4);
      lp.frequency.exponentialRampToValueAtTime(420, ac.currentTime + 1.4);
      osc.connect(lp); lp.connect(master); osc.start();
      master.gain.exponentialRampToValueAtTime(0.07, ac.currentTime + 0.5);
      master.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 1.9);
      osc.stop(ac.currentTime + 2);
      const ping = ac.createOscillator(); ping.type = 'sine'; ping.frequency.value = 1320;
      const pg = ac.createGain(); pg.gain.value = 0.0001; ping.connect(pg); pg.connect(ac.destination);
      ping.start(ac.currentTime + 1.55);
      pg.gain.setValueAtTime(0.0001, ac.currentTime + 1.55);
      pg.gain.exponentialRampToValueAtTime(0.09, ac.currentTime + 1.6);
      pg.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 2.15);
      ping.stop(ac.currentTime + 2.2);
      setTimeout(() => { try { ac.close(); } catch { /* done */ } }, 2600);
    } catch { /* no audio — visuals carry it */ }

    // ---- finale: collapse the reactor INTO the real HUD orb ----
    setTimeout(() => {
      const rig = o.querySelector('.jvs-rig');
      const bg = o.querySelector('.jvs-bg');
      const grid = o.querySelector('.jvs-grid');
      const hud = document.getElementById('b3Hud');
      rig.style.transition = 'transform .62s cubic-bezier(.55,0,.25,1), opacity .6s ease';
      if (hud) {
        const r = hud.getBoundingClientRect();
        const rr = rig.getBoundingClientRect();
        const dx = (r.left + r.width / 2) - (rr.left + rr.width / 2);
        const dy = (r.top + r.height / 2) - (rr.top + rr.height / 2);
        rig.style.transform = `translate(${dx}px, ${dy}px) scale(${(r.width / rr.width).toFixed(3)})`;
      } else {
        rig.style.transform = 'scale(.2)';
      }
      rig.style.opacity = '0';
      bg.style.transition = 'opacity .55s ease'; bg.style.opacity = '0';
      if (grid) grid.style.opacity = '0';
    }, 2050);
    setTimeout(() => { try { o.remove(); } catch { /* gone */ } }, 2800);
  }

  AIOS.jarvis = {
    async activate() {
      const activation = ++activationSerial;
      playSummonAnimation({ sound: false });
      AIOS.showPage('brain3d'); // Jarvis lives on the Second Brain tab now
      if (capturing) return;
      cancelTurn();
      await playWakeAck();
      if (activation !== activationSerial) return;
      await new Promise((resolve) => setTimeout(resolve, 140));
      await wakeListen();
    },
    ask(text) { return send(text); },
    stop() { cancelTurn(); if (capturing) stopCapture(true); },
    mic() { toggleMic(); },
    state() { return state; },
  };

  AIOS.registerPage({
    id: 'jarvis',
    hidden: true, // machinery + transcript live here; the visible surface is the Second Brain tab
    title: 'Jarvis',
    sub: 'voice · your second brain, out loud',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg>',
    mount,
    onShow,
    onHide,
  });
})();
