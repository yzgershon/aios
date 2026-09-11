'use strict';
/*
 * AIOS page: brain3d — the Second Brain as a 3D galaxy (Phase 4).
 * Layout mirrors the reference build: left panel (search / inspector / top hubs
 * / forces / display), FILTER legend top-right, big J.A.R.V.I.S. HUD orb on the
 * right, reply bubble + ask bar with round action buttons bottom-center.
 * Vendored 3d-force-graph (three.js bundled). Same vault data as the 2D cortex.
 */
(() => {
  const { esc } = AIOS.util;
  const $id = (id) => document.getElementById(id);

  // same region palette as brain.js so both views agree
  const FOLDER_COLORS = { '': '#9aa7bd', memory: '#64d2ff', projects: '#3df2ff', chats: '#0a84ff', daily: '#0a84ff', references: '#ffd60a', decisions: '#ff7ab8', templates: '#5ed0c0', audits: '#ffd60a' };
  const REGION_COLORS = { 'chats/school': '#64d2ff', 'chats/business': '#30d158', 'chats/personal': '#b59cf2', 'chats/ai-tools': '#3df2ff', 'daily/aios': '#0a84ff', 'daily/yddetailers': '#30d158', 'daily/sessions': '#7f8da3', 'projects/yddetailers': '#30d158', 'projects/school': '#64d2ff', 'projects/personal': '#b59cf2', references: '#ffd60a', decisions: '#ff7ab8', templates: '#5ed0c0', memory: '#64d2ff' };
  const regionKey = (f) => { const p = (f || '').split('/').filter(Boolean); return p.length >= 2 ? p[0] + '/' + p[1] : (p[0] || ''); };
  const regionColor = (k) => REGION_COLORS[k] || FOLDER_COLORS[(k || '').split('/')[0]] || '#0a84ff';

  let graph = null;
  let data = { nodes: [], links: [] };
  let counts = {};
  let focused = null;
  let neighbors = new Set();
  let searchHits = null;
  let hiddenRegions = new Set();
  let inited = false, visible = false;
  let hubLabelsOn = true, particlesOn = true;
  let labelEls = [];   // [{el, node}]
  let labelTimer = 0;
  let graphSpinRaf = 0;
  let graphSpinLast = 0;

  const CSS = `
  #page-brain3d{position:relative;overflow:hidden;padding:0}
  .b3-stage{position:absolute;inset:0}
  .b3-labels{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden}
  .b3-nl{position:absolute;transform:translate(-50%,-140%);font:10.5px Inter,sans-serif;color:rgba(207,230,255,.5);text-shadow:0 1px 4px #000;white-space:nowrap}
  .b3-panel{position:absolute;top:14px;left:14px;z-index:5;width:250px;max-height:calc(100% - 28px);overflow-y:auto;background:rgba(8,14,26,.82);border:1px solid var(--line,#22314d);border-radius:14px;padding:14px;backdrop-filter:blur(8px)}
  .b3-panel h2{font-size:15px;margin:0 0 2px;letter-spacing:.04em}
  .b3-sub{font-size:11px;color:var(--muted,#7a8aa6)}
  .b3-back{font-size:12px;color:#30d158;cursor:pointer;background:none;border:none;padding:0;margin:4px 0 10px;display:block}
  .b3-search{width:100%;background:rgba(4,8,16,.8);border:1px solid var(--line,#22314d);border-radius:9px;color:var(--text,#e8eefc);padding:8px 10px;font-size:13px;outline:none;margin-bottom:4px}
  .b3-search:focus{border-color:var(--accent,#64d2ff)}
  .b3-sec{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted,#7a8aa6);margin:14px 0 6px}
  .b3-note{background:rgba(4,8,16,.6);border:1px solid var(--line,#22314d);border-radius:10px;padding:10px;font-size:12px;line-height:1.55;color:var(--muted,#9db1cc);max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
  .b3-note b{color:var(--text,#e8eefc)}
  .b3-hub{display:flex;justify-content:space-between;align-items:center;padding:4px 6px;border-radius:7px;cursor:pointer;font-size:12.5px}
  .b3-hub:hover{background:rgba(100,210,255,.08)}
  .b3-hub .dot{width:8px;height:8px;border-radius:50%;margin-right:7px;flex:none}
  .b3-hub .nm{flex:1;display:flex;align-items:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .b3-hub .ct{color:var(--muted,#7a8aa6);font-size:11px}
  .b3-frow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted,#9db1cc);padding:3px 0}
  .b3-frow label{width:70px;flex:none}
  .b3-frow input[type=range]{flex:1;accent-color:#30d158;height:4px}
  .b3-crow{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:var(--text,#dce6fb);padding:5px 6px;border-radius:7px;cursor:pointer}
  .b3-crow:hover{background:rgba(100,210,255,.08)}
  .b3-crow .chk{width:16px;height:16px;border-radius:4px;border:1px solid var(--line,#22314d);display:grid;place-items:center;color:#04120a;background:transparent;font-size:11px}
  .b3-crow.on .chk{background:#30d158;border-color:#30d158}
  .b3-filter{position:absolute;top:14px;right:14px;z-index:5;width:180px;background:rgba(8,14,26,.82);border:1px solid var(--line,#22314d);border-radius:14px;padding:12px 14px;backdrop-filter:blur(8px)}
  .b3-filter #b3Legend{max-height:180px;overflow-y:auto}
  .b3-leg{display:flex;justify-content:space-between;align-items:center;padding:3px 2px;border-radius:7px;cursor:pointer;font-size:12px}
  .b3-leg:hover{background:rgba(100,210,255,.08)}
  .b3-leg.off{opacity:.35}
  .b3-leg .nm{display:flex;align-items:center;gap:7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .b3-leg .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .b3-leg .ct{color:var(--muted,#7a8aa6);font-size:11px}
  .b3-hud{position:absolute;right:34px;top:56%;transform:translateY(-50%);z-index:6;width:190px;height:190px;cursor:pointer}
  .b3-hud canvas{position:absolute;inset:0;width:100%;height:100%}
  .b3-hud .jl{position:absolute;inset:0;display:grid;place-items:center;font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:13px;letter-spacing:.3em;color:#cfe6ff;text-shadow:0 0 14px rgba(100,210,255,.9);padding-left:.3em;pointer-events:none}
  .b3-jarvis{position:absolute;left:calc(278px + (100% - 278px - 240px) / 2);transform:translateX(-50%);bottom:22px;z-index:6;width:min(640px,calc(100% - 278px - 260px))}
  @media(max-width:1100px){.b3-jarvis{left:50%;width:min(560px,calc(100% - 40px))}}
  .b3-caption{background:rgba(14,32,24,.9);border:1px solid rgba(48,209,88,.35);border-radius:14px;padding:12px 16px;font-size:14px;line-height:1.55;color:#e8f6ec;margin-bottom:10px;backdrop-filter:blur(8px);display:none}
  .b3-caption.show{display:block}
  .b3-askwrap{display:flex;align-items:center;gap:10px}
  .b3-askrow{flex:1;display:flex;align-items:center;background:rgba(8,14,26,.85);border:1px solid var(--line,#22314d);border-radius:999px;padding:4px 6px 4px 18px;backdrop-filter:blur(8px)}
  .b3-ask{flex:1;background:none;border:none;outline:none;color:var(--text,#e8eefc);font-size:14px;padding:9px 0}
  .b3-ask::placeholder{color:var(--muted,#5a6a86)}
  .b3-act{width:46px;height:46px;flex:none;border-radius:50%;border:1px solid var(--line,#22314d);background:rgba(12,24,20,.85);color:#9fd9b4;cursor:pointer;display:grid;place-items:center;font-size:17px;backdrop-filter:blur(8px)}
  .b3-act:hover{border-color:#30d158;color:#30d158}
  .b3-act.live{background:rgba(255,90,110,.25);color:#ff8a9b;border-color:#ff5a6e}
  `;

  // =========================================================================
  function mount(el) {
    if (!$id('brain3d-css')) { const s = document.createElement('style'); s.id = 'brain3d-css'; s.textContent = CSS; document.head.appendChild(s); }
    el.innerHTML = `
      <div class="b3-stage" id="b3Stage"></div>
      <div class="b3-labels" id="b3Labels"></div>

      <div class="b3-panel">
        <h2>SECOND BRAIN</h2>
        <div class="b3-sub" id="b3Counts">loading…</div>
        <div style="height:10px"></div>
        <input class="b3-search" id="b3Search" placeholder="Search the brain…" />
        <div class="b3-sec">Inspector</div>
        <div class="b3-note" id="b3Note">Click a node to focus it — only that node and its connections light up, and you can read its note here.</div>
        <div class="b3-sec">Top hubs</div>
        <div id="b3Hubs"></div>
        <div class="b3-sec">Forces</div>
        <div class="b3-frow"><label>Repel</label><input type="range" id="b3Repel" min="10" max="160" value="45"></div>
        <div class="b3-frow"><label>Link length</label><input type="range" id="b3LinkLen" min="10" max="140" value="40"></div>
        <div class="b3-sec">Display</div>
        <div class="b3-crow on" id="b3TogLabels"><span>Hub labels</span><span class="chk">✓</span></div>
        <div class="b3-crow on" id="b3TogFlow"><span>Particle flow</span><span class="chk">✓</span></div>
      </div>

      <div class="b3-filter">
        <div class="b3-sec" style="margin-top:0">Filter</div>
        <div id="b3Legend"></div>
      </div>
      <div class="b3-hud" id="b3Hud" title="Talk to Jarvis"><canvas id="b3HudCv"></canvas><span class="jl">J.A.R.V.I.S.</span></div>
      <div class="b3-jarvis">
        <div class="b3-caption" id="b3Caption"></div>
        <div class="b3-askwrap">
          <div class="b3-askrow">
            <input class="b3-ask" id="b3Ask" placeholder='Ask · "remind me…" · "good morning" · "show me…" · "what&#39;s due…"' />
          </div>
          <button class="b3-act" id="b3Mic" title="Talk">🎙</button>
          <button class="b3-act" id="b3Brief" title="Morning brief">☀</button>
          <button class="b3-act" id="b3Dash" title="Command center">🖥</button>
        </div>
      </div>`;
    $id('b3Search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      searchHits = q ? new Set(data.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id)) : null;
      restyle();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && visible) clearFocus(); });

    // forces
    $id('b3Repel').addEventListener('input', (e) => {
      if (!graph) return;
      graph.d3Force('charge').strength(-Number(e.target.value));
      graph.d3ReheatSimulation();
    });
    $id('b3LinkLen').addEventListener('input', (e) => {
      if (!graph) return;
      graph.d3Force('link').distance(Number(e.target.value));
      graph.d3ReheatSimulation();
    });
    // display toggles
    $id('b3TogLabels').addEventListener('click', (e) => {
      hubLabelsOn = !hubLabelsOn;
      e.currentTarget.classList.toggle('on', hubLabelsOn);
      $id('b3Labels').style.display = hubLabelsOn ? '' : 'none';
    });
    $id('b3TogFlow').addEventListener('click', (e) => {
      particlesOn = !particlesOn;
      e.currentTarget.classList.toggle('on', particlesOn);
      if (graph) graph.linkDirectionalParticles(particlesOn ? 1 : 0);
    });

    // Jarvis controls
    const ask = $id('b3Ask');
    ask.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = ask.value.trim();
      if (!v || !AIOS.jarvis) return;
      ask.value = '';
      caption('…');
      AIOS.jarvis.ask(v);
    });
    const micBtn = $id('b3Mic');
    micBtn.addEventListener('click', () => AIOS.jarvis && AIOS.jarvis.mic());
    $id('b3Hud').addEventListener('click', () => AIOS.jarvis && AIOS.jarvis.mic());
    $id('b3Brief').addEventListener('click', () => { caption('…'); if (AIOS.jarvis) AIOS.jarvis.ask('Good morning — give me my brief: what needs action today?'); });
    $id('b3Dash').addEventListener('click', () => AIOS.showPage('dashboard'));
    AIOS.bus.on('jarvis:reply', (r) => { if (visible && r) caption(r.a); });
    AIOS.bus.on('jarvis:state', (s) => { hudState = s; if (micBtn) micBtn.classList.toggle('live', s === 'listening'); });
    startHud();
  }

  function caption(text) {
    const el = $id('b3Caption');
    if (!el) return;
    el.textContent = String(text || '').slice(0, 320);
    el.classList.add('show');
  }

  // ---- the J.A.R.V.I.S. HUD orb (right side) ------------------------------
  const HUD_COLOR = { idle: [100, 210, 255], listening: [255, 90, 110], thinking: [255, 180, 84], speaking: [61, 242, 255] };
  let hudState = 'idle';
  const hudRgb = [100, 210, 255];
  let hudRaf = 0;
  function startHud() {
    const cv = $id('b3HudCv');
    if (!cv) return;
    const c2 = cv.getContext('2d');
    const draw = (ts) => {
      hudRaf = requestAnimationFrame(draw);
      if (!visible) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth || 200, h = cv.clientHeight || 200;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, w, h);
      const t = ts / 1000;
      const tgt = HUD_COLOR[hudState] || HUD_COLOR.idle;
      for (let i = 0; i < 3; i++) hudRgb[i] += (tgt[i] - hudRgb[i]) * 0.06;
      const col = (a) => `rgba(${Math.round(hudRgb[0])},${Math.round(hudRgb[1])},${Math.round(hudRgb[2])},${a})`;
      const busy = hudState !== 'idle';
      const energy = hudState === 'speaking' ? 1 : hudState === 'listening' ? 0.7 : hudState === 'thinking' ? 0.4 : 0.12;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 4;

      // outer tick ring (like the reference HUD)
      c2.save(); c2.translate(cx, cy); c2.rotate(t * 0.12);
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const big = i % 5 === 0;
        c2.beginPath();
        c2.moveTo(Math.cos(a) * R * (big ? 0.90 : 0.94), Math.sin(a) * R * (big ? 0.90 : 0.94));
        c2.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        c2.strokeStyle = col(big ? 0.75 : 0.35); c2.lineWidth = big ? 2 : 1; c2.stroke();
      }
      c2.restore();
      // segmented mid ring
      c2.save(); c2.translate(cx, cy); c2.rotate(-t * (0.25 + energy * 0.6));
      for (let s = 0; s < 4; s++) {
        const a0 = (s / 4) * Math.PI * 2 + 0.18;
        c2.beginPath(); c2.arc(0, 0, R * 0.78, a0, a0 + Math.PI / 2 - 0.36);
        c2.strokeStyle = col(0.55); c2.lineWidth = 2.5; c2.lineCap = 'round'; c2.stroke();
      }
      c2.restore();
      // amber accent arc (the reference has one warm arc)
      const aa = t * 0.5;
      c2.beginPath(); c2.arc(cx, cy, R * 0.68, aa, aa + Math.PI * 0.55);
      c2.strokeStyle = 'rgba(255,180,84,0.85)'; c2.lineWidth = 3.5; c2.lineCap = 'round'; c2.stroke();
      // inner ring + glow core
      c2.beginPath(); c2.arc(cx, cy, R * 0.56, 0, Math.PI * 2); c2.strokeStyle = col(0.5); c2.lineWidth = 1.5; c2.stroke();
      const pulse = 1 + Math.sin(t * (busy ? 6 : 1.5)) * (0.04 + energy * 0.06);
      const g = c2.createRadialGradient(cx, cy, 2, cx, cy, R * 0.5 * pulse);
      g.addColorStop(0, col(0.5 + energy * 0.4)); g.addColorStop(0.7, col(0.10)); g.addColorStop(1, col(0));
      c2.beginPath(); c2.arc(cx, cy, R * 0.5 * pulse, 0, Math.PI * 2); c2.fillStyle = g; c2.fill();
      // small rotating arc inside
      const ia = -t * (1 + energy * 2);
      c2.beginPath(); c2.arc(cx, cy, R * 0.45, ia, ia + Math.PI * 0.8);
      c2.strokeStyle = col(0.9); c2.lineWidth = 2; c2.lineCap = 'round'; c2.stroke();
    };
    if (!hudRaf) hudRaf = requestAnimationFrame(draw);
  }

  // ---- hub labels overlay (projected to screen) ---------------------------
  function buildHubLabels() {
    const wrap = $id('b3Labels');
    wrap.innerHTML = '';
    labelEls = [];
    const hubs = [...data.nodes].sort((a, b) => b.deg - a.deg).slice(0, 16).filter((n) => n.deg > 0);
    for (const n of hubs) {
      const div = document.createElement('div');
      div.className = 'b3-nl';
      div.textContent = n.title;
      wrap.appendChild(div);
      labelEls.push({ el: div, node: n });
    }
    if (labelTimer) clearInterval(labelTimer);
    labelTimer = setInterval(() => {
      if (!visible || !graph || !hubLabelsOn) return;
      for (const it of labelEls) {
        const n = it.node;
        if (n.x == null || !nodeVisible(n) || dimmed(n)) { it.el.style.display = 'none'; continue; }
        const p = graph.graph2ScreenCoords(n.x, n.y, n.z);
        if (!p || p.x < 0 || p.y < 0) { it.el.style.display = 'none'; continue; }
        it.el.style.display = '';
        it.el.style.left = p.x + 'px';
        it.el.style.top = p.y + 'px';
      }
    }, 90);
  }


  // ---- custom Three.js nodes: glowing cores, halos, and hub rings ---------
  let nodeCoreGeo = null, nodeHaloGeo = null, nodeRingGeo = null;
  function ensureNodeGeo() {
    if (typeof THREE === 'undefined') return false;
    if (!nodeCoreGeo) {
      nodeCoreGeo = new THREE.IcosahedronGeometry(1, 2);
      nodeHaloGeo = new THREE.SphereGeometry(1, 18, 12);
      nodeRingGeo = new THREE.TorusGeometry(1, 0.035, 8, 44);
    }
    return true;
  }
  function makeNodeObject(n) {
    if (!ensureNodeGeo()) return null;
    const key = regionKey(n.folder);
    const base = new THREE.Color(regionColor(key));
    const dim = dimmed(n);
    const active = focused ? (n.id === focused.id || neighbors.has(n.id)) : (searchHits ? searchHits.has(n.id) : false);
    const power = active ? 1.35 : 1;
    const scale = (0.72 + Math.min(2.05, Math.sqrt((n.deg || 0) + 1) * 0.2)) * power;
    const group = new THREE.Group();

    const halo = new THREE.Mesh(nodeHaloGeo, new THREE.MeshBasicMaterial({
      color: base,
      transparent: true,
      opacity: dim ? 0.035 : active ? 0.2 : 0.105,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    halo.scale.setScalar(scale * 3.25);
    group.add(halo);

    const core = new THREE.Mesh(nodeCoreGeo, new THREE.MeshBasicMaterial({
      color: dim ? new THREE.Color('#4d5d73') : base,
      transparent: true,
      opacity: dim ? 0.22 : 0.98,
    }));
    core.scale.setScalar(scale);
    group.add(core);

    const glint = new THREE.Mesh(nodeCoreGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: dim ? 0.04 : active ? 0.32 : 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    glint.scale.setScalar(scale * 0.46);
    group.add(glint);

    const ring = new THREE.Mesh(nodeRingGeo, new THREE.MeshBasicMaterial({
      color: active ? '#ffffff' : base,
      transparent: true,
      opacity: dim ? 0.035 : active ? 0.7 : 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    ring.scale.setScalar(scale * (1.45 + Math.min(0.45, (n.deg || 0) * 0.025)));
    ring.rotation.x = Math.PI / 2.6;
    ring.rotation.y = ((n.deg || 0) % 9) * 0.17;
    group.add(ring);

    return group;
  }  // ---- visual predicates ---------------------------------------------------
  const nid = (x) => (typeof x === 'object' ? x.id : x);
  function nodeVisible(n) { return !hiddenRegions.has(regionKey(n.folder)); }
  function dimmed(n) {
    if (focused) return n.id !== focused.id && !neighbors.has(n.id);
    if (searchHits) return !searchHits.has(n.id);
    return false;
  }
  function nodeColor(n) {
    const c = regionColor(regionKey(n.folder));
    return dimmed(n) ? 'rgba(90,110,140,0.18)' : c;
  }
  function linkColor(l) {
    if (focused) {
      const on = nid(l.source) === focused.id || nid(l.target) === focused.id;
      return on ? 'rgba(100,210,255,0.9)' : 'rgba(90,110,140,0.05)';
    }
    if (searchHits) return 'rgba(90,110,140,0.05)';
    return 'rgba(64,180,120,0.28)';
  }
  function restyle() {
    if (!graph) return;
    graph.nodeColor(graph.nodeColor());
    graph.linkColor(graph.linkColor());
    if (graph.nodeThreeObject) graph.nodeThreeObject(makeNodeObject);
  }

  function spinTarget() {
    if (focused && focused.x != null) return { x: focused.x, y: focused.y || 0, z: focused.z || 0 };
    return { x: 0, y: 0, z: 0 };
  }

  function startGraphSpin() {
    if (graphSpinRaf) return;
    graphSpinLast = 0;
    const step = (ts) => {
      graphSpinRaf = requestAnimationFrame(step);
      if (!visible || !graph) return;
      const p = graph.cameraPosition && graph.cameraPosition();
      if (!p) return;
      const target = spinTarget();
      const dt = graphSpinLast ? Math.min(48, ts - graphSpinLast) : 16;
      graphSpinLast = ts;
      const a = dt * 0.000038;
      const dx = p.x - target.x;
      const dz = p.z - target.z;
      const ca = Math.cos(a), sa = Math.sin(a);
      graph.cameraPosition({
        x: target.x + dx * ca - dz * sa,
        y: p.y,
        z: target.z + dx * sa + dz * ca,
      }, target, 0);
    };
    graphSpinRaf = requestAnimationFrame(step);
  }

  function stopGraphSpin() {
    if (!graphSpinRaf) return;
    cancelAnimationFrame(graphSpinRaf);
    graphSpinRaf = 0;
    graphSpinLast = 0;
  }

  // ---- focus ---------------------------------------------------------------
  function focusNode(n, fly = true) {
    focused = n;
    neighbors = new Set();
    for (const l of data.links) {
      if (nid(l.source) === n.id) neighbors.add(nid(l.target));
      else if (nid(l.target) === n.id) neighbors.add(nid(l.source));
    }
    restyle();
    if (fly && graph && n.x != null) {
      const d = 160, r = 1 + d / Math.max(1, Math.hypot(n.x, n.y, n.z));
      graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 1200);
    }
    const box = $id('b3Note');
    box.innerHTML = `<b>${esc(n.title)}</b>\n<span style="opacity:.6">${esc(n.folder || 'root')} · ${n.deg} connections</span>\n\nloading…`;
    AIOS.api.get('/api/vault/note?path=' + encodeURIComponent(n.id))
      .then((j) => {
        const body = (j.content || '').replace(/^---[\s\S]*?---\s*/, '').slice(0, 4000);
        box.innerHTML = `<b>${esc(n.title)}</b>\n<span style="opacity:.6">${esc(n.folder || 'root')} · ${n.deg} connections</span>\n\n${esc(body)}`;
      })
      .catch(() => { box.innerHTML += ' (could not load)'; });
  }
  function clearFocus() {
    focused = null; neighbors = new Set();
    const s = $id('b3Search'); if (s && s.value) { s.value = ''; searchHits = null; }
    restyle();
    const box = $id('b3Note'); if (box) box.textContent = 'Click a node to focus it — only that node and its connections light up, and you can read its note here.';
  }

  // ---- boot ------------------------------------------------------------------
  async function init() {
    if (inited || typeof ForceGraph3D === 'undefined') return;
    const stage = $id('b3Stage');
    if (!stage || !stage.clientWidth) return;
    inited = true;

    let vault;
    try { vault = await AIOS.api.get('/api/vault'); }
    catch { $id('b3Counts').textContent = 'vault unavailable'; inited = false; return; }
    data = { nodes: vault.nodes || [], links: (vault.edges || []).map((e) => ({ ...e })) };
    counts = vault.counts || {};
    $id('b3Counts').textContent = `${counts.notes || data.nodes.length} notes · ${counts.links || data.links.length} connections`;

    graph = ForceGraph3D()(stage)
      .width(stage.clientWidth).height(stage.clientHeight)
      .backgroundColor('#04060c')
      .nodeColor(nodeColor)
      .nodeThreeObject(makeNodeObject)
      .nodeVal((n) => 1.5 + Math.min(14, n.deg * 0.9))
      .nodeOpacity(0.92)
      .nodeVisibility(nodeVisible)
      .nodeLabel((n) => `<div style="font:12px Inter,sans-serif;color:#dce6fb;background:rgba(8,14,26,.9);padding:4px 8px;border-radius:6px;border:1px solid #22314d">${esc(n.title)}<span style="opacity:.55"> · ${esc(regionKey(n.folder) || 'root')}</span></div>`)
      .linkColor(linkColor)
      .linkOpacity(0.5)
      .linkWidth((l) => (focused && (nid(l.source) === focused.id || nid(l.target) === focused.id)) ? 1.2 : 0.4)
      .linkVisibility((l) => { const a = data.nodes.find((n) => n.id === nid(l.source)); const b = data.nodes.find((n) => n.id === nid(l.target)); return (!a || nodeVisible(a)) && (!b || nodeVisible(b)); })
      .linkDirectionalParticles(particlesOn ? 1 : 0)
      .linkDirectionalParticleWidth(1.1)
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleColor(() => 'rgba(64,200,130,0.9)')
      .onNodeClick((n) => focusNode(n))
      .onBackgroundClick(() => clearFocus())
      .graphData(data);

    if (graph.showNavInfo) graph.showNavInfo(false);

    graph.d3Force('charge').strength(-45);
    graph.d3Force('link').distance(40);

    const controls = graph.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
    startGraphSpin();

    buildHubs();
    buildLegend();
    buildHubLabels();
    AIOS.observe(stage, () => { if (graph) { graph.width(stage.clientWidth); graph.height(stage.clientHeight); } });
    // Fit the graph, then dolly in — plain fit lands too far out (Yish had to
    // zoom in every open). 0.6× distance = a fuller, closer galaxy on arrival.
    setTimeout(() => {
      if (!graph) return;
      graph.zoomToFit(700, 40);
      setTimeout(() => {
        if (!graph) return;
        const p = graph.cameraPosition();
        graph.cameraPosition({ x: p.x * 0.6, y: p.y * 0.6, z: p.z * 0.6 }, undefined, 900);
      }, 800);
    }, 1300);
  }

  function buildHubs() {
    const hubs = [...data.nodes].sort((a, b) => b.deg - a.deg).slice(0, 8);
    $id('b3Hubs').innerHTML = hubs.map((n) => `
      <div class="b3-hub" data-hub="${esc(n.id)}">
        <span class="nm"><span class="dot" style="background:${regionColor(regionKey(n.folder))}"></span>${esc(n.title)}</span>
        <span class="ct">${n.deg}</span>
      </div>`).join('');
    $id('b3Hubs').addEventListener('click', (e) => {
      const el = e.target.closest('[data-hub]');
      if (!el) return;
      const n = data.nodes.find((x) => x.id === el.getAttribute('data-hub'));
      if (n) focusNode(n);
    });
  }

  function buildLegend() {
    const byRegion = {};
    for (const n of data.nodes) { const k = regionKey(n.folder); byRegion[k] = (byRegion[k] || 0) + 1; }
    const rows = Object.entries(byRegion).sort((a, b) => b[1] - a[1]).slice(0, 14);
    $id('b3Legend').innerHTML = rows.map(([k, c]) => `
      <div class="b3-leg" data-reg="${esc(k)}">
        <span class="nm"><span class="dot" style="background:${regionColor(k)}"></span>${esc(k || 'root')}</span>
        <span class="ct">${c}</span>
      </div>`).join('');
    $id('b3Legend').addEventListener('click', (e) => {
      const el = e.target.closest('[data-reg]');
      if (!el) return;
      const k = el.getAttribute('data-reg');
      if (hiddenRegions.has(k)) { hiddenRegions.delete(k); el.classList.remove('off'); }
      else { hiddenRegions.add(k); el.classList.add('off'); }
      if (graph) { graph.nodeVisibility(graph.nodeVisibility()); graph.linkVisibility(graph.linkVisibility()); }
    });
  }

  AIOS.registerPage({
    id: 'brain3d',
    title: 'Second Brain',
    sub: 'your whole vault · jarvis inside',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="5" cy="7" r="1.5" fill="currentColor" opacity="0.8"/><circle cx="19" cy="6" r="1.5" fill="currentColor" opacity="0.8"/><circle cx="18" cy="17" r="1.5" fill="currentColor" opacity="0.8"/><circle cx="6" cy="18" r="1.5" fill="currentColor" opacity="0.8"/><path d="M12 12L5 7M12 12l7-6M12 12l6 5M12 12l-6 6" stroke="currentColor" stroke-width="1.2" opacity="0.5"/></svg>',
    mount,
    onShow() { visible = true; if (!inited) setTimeout(init, 50); else if (graph) { graph.resumeAnimation(); startGraphSpin(); } },
    onHide() { visible = false; stopGraphSpin(); if (graph) graph.pauseAnimation(); },
  });
})();
