'use strict';
/*
 * AIOS OS layer — sound engine, boot sequence, command palette,
 * notification center, background starfield. Loads after all pages,
 * before the panda. Implements the core stubs notify/sound/registerCommand.
 */
(() => {
  const { esc } = AIOS.util;
  const $ = (id) => document.getElementById(id);
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // =========================================================================
  // 1. SOUND ENGINE — synthesized Web Audio, lazy-unlocked on first gesture
  // =========================================================================
  let actx = null, unlocked = false;
  function unlock() {
    if (unlocked) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      unlocked = true;
    } catch { /* no audio available */ }
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { once: true, capture: true }));

  function tone(freq, dur, { type = 'sine', gain = 0.05, at = 0, slide = null } = {}) {
    if (!actx || !unlocked) return;
    try {
      const t0 = actx.currentTime + at;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch { /* never break the app over a blip */ }
  }
  const SOUNDS = {
    boot: () => tone(220, 0.4, { type: 'sawtooth', gain: 0.035, slide: 880 }),
    tick: () => tone(1200, 0.03, { gain: 0.04 }),
    nav: () => tone(900, 0.025, { gain: 0.028 }),
    open: () => tone(520, 0.06, { gain: 0.045, slide: 780 }),
    notify: () => { tone(660, 0.07, { gain: 0.045 }); tone(880, 0.09, { gain: 0.045, at: 0.09 }); },
    success: () => { tone(523, 0.08, { gain: 0.04 }); tone(659, 0.08, { gain: 0.04, at: 0.08 }); tone(784, 0.12, { gain: 0.045, at: 0.16 }); },
    cash: () => { tone(988, 0.07, { type: 'square', gain: 0.028 }); tone(1319, 0.09, { type: 'square', gain: 0.028, at: 0.08 }); },
  };
  AIOS._implement('sound', (name) => {
    if (AIOS.state.ui.muted) return;
    const fn = SOUNDS[name];
    if (fn) fn();
  });

  // =========================================================================
  // 2. NOTIFICATION CENTER
  // =========================================================================
  const NOTIF_KEY = 'aios.notif.v1';
  let notifs = (() => {
    try { const s = JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); return Array.isArray(s.items) ? s.items : []; }
    catch { return []; }
  })();
  const saveNotifs = () => { try { localStorage.setItem(NOTIF_KEY, JSON.stringify({ items: notifs.slice(0, 100) })); } catch { /* ignore */ } };
  let panelOpen = false;

  function badge() {
    const b = $('notifBadge');
    if (!b) return;
    const n = notifs.filter((x) => !x.read).length;
    b.hidden = n === 0;
    b.textContent = n > 99 ? '99+' : String(n);
  }
  function notifyImpl(n) {
    if (!n || !n.id) return;
    if (notifs.some((x) => x.id === n.id)) return; // dedupe forever via stored id
    notifs.unshift({ id: n.id, kind: n.kind || 'system', title: String(n.title || ''), body: String(n.body || ''), ts: n.ts || new Date().toISOString(), page: n.page || null, read: false });
    notifs = notifs.slice(0, 100);
    saveNotifs();
    badge();
    AIOS.sound('notify');
    if (panelOpen) renderPanel();
  }
  AIOS._implement('notify', notifyImpl);

  function renderPanel() {
    const p = $('notifPanel');
    if (!p) return;
    const items = notifs.length
      ? notifs.map((n) => `
        <div class="notif-item${n.read ? '' : ' unread'}" data-nid="${esc(n.id)}">
          <span class="notif-kind ${esc(n.kind)}"></span>
          <span class="notif-main"><span class="notif-title">${esc(n.title)}</span>${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ''}</span>
          <span class="notif-time">${esc(AIOS.fmt.ago(n.ts))}</span>
        </div>`).join('')
      : `<div class="notif-empty">All quiet</div>`;
    p.innerHTML = `<div class="notif-head"><span>Notifications</span><button class="notif-clear" id="notifClear" title="Clear all notifications">clear all</button></div>${items}`;
  }
  function togglePanel(force) {
    const p = $('notifPanel');
    if (!p) return;
    panelOpen = force != null ? force : !panelOpen;
    p.hidden = !panelOpen;
    if (panelOpen) { renderPanel(); AIOS.sound('open'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    badge();
    $('notifBtn') && $('notifBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
    $('notifPanel').addEventListener('click', (e) => {
      if (e.target.closest('#notifClear')) {
        notifs = [];
        saveNotifs(); badge(); renderPanel();
        AIOS.toast('Notifications cleared', 'ok');
        return;
      }
      const item = e.target.closest('[data-nid]');
      if (!item) return;
      const n = notifs.find((x) => x.id === item.getAttribute('data-nid'));
      if (n) {
        n.read = true;
        saveNotifs(); badge();
        if (n.page) AIOS.showPage(n.page);
        togglePanel(false);
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (panelOpen && !e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) togglePanel(false);
    });
  });

  // ---- scanners ----
  AIOS.bus.on('data', (data) => {
    // new content detected (leads are handled by the pipeline page)
    const c = data && data.content;
    if (c && c.newCount > 0 && c.newest) {
      notifyImpl({
        id: 'content:' + (c.newest.title || c.newCount),
        kind: 'comment',
        title: 'New post detected',
        body: `${(c.newest.platform || '').toUpperCase()} · ${String(c.newest.title || '').slice(0, 60)}`,
        page: 'dashboard',
      });
    }
    scanEarnings();
  });
  AIOS.bus.on('quotes', ({ portfolio }) => {
    if (!portfolio || !portfolio.positions) return;
    const today = new Date().toISOString().slice(0, 10);
    for (const p of portfolio.positions) {
      const pct = Number(p.dayChangePct);
      if (p.live && isFinite(pct) && Math.abs(pct) >= 5 && p.shares > 0) {
        notifyImpl({
          id: `move:${p.ticker}:${today}`,
          kind: 'stock',
          title: `${p.ticker} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% today`,
          body: 'Big move on a holding',
          page: 'portfolio',
        });
      }
    }
  });
  const EARN_CHECK_KEY = 'aios.notif.earnchk';
  async function scanEarnings() {
    try {
      const last = Number(localStorage.getItem(EARN_CHECK_KEY) || 0);
      if (Date.now() - last < 6 * 3600 * 1000) return;
      localStorage.setItem(EARN_CHECK_KEY, String(Date.now()));
      const d = await AIOS.api.get('/api/earnings');
      if (!d || !d.available) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (const r of (d.rows || [])) {
        if (!r.held) continue;
        const ms = (Number(r.epoch) || 0) * 1000;
        const dt = ms ? new Date(ms) : new Date(r.date + 'T00:00');
        if (Number.isNaN(dt.getTime())) continue;
        const days = Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - today) / 86400000);
        if (days >= 0 && days <= 7) {
          notifyImpl({
            id: `earn:${r.ticker}:${r.date || r.epoch}`,
            kind: 'earnings',
            title: `${r.ticker} earnings ${days === 0 ? 'today' : 'in ' + days + 'd'}`,
            body: r.name || '',
            page: 'portfolio',
          });
        }
      }
    } catch { /* next pass */ }
  }

  // =========================================================================
  // 3. COMMAND PALETTE (Ctrl+K)
  // =========================================================================
  let palOpen = false, palItems = [], palActive = 0, vaultNotes = null;
  const registered = [];
  AIOS._implement('registerCommand', (cmd) => { if (cmd && cmd.title && cmd.run) registered.push(cmd); });

  function fuzzy(q, s) {
    q = q.toLowerCase(); s = s.toLowerCase();
    if (!q) return 1;
    let qi = 0, score = 0, streak = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) { qi++; streak++; score += streak * 2 + (i === 0 || s[i - 1] === ' ' ? 3 : 0); }
      else streak = 0;
    }
    return qi === q.length ? score : -1;
  }

  function buildSources() {
    const out = [];
    for (const p of AIOS._pages) out.push({ pk: 'page', title: `Go to ${p.title}`, run: () => AIOS.showPage(p.id) });
    const skills = (AIOS.state.data && AIOS.state.data.skills) || [];
    for (const s of skills) out.push({ pk: 'skill', title: `Run ${s.label}`, run: () => AIOS.terminal && AIOS.terminal.run(s.id) });
    out.push({ pk: 'skill', title: 'Open Claude session', run: () => AIOS.terminal && AIOS.terminal.run('') });
    out.push({ pk: 'action', title: 'Refresh data', run: () => AIOS.refreshData() });
    out.push({ pk: 'action', title: 'Toggle privacy (hide money)', run: () => AIOS.privacy.toggle() });
    out.push({ pk: 'action', title: AIOS.state.ui.muted ? 'Unmute sound' : 'Mute sound', run: () => { const b = $('soundBtn'); if (b) b.click(); } });
    out.push({ pk: 'action', title: 'Replay boot sequence', run: replayBoot });
    out.push({ pk: 'action', title: 'Toggle terminal', run: () => AIOS.terminal && AIOS.terminal.toggle() });
    for (const c of registered) out.push({ pk: 'action', title: c.title, run: c.run });
    if (vaultNotes) {
      for (const n of vaultNotes) out.push({ pk: 'note', title: n.title, run: () => { AIOS.showPage('brain'); setTimeout(() => AIOS.bus.emit('brain.open', { path: n.path }), 120); } });
    }
    return out;
  }

  function buildPalette() {
    const p = $('palette');
    p.innerHTML = `<div class="palette-box">
      <input class="palette-input" id="palInput" placeholder="Jump to a page, run a skill, open a note…" autocomplete="off" spellcheck="false">
      <div class="palette-list" id="palList"></div>
      <div class="palette-hint"><span><span class="palette-kbd">↑↓</span> navigate</span><span><span class="palette-kbd">enter</span> run</span><span><span class="palette-kbd">esc</span> close</span></div>
    </div>`;
    p.addEventListener('pointerdown', (e) => { if (e.target === p) closePalette(); });
    const input = $('palInput');
    input.addEventListener('input', () => renderPalList(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); palActive = Math.min(palItems.length - 1, palActive + 1); paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palActive = Math.max(0, palActive - 1); paintActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
      else if (e.key === 'Escape') { closePalette(); }
    });
    $('palList').addEventListener('pointermove', (e) => {
      const it = e.target.closest('[data-pi]');
      if (it) { palActive = Number(it.getAttribute('data-pi')); paintActive(); }
    });
    $('palList').addEventListener('click', (e) => {
      const it = e.target.closest('[data-pi]');
      if (it) { palActive = Number(it.getAttribute('data-pi')); runActive(); }
    });
  }
  function renderPalList(q) {
    const src = buildSources();
    palItems = src
      .map((s) => ({ s, score: fuzzy(q || '', s.title) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 9)
      .map((x) => x.s);
    palActive = 0;
    $('palList').innerHTML = palItems.length
      ? palItems.map((it, i) => `<div class="palette-item${i === 0 ? ' active' : ''}" data-pi="${i}"><span class="pk">${esc(it.pk)}</span><span class="ell">${esc(it.title)}</span></div>`).join('')
      : `<div class="palette-item"><span class="pk">—</span><span>No matches</span></div>`;
  }
  function paintActive() {
    document.querySelectorAll('#palList .palette-item').forEach((el, i) => el.classList.toggle('active', i === palActive));
    const act = document.querySelector('#palList .palette-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function runActive() {
    const it = palItems[palActive];
    closePalette();
    if (it) { try { it.run(); } catch (e) { console.error('palette run', e); } AIOS.sound('tick'); }
  }
  function openPalette() {
    if (palOpen) return;
    palOpen = true;
    $('palette').hidden = false;
    if (!vaultNotes) {
      AIOS.api.get('/api/vault').then((v) => {
        const nodes = (v && v.nodes) || [];
        vaultNotes = nodes.slice(0, 400).map((n) => ({ title: 'Note: ' + (n.title || n.id || n.path), path: n.path || n.id }));
      }).catch(() => { vaultNotes = []; });
    }
    renderPalList('');
    $('palInput').value = '';
    $('palInput').focus();
    AIOS.sound('open');
  }
  function closePalette() {
    palOpen = false;
    const p = $('palette');
    if (p) p.hidden = true;
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palOpen ? closePalette() : openPalette(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    buildPalette();
    $('paletteBtn') && $('paletteBtn').addEventListener('click', () => openPalette());
  });

  // =========================================================================
  // 4. BOOT SEQUENCE
  // =========================================================================
  let bootDone = false;
  function finishBoot() {
    if (bootDone) return;
    bootDone = true;
    const b = $('boot');
    if (b) {
      b.classList.add('done');
      setTimeout(() => b.remove(), 560);
    }
    try { sessionStorage.setItem('aios.booted', '1'); } catch { /* ignore */ }
    AIOS.bus.emit('boot.done');
    AIOS.sound('boot');
  }
  function bootLine(text, cls) {
    const lines = $('bootLines');
    if (!lines) return null;
    const div = document.createElement('div');
    div.className = 'boot-line';
    div.innerHTML = text;
    lines.appendChild(div);
    return div;
  }
  const pad = (label) => (label + ' ').padEnd(22, '.') + ' ';
  async function runBoot(full) {
    const fill = $('bootFill');
    const setFill = (p) => { if (fill) fill.style.width = Math.round(p * 100) + '%'; };
    const skip = () => finishBoot();
    document.addEventListener('pointerdown', skip, { once: true });
    document.addEventListener('keydown', skip, { once: true });

    if (!full) {
      setFill(1);
      bootLine(pad('ALL SYSTEMS') + '<span class="ok">GO</span>');
      setTimeout(finishBoot, 550);
      return;
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const health = Promise.race([
      AIOS.api.get('/api/health').catch(() => null),
      wait(900).then(() => undefined),
    ]);
    let dataOk = false;
    AIOS.bus.on('data', () => { dataOk = true; });

    bootLine(pad('AIOS KERNEL') + '<span class="ok">OK</span>'); setFill(0.12);
    await wait(330);
    bootLine(pad('PAGES MOUNTED') + `<span class="val">${AIOS._pages.length}</span>`); setFill(0.3);
    await wait(330);
    const h = await health;
    const pty = h === undefined ? '<span class="warn">UNKNOWN</span>' : (h && h.pty ? '<span class="ok">OK</span>' : '<span class="warn">OFFLINE</span>');
    if (bootDone) return;
    bootLine(pad('TERMINAL PTY') + pty); setFill(0.5);
    await wait(330);
    const dl = bootLine(pad('DATA LINK') + (dataOk ? '<span class="ok">OK</span>' : '<span class="val">SYNCING</span>')); setFill(0.68);
    await wait(430);
    if (dl && dataOk) dl.innerHTML = pad('DATA LINK') + '<span class="ok">OK</span>';
    bootLine(pad('SOUND') + (AIOS.state.ui.muted ? '<span class="warn">MUTED</span>' : '<span class="ok">ON</span>')); setFill(0.85);
    await wait(330);
    bootLine(pad('ALL SYSTEMS') + '<span class="ok">GO</span>'); setFill(1);
    await wait(420);
    finishBoot();
  }
  function replayBoot() {
    try { sessionStorage.removeItem('aios.booted'); } catch { /* ignore */ }
    if (!$('boot')) {
      const b = document.createElement('div');
      b.id = 'boot';
      b.innerHTML = `<div class="boot-inner">
        <div class="boot-title">AIOS <span class="boot-ver">MISSION CONTROL</span></div>
        <div class="boot-lines" id="bootLines"></div>
        <div class="boot-bar"><div class="boot-fill" id="bootFill"></div></div>
        <div class="boot-skip">click or press any key to skip</div>
      </div>`;
      document.body.appendChild(b);
    }
    bootDone = false;
    runBoot(true);
  }
  document.addEventListener('DOMContentLoaded', () => {
    let booted = false;
    try { booted = sessionStorage.getItem('aios.booted') === '1'; } catch { /* ignore */ }
    runBoot(!booted && !RM.matches);
  });

  // =========================================================================
  // 5. BACKGROUND — starfield + perspective grid + data streams (#bgfx)
  // =========================================================================
  (() => {
    const canvas = $('bgfx');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    let stars = [];
    let streak = null, nextStreak = 0;
    let last = 0, t = 0;

    // pre-rendered glow sprite (avoids per-star shadowBlur)
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 32;
    const sctx = sprite.getContext('2d');
    const g = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(160,215,255,1)');
    g.addColorStop(0.35, 'rgba(100,180,255,0.5)');
    g.addColorStop(1, 'rgba(100,180,255,0)');
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, 32, 32);

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: 110 }, () => {
        const depth = Math.random();
        return {
          x: Math.random() * W,
          y: Math.random() * H,
          z: depth,
          r: 0.6 + depth * 1.7,
          a: 0.12 + depth * 0.5,
          vx: (0.4 + depth) * 0.9,
          tw: Math.random() * Math.PI * 2,
        };
      });
      draw(0, true);
    }

    function drawGrid() {
      const gy = H * 0.72;            // horizon
      const vx = W / 2;               // vanishing x
      ctx.strokeStyle = 'rgba(100,210,255,0.05)';
      ctx.lineWidth = 1;
      // horizontals, spacing grows toward the bottom
      for (let i = 0; i < 7; i++) {
        const f = i / 6;
        const y = gy + (H - gy) * f * f;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.globalAlpha = 0.5 + f * 0.5;
        ctx.stroke();
      }
      // converging verticals
      for (let i = -8; i <= 8; i++) {
        const xb = vx + i * (W / 10);
        ctx.beginPath();
        ctx.moveTo(vx + i * (W / 42), gy);
        ctx.lineTo(xb, H);
        ctx.globalAlpha = 0.8;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function draw(dt, staticFrame) {
      ctx.clearRect(0, 0, W, H);
      drawGrid();
      for (const s of stars) {
        if (!staticFrame) {
          s.x += s.vx * dt * 0.012;
          if (s.x > W + 8) { s.x = -8; s.y = Math.random() * H; }
          s.tw += dt * 0.002;
        }
        const twinkle = 0.75 + 0.25 * Math.sin(s.tw);
        const size = s.r * 6;
        ctx.globalAlpha = s.a * twinkle;
        ctx.drawImage(sprite, s.x - size / 2, s.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      if (streak && !staticFrame) {
        const p = (t - streak.t0) / streak.dur;
        if (p >= 1) streak = null;
        else {
          const x = streak.x0 + (streak.x1 - streak.x0) * p;
          const y = streak.y0 + (streak.y1 - streak.y0) * p;
          const tail = 90;
          const dx = streak.x1 - streak.x0, dy = streak.y1 - streak.y0;
          const len = Math.hypot(dx, dy) || 1;
          const grad = ctx.createLinearGradient(x - (dx / len) * tail, y - (dy / len) * tail, x, y);
          grad.addColorStop(0, 'rgba(61,242,255,0)');
          grad.addColorStop(1, `rgba(61,242,255,${0.32 * (1 - p)})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x - (dx / len) * tail, y - (dy / len) * tail);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
    }

    function frame(now) {
      requestAnimationFrame(frame);
      if (document.hidden) { last = now; return; }
      const dt = now - last;
      if (dt < 33) return; // ~30fps cap
      last = now;
      t = now;
      if (!streak && now > nextStreak) {
        const fromTop = Math.random() < 0.6;
        streak = fromTop
          ? { x0: Math.random() * W * 0.7, y0: -20, x1: Math.random() * W * 0.7 + W * 0.3, y1: H * (0.2 + Math.random() * 0.4), t0: now, dur: 900 + Math.random() * 600 }
          : { x0: -30, y0: Math.random() * H * 0.5, x1: W * (0.4 + Math.random() * 0.6), y1: Math.random() * H * 0.6, t0: now, dur: 900 + Math.random() * 600 };
        nextStreak = now + 6000 + Math.random() * 8000;
      }
      draw(dt, false);
    }

    window.addEventListener('resize', resize);
    resize();
    if (!RM.matches) {
      nextStreak = performance.now() + 4000;
      requestAnimationFrame((n) => { last = n; requestAnimationFrame(frame); });
    }
  })();
})();
