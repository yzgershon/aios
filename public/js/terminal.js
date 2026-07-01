'use strict';
/*
 * AIOS terminal — xterm + WebSocket PTY bridge, ported from v1 app.js.
 * WS protocol unchanged: ws(s)://host/terminal?skill=&cols=&rows=,
 * client sends {type:'input',data} / {type:'resize',cols,rows}, server sends raw PTY frames.
 * Region is global chrome (sibling of pages); collapse + height persist in AIOS.state.ui.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => AIOS.util.esc(s);

  const MIN_H = 160;
  const DEFAULT_H = 340;
  const DRAG_ZONE = 7; // px from the bar's top edge that grabs the resize drag

  let term = null;
  let fitAddon = null;
  let currentWs = null;
  let ptyAvailable = true;
  // server learns initial size from the query string; only send resize on real change
  let sentCols = 0;
  let sentRows = 0;

  let region = null, bar = null, stage = null, status = null, skillWrap = null;

  const isCollapsed = () => AIOS.state.ui.termCollapsed !== false;
  const maxH = () => Math.round(window.innerHeight * 0.7);
  const clampH = (h) => Math.max(MIN_H, Math.min(maxH(), Math.round(Number(h) || DEFAULT_H)));

  function applyTerminal() {
    if (!region) return;
    const c = isCollapsed();
    region.classList.toggle('collapsed', c);
    // inline height only while expanded so the .collapsed CSS height wins when shut
    region.style.height = c ? '' : clampH(AIOS.state.ui.termH || DEFAULT_H) + 'px';
    if (c && bar) bar.style.cursor = '';
  }

  function initTerm() {
    if (!window.Terminal || !$('xterm')) return;
    term = new window.Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
      theme: {
        background: '#04060c00', // transparent over the stage's dark panel
        foreground: '#e9f3ff',
        cursor: '#64d2ff',
        selectionBackground: '#64d2ff40',
        black: '#070b14',
        red: '#ff453a',
        green: '#30d158',
        yellow: '#ffd60a',
        blue: '#0a84ff',
        magenta: '#b59cf2',
        cyan: '#64d2ff',
        white: '#e9f3ff',
        brightBlack: '#4d617e',
        brightRed: '#ff6961',
        brightGreen: '#5ce07f',
        brightYellow: '#ffe14d',
        brightBlue: '#4aa8ff',
        brightMagenta: '#cdbbf7',
        brightCyan: '#3df2ff',
        brightWhite: '#ffffff',
      },
    });
    if (window.FitAddon && window.FitAddon.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    term.open($('xterm'));
    term.onData((d) => { if (currentWs && currentWs.readyState === 1) currentWs.send(JSON.stringify({ type: 'input', data: d })); });
    term.writeln('\x1b[38;5;45mAIOS terminal.\x1b[0m Pick a skill above, or hit \x1b[1mClaude\x1b[0m for a free session.');
  }

  function fitTerm() {
    if (!fitAddon || !region || region.classList.contains('collapsed') || !stage || stage.offsetParent === null) return;
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        if (currentWs && currentWs.readyState === 1 && (term.cols !== sentCols || term.rows !== sentRows)) {
          sentCols = term.cols; sentRows = term.rows;
          currentWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch { /* stage mid-transition */ }
    });
  }

  function setStatus(text, cls) {
    if (!status) return;
    status.textContent = text;
    status.className = 'term-status' + (cls ? ' ' + cls : '');
  }

  function startSession(skill) {
    if (!ptyAvailable) { setStatus('terminal unavailable', 'err'); return; }
    expand();
    if (currentWs) { try { currentWs.close(); } catch { /* gone */ } currentWs = null; }
    if (term) term.reset();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const cols = term ? term.cols : 80, rows = term ? term.rows : 24;
    const q = new URLSearchParams();
    if (skill) q.set('skill', skill);
    q.set('cols', cols); q.set('rows', rows);
    const ws = new WebSocket(`${proto}://${location.host}/terminal?${q.toString()}`);
    currentWs = ws;
    sentCols = cols; sentRows = rows;
    const thisWs = ws; // stale-socket guard: superseded sessions must never paint
    setStatus(skill ? 'starting /' + skill : 'starting claude', 'run');
    ws.onopen = () => { if (thisWs !== currentWs) return; setStatus(skill ? 'live · /' + skill : 'live · claude', 'run'); fitTerm(); if (term) term.focus(); };
    ws.onmessage = (ev) => { if (thisWs !== currentWs) return; if (term) term.write(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); };
    ws.onclose = () => { if (thisWs !== currentWs) return; setStatus('session ended', ''); if (term) term.write('\r\n\x1b[38;5;244m[session ended]\x1b[0m\r\n'); };
    ws.onerror = () => { if (thisWs !== currentWs) return; setStatus('connection error', 'err'); };
  }

  function renderSkillButtons(skills) {
    if (!skillWrap) return;
    const list = Array.isArray(skills) ? skills : [];
    const btns = list.map((s) => `<button class="skill-btn ${s.primary ? 'primary' : 'secondary'}" data-skill="${esc(s.id)}">${esc(s.label)}</button>`);
    btns.unshift('<button class="skill-btn bare" data-skill="">Claude</button>');
    skillWrap.innerHTML = btns.join('');
  }

  // ---- collapse / expand (v1 semantics: expanding never auto-starts a session) ----
  function expand() {
    if (!isCollapsed()) return;
    AIOS.state.ui.termCollapsed = false;
    applyTerminal();
    AIOS.saveUi();
    AIOS.sound('open');
    fitTerm();
  }
  function collapse() {
    if (isCollapsed()) return;
    AIOS.state.ui.termCollapsed = true;
    applyTerminal();
    AIOS.saveUi();
  }
  function toggle() {
    if (isCollapsed()) { expand(); if (term) term.focus(); }
    else collapse();
  }

  // ---- height drag: grab the bar's top edge, min 160px, max 70vh ----
  function bindHeightDrag() {
    let drag = null; // {startY, startH}
    bar.addEventListener('pointerdown', (e) => {
      if (isCollapsed() || e.button !== 0) return;
      if (e.clientY - bar.getBoundingClientRect().top > DRAG_ZONE) return;
      drag = { startY: e.clientY, startH: region.getBoundingClientRect().height };
      try { bar.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) {
        if (!isCollapsed()) bar.style.cursor = (e.clientY - bar.getBoundingClientRect().top <= DRAG_ZONE) ? 'ns-resize' : '';
        return;
      }
      region.style.height = clampH(drag.startH + (drag.startY - e.clientY)) + 'px';
      fitTerm();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      AIOS.state.ui.termH = clampH(region.getBoundingClientRect().height);
      AIOS.saveUi();
      fitTerm();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  async function checkHealth() {
    try {
      const h = await AIOS.api.get('/api/health');
      ptyAvailable = !!h.pty;
      if (!ptyAvailable) setStatus('terminal unavailable', 'err');
    } catch { /* assume available */ }
  }

  // ---- public API (consumed by command palette + pages) ----
  AIOS.terminal = {
    expand,
    collapse,
    toggle,
    run(skillId) { startSession(skillId || ''); },
    get running() { return !!(currentWs && currentWs.readyState <= 1); },
  };

  function init() {
    region = $('terminalRegion');
    bar = $('terminalBar');
    stage = $('terminalStage');
    status = $('termStatus');
    skillWrap = $('skillButtons');
    if (!region || !bar || !stage) { console.error('terminal: region markup missing'); return; }

    applyTerminal();
    initTerm();
    renderSkillButtons(AIOS.state.data ? AIOS.state.data.skills : []);
    checkHealth();

    skillWrap.addEventListener('click', (e) => {
      const b = e.target.closest('.skill-btn');
      if (!b) return;
      startSession(b.getAttribute('data-skill') || '');
    });
    const tgl = $('termToggle');
    if (tgl) tgl.addEventListener('click', toggle);
    const side = $('sideTerminal');
    if (side) side.addEventListener('click', toggle);

    bindHeightDrag();
    AIOS.bus.on('data', (d) => renderSkillButtons(d && d.skills));
    AIOS.observe(stage, fitTerm);
    window.addEventListener('resize', () => {
      // stored height may exceed the new 70vh cap after a window shrink
      if (!isCollapsed() && region.getBoundingClientRect().height > maxH()) {
        region.style.height = clampH(region.getBoundingClientRect().height) + 'px';
      }
      fitTerm();
    });
    fitTerm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
