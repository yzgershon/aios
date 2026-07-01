'use strict';
/*
 * AIOS page: brain — Second Brain neural cortex + note reader.
 * v2.2 "genesis": cinematic intro (embryonic cluster → ignition → expansion
 * into an anatomical brain), MEMORY cluster at the core with folder lobes
 * arranged around it, pre-settled physics (no settle spazz on open),
 * inertial smooth camera, view-all / Esc to step back out of a note.
 */
(() => {
  const { esc } = AIOS.util;

  // Regions are keyed by up to TWO folder levels, so categorized subfolders
  // (chats/school, chats/business, daily/aios, …) each become their own lobe
  // instead of collapsing into one giant CHATS / DAILY blob.
  const FOLDER_COLORS = {
    '': '#9aa7bd',
    memory: '#64d2ff',
    projects: '#3df2ff',
    chats: '#0a84ff',
    daily: '#0a84ff',
    references: '#ffd60a',
    decisions: '#ff7ab8',
    templates: '#5ed0c0',
    audits: '#ffd60a',
  };
  const REGION_COLORS = {
    'chats/school': '#64d2ff',
    'chats/business': '#30d158',
    'chats/personal': '#b59cf2',
    'chats/ai-tools': '#3df2ff',
    'daily/aios': '#0a84ff',
    'daily/yddetailers': '#30d158',
    'daily/sessions': '#7f8da3',
    'projects/yddetailers': '#30d158',
    'projects/school': '#64d2ff',
    'projects/personal': '#b59cf2',
    'references': '#ffd60a',
    'decisions': '#ff7ab8',
    'templates': '#5ed0c0',
    'memory': '#64d2ff',
  };
  const topFolder = (f) => (f || '').split('/')[0];
  const regionKey = (f) => {
    const p = (f || '').split('/').filter(Boolean);
    if (!p.length) return '';
    return p.length >= 2 ? p[0] + '/' + p[1] : p[0];
  };
  const regionLabel = (key) => { const p = (key || '').split('/'); return p[p.length - 1] || 'root'; };
  const regionColor = (key) => REGION_COLORS[key] || FOLDER_COLORS[(key || '').split('/')[0]] || '#0a84ff';
  const colorFor = (folder) => regionColor(regionKey(folder));

  const LINK_ACTIVE = 'rgba(100,210,255,0.85)';
  const LINK_DIM = 'rgba(110,150,205,0.04)';
  const LINK_IDLE = 'rgba(110,150,205,0.13)';
  const LABEL_COLOR = '#cfe6ff';
  const SEED_COLOR = '#b59cf2'; // embryonic purple, before regions differentiate

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  let vaultLoaded = false, graphReady = false, visible = false;
  let pendingOpen = null;
  let paused = false, showLabels = true, introPlayed = false;
  const G = {
    nodes: [], links: [], byId: {}, adj: {},
    cam: { x: 0, y: 0, scale: 0.8, tx: 0, ty: 0, tscale: 0.8 },
    alpha: 1, raf: 0, hover: null, sel: null, drag: null, panning: false,
    last: null, moved: 0, canvas: null, ctx: null, dpr: 1, W: 0, H: 0,
    search: '', lastT: 0,
  };

  const $id = (id) => document.getElementById(id);

  // ---- glow sprites (one per color, pre-rendered — no per-frame shadowBlur) ----
  const spriteCache = {};
  function glowSprite(col) {
    if (spriteCache[col]) return spriteCache[col];
    const s = document.createElement('canvas');
    s.width = s.height = 64;
    const x = s.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.16, col);
    g.addColorStop(0.42, col + '55');
    g.addColorStop(1, col + '00');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    spriteCache[col] = s;
    return s;
  }

  // ---- synapse pulses ----
  const pulses = [];
  let nextPulseAt = 0;
  let fireLog = []; // timestamps of completed firings (for the HUD rate)
  function adjLinks(node) { return G.links.filter((l) => l.a === node || l.b === node); }
  function spawnPulse(now, fromLink, fromNode) {
    if (!G.links.length || pulses.length >= 14) return;
    let l = fromLink, rev = false;
    if (!l) {
      l = G.links[(Math.random() * G.links.length) | 0];
      rev = Math.random() < 0.5;
    } else {
      rev = l.a === fromNode ? false : true; // travel away from the chain source
    }
    const src = rev ? l.b : l.a;
    pulses.push({ l, rev, t: 0, dur: 650 + Math.random() * 850, col: colorFor(src.folder) });
  }
  function stepPulses(dt, now) {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        const target = p.rev ? p.l.a : p.l.b;
        target.flash = 1;
        fireLog.push(now);
        // chain: 30% chance the firing propagates down a random adjacent synapse
        if (Math.random() < 0.3) {
          const outs = adjLinks(target).filter((l) => l !== p.l);
          if (outs.length) spawnPulse(now, outs[(Math.random() * outs.length) | 0], target);
        }
        pulses.splice(i, 1);
      }
    }
    if (now > nextPulseAt) {
      spawnPulse(now);
      nextPulseAt = now + 150 + Math.random() * 320;
    }
    if (fireLog.length > 200) fireLog = fireLog.filter((t) => now - t < 10000);
  }

  // quadratic-bezier helpers for curved links
  function linkGeom(l) {
    const [ax, ay] = w2s(l.a.x, l.a.y), [bx, by] = w2s(l.b.x, l.b.y);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const off = l.curve * G.cam.scale;
    return { ax, ay, bx, by, cx: mx + (-dy / len) * off, cy: my + (dx / len) * off };
  }
  const qPoint = (g, t) => [
    (1 - t) * (1 - t) * g.ax + 2 * (1 - t) * t * g.cx + t * t * g.bx,
    (1 - t) * (1 - t) * g.ay + 2 * (1 - t) * t * g.cy + t * t * g.by,
  ];

  // ---- regions (folder clusters) ----
  let regions = [];
  let nextRegionCalc = 0;
  function calcRegions(now, force) {
    if (!force && now < nextRegionCalc) return;
    nextRegionCalc = now + 600;
    const acc = {};
    for (const n of G.nodes) {
      const f = regionKey(n.folder);
      (acc[f] = acc[f] || { x: 0, y: 0, n: 0, f }).x += n.x;
      acc[f].y += n.y;
      acc[f].n++;
    }
    regions = Object.values(acc)
      .filter((r) => r.n >= 2)
      .map((r) => ({ f: r.f, label: regionLabel(r.f), x: r.x / r.n, y: r.y / r.n, n: r.n, col: regionColor(r.f) }));
  }

  let vaultLoading = false;
  async function loadVault(force) {
    if ((vaultLoaded && !force) || vaultLoading) { enterGraph(); return; }
    vaultLoading = true;
    try {
      const data = await AIOS.api.get('/api/vault');
      buildGraph(data);
      vaultLoaded = true;
      if (pendingOpen) { const p = pendingOpen; pendingOpen = null; introPlayed = true; openByPath(p); }
    } catch (e) {
      $id('graphHud').textContent = 'VAULT UNAVAILABLE';
      $id('graphEmpty').textContent = 'Could not read the vault.';
    }
    vaultLoading = false;
    enterGraph();
  }

  // ---- anatomical layout: MEMORY at the core, other folders as lobes around it ----
  function buildGraph(data) {
    const list = data.nodes || [];
    const groups = {};
    for (const n of list) { const f = regionKey(n.folder); (groups[f] = groups[f] || []).push(n); }
    const clusterR = (arr) => 16 * Math.sqrt(arr.length) + 28;
    const core = groups.memory ? 'memory' : Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)[0] || '';
    const lobes = Object.keys(groups).filter((f) => f !== core).sort((a, b) => groups[b].length - groups[a].length);
    const anchors = {}; anchors[core] = { x: 0, y: 0 };
    const baseR = clusterR(groups[core] || []);
    // interleave angle slots so the biggest lobes sit opposite each other
    let lo = 0, hi = Math.ceil(lobes.length / 2);
    lobes.forEach((f, i) => {
      const slot = (i % 2 === 0) ? lo++ : hi++;
      const a = -Math.PI / 2 + (slot / Math.max(1, lobes.length)) * Math.PI * 2;
      const r = baseR + clusterR(groups[f]) + 185;
      anchors[f] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    // phyllotaxis inside each lobe — organic spiral packing
    const GOLD = 2.399963;
    const nodes = [];
    for (const f of Object.keys(groups)) {
      const anc = anchors[f] || anchors[core];
      groups[f].forEach((n, i) => {
        const rr = 13.5 * Math.sqrt(i + 0.5), th = i * GOLD + f.length * 1.7;
        nodes.push(Object.assign({}, n, {
          anc, x: anc.x + Math.cos(th) * rr, y: anc.y + Math.sin(th) * rr,
          vx: 0, vy: 0, fx: 0, fy: 0, flash: 0, r: 5 + Math.min(16, n.deg * 2.3),
        }));
      });
    }
    G.byId = {}; nodes.forEach((n) => { G.byId[n.id] = n; });
    G.adj = {}; nodes.forEach((n) => { G.adj[n.id] = new Set(); });
    let ci = 0;
    G.links = (data.edges || []).filter((e) => G.byId[e.source] && G.byId[e.target]).map((e) => {
      G.adj[e.source].add(e.target); G.adj[e.target].add(e.source);
      const a = G.byId[e.source], b = G.byId[e.target];
      return {
        a, b,
        cross: regionKey(a.folder) !== regionKey(b.folder),
        curve: ((ci++ % 2) ? 1 : -1) * (5 + (ci * 7) % 14),
        born: Math.random() * 0.7, // stagger for the intro draw-in
      };
    });
    G.nodes = nodes; G.sel = null;
    pulses.length = 0; fireLog = [];
    // pre-settle off-screen so the page never opens mid-spazz
    G.alpha = 1;
    for (let i = 0; i < 260; i++) physics(true);
    G.alpha = 0.05;
    // goals (settled brain) + intro seeds (tight embryonic ball)
    for (const n of G.nodes) {
      n.gx = n.x; n.gy = n.y;
      const a = Math.random() * Math.PI * 2, rr = 14 + Math.random() * 96;
      n.ix = Math.cos(a) * rr * 1.25; n.iy = Math.sin(a) * rr * 0.85;
    }
    calcRegions(performance.now(), true);
    updateHud(data.counts || {});
    $id('graphEmpty').textContent = nodes.length ? '' : 'No notes found in the vault.';
  }

  function updateHud(counts) {
    const hud = $id('graphHud');
    if (!hud) return;
    const n = counts.notes || G.nodes.length, m = counts.links || G.links.length;
    const now = performance.now();
    const rate = (fireLog.filter((t) => now - t < 10000).length / 10).toFixed(1);
    hud.innerHTML = G.nodes.length
      ? `<span class="hud-name">SECONDBRAIN</span> ${n} NEURONS · ${m} SYNAPSES · ${regions.length || '—'} REGIONS <span class="hud-fire">· FIRING ${rate}/s</span>`
      : '';
  }
  let nextHud = 0;

  function sizeCanvas() {
    const cv = G.canvas; if (!cv) return;
    const rect = cv.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    G.dpr = window.devicePixelRatio || 1; G.W = rect.width; G.H = rect.height;
    cv.width = Math.round(G.W * G.dpr); cv.height = Math.round(G.H * G.dpr);
    cv.style.width = G.W + 'px'; cv.style.height = G.H + 'px';
    G.ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  }
  function w2s(wx, wy) { return [(wx - G.cam.x) * G.cam.scale + G.W / 2, (wy - G.cam.y) * G.cam.scale + G.H / 2]; }
  function s2w(sx, sy) { return [(sx - G.W / 2) / G.cam.scale + G.cam.x, (sy - G.H / 2) / G.cam.scale + G.cam.y]; }

  function bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of G.nodes) { if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y; }
    return { x0, y0, x1, y1 };
  }
  function fitView(instant) {
    if (!G.nodes.length || !G.W) return;
    const b = bounds();
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const s = clamp(Math.min(G.W / (b.x1 - b.x0 + 170), G.H / (b.y1 - b.y0 + 170)), 0.15, 1.5);
    G.cam.tx = cx; G.cam.ty = cy; G.cam.tscale = s;
    if (instant) { G.cam.x = cx; G.cam.y = cy; G.cam.scale = s; }
    return { cx, cy, s };
  }

  function physics(force) {
    if (!force && G.alpha < 0.02 && !G.drag) return;
    G.alpha *= 0.987;
    const N = G.nodes, n = N.length, rep = 3400;
    for (let i = 0; i < n; i++) { N[i].fx = 0; N[i].fy = 0; }
    for (let i = 0; i < n; i++) {
      const a = N[i];
      for (let j = i + 1; j < n; j++) {
        const b = N[j]; let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
        if (d2 > 96100) continue; // repulsion horizon 310px — lobes don't shove each other
        const d = Math.sqrt(d2), f = rep / d2, fx = (dx / d) * f, fy = (dy / d) * f;
        a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
      }
    }
    for (const l of G.links) {
      let dx = l.b.x - l.a.x, dy = l.b.y - l.a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // cross-lobe synapses are long + loose so they don't drag regions together
      const f = l.cross ? (d - 300) * 0.0045 : (d - 115) * 0.04;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.a.fx += fx; l.a.fy += fy; l.b.fx -= fx; l.b.fy -= fy;
    }
    for (let i = 0; i < n; i++) {
      const p = N[i];
      // anchor pull keeps every neuron inside its region — the anatomy holds
      p.fx += (p.anc.x - p.x) * 0.03; p.fy += (p.anc.y - p.y) * 0.03;
      if (G.drag === p) continue;
      p.vx = (p.vx + p.fx * G.alpha) * 0.82; p.vy = (p.vy + p.fy * G.alpha) * 0.82;
      p.x += p.vx; p.y += p.vy;
    }
  }

  // ---- cinematic intro ----------------------------------------------------
  // 0–1.45s embryonic purple ball swirls · 1.45s ignition flash ·
  // 1.7–3.5s neurons fly out to their regions, colors differentiate,
  // camera pulls back · 3.5–4.3s labels + HUD fade in.
  let intro = null;
  const IN = { igniteAt: 1450, expandA: 1700, expandB: 3500, end: 4300 };
  function startIntro() {
    if (!G.nodes.length || !G.W) return;
    G.sel = null; closeNote(false);
    pulses.length = 0;
    const fit = fitView(false) || { cx: 0, cy: 0, s: 0.8 };
    intro = { t0: performance.now(), fit };
    G.cam.x = G.cam.tx = 0; G.cam.y = G.cam.ty = 0;
    G.cam.scale = G.cam.tscale = Math.min(1.6, fit.s * 2.4);
    intro.s0 = G.cam.scale;
    const hud = $id('graphHud'); if (hud) hud.style.opacity = '0';
  }
  function skipIntro() { if (intro) intro.t0 = performance.now() - IN.end; }
  function introFinish() {
    intro = null;
    const hud = $id('graphHud'); if (hud) hud.style.opacity = '';
    for (const n of G.nodes) { n.x = n.gx; n.y = n.gy; n.vx = 0; n.vy = 0; }
    fitView(true);
    G.alpha = 0.05;
    for (let i = 0; i < 9; i++) spawnPulse(performance.now());
    calcRegions(performance.now(), true);
  }
  function introFrame(now) {
    const el = now - intro.t0;
    if (el >= IN.end) { introFinish(); return null; }
    const swirl = el * 0.00042;
    const k = easeIO(clamp((el - IN.expandA) / (IN.expandB - IN.expandA), 0, 1));
    const cos = Math.cos(swirl), sin = Math.sin(swirl);
    for (const n of G.nodes) {
      const rx = n.ix * cos - n.iy * sin, ry = n.ix * sin + n.iy * cos;
      // breathing while embryonic
      const br = 1 + Math.sin(el * 0.0023 + n.ix) * 0.05 * (1 - k);
      n.x = lerp(rx * br, n.gx, k); n.y = lerp(ry * br, n.gy, k);
    }
    // camera pulls back as the brain unfolds
    const ck = easeIO(clamp((el - IN.igniteAt) / (IN.end - IN.igniteAt), 0, 1));
    G.cam.scale = G.cam.tscale = lerp(intro.s0, intro.fit.s, ck);
    G.cam.x = G.cam.tx = lerp(0, intro.fit.cx, ck);
    G.cam.y = G.cam.ty = lerp(0, intro.fit.cy, ck);
    if (k > 0.5) calcRegions(now, true);
    return {
      mix: 1 - k, // 1 = all purple, 0 = full folder colors
      linkProg: clamp((el - 1300) / 2000, 0, 1),
      flash: Math.max(0, 1 - Math.abs(el - IN.igniteAt - 120) / 380),
      title: clamp(el / 550, 0, 1) * clamp(1 - (el - 2050) / 520, 0, 1),
      labels: clamp((el - IN.expandB) / 650, 0, 1),
      el,
    };
  }

  function graphRender(iv) {
    const ctx = G.ctx; if (!ctx) return;
    ctx.clearRect(0, 0, G.W, G.H);
    const hi = iv ? null : (G.hover || G.sel), nbr = hi ? G.adj[hi.id] : null;
    const labelA = iv ? iv.labels : 1;

    // synapses — curved, faint, brighter around the highlighted node
    ctx.lineWidth = 1;
    for (const l of G.links) {
      let la = 1;
      if (iv) { la = clamp((iv.linkProg - l.born) * 3.2, 0, 1); if (la <= 0.01) continue; }
      const active = hi && (l.a === hi || l.b === hi);
      const g = linkGeom(l);
      ctx.globalAlpha = la;
      ctx.strokeStyle = active ? LINK_ACTIVE : (hi ? LINK_DIM : LINK_IDLE);
      ctx.beginPath();
      ctx.moveTo(g.ax, g.ay);
      ctx.quadraticCurveTo(g.cx, g.cy, g.bx, g.by);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // travelling pulses
    for (const p of pulses) {
      const g = linkGeom(p.l);
      const t = p.rev ? 1 - p.t : p.t;
      const [px, py] = qPoint(g, t);
      const s = glowSprite(p.col);
      const sz = 16 * Math.min(1.4, Math.max(0.7, G.cam.scale));
      ctx.globalAlpha = 0.95;
      ctx.drawImage(s, px - sz / 2, py - sz / 2, sz, sz);
      const [tx, ty] = qPoint(g, Math.max(0, Math.min(1, t + (p.rev ? 0.05 : -0.05))));
      ctx.globalAlpha = 0.4;
      ctx.drawImage(s, tx - sz / 3, ty - sz / 3, sz / 1.5, sz / 1.5);
      ctx.globalAlpha = 1;
    }

    // neurons — glow halo sprite + bright core; purple→folder color during intro
    const seedSprite = glowSprite(SEED_COLOR);
    for (const p of G.nodes) {
      const [sx, sy] = w2s(p.x, p.y), r = Math.max(2.5, p.r * G.cam.scale);
      const isHi = p === hi, isNbr = nbr && nbr.has(p.id), match = !iv && G.search && p.title.toLowerCase().includes(G.search);
      const dim = (hi && !isHi && !isNbr) || (G.search && !iv && !match);
      const col = colorFor(p.folder);
      const s = glowSprite(col);
      const flash = p.flash || 0;
      if (flash > 0.01) p.flash *= 0.93;
      const halo = r * (4.6 + flash * 3) * (isHi || match ? 1.35 : 1);
      const baseA = dim ? 0.08 : Math.min(1, 0.55 + flash * 0.45 + (isHi || match ? 0.25 : 0));
      const coreSz = r * 1.7;
      if (iv && iv.mix > 0.01) {
        ctx.globalAlpha = baseA * iv.mix;
        ctx.drawImage(seedSprite, sx - halo / 2, sy - halo / 2, halo, halo);
        ctx.globalAlpha = iv.mix;
        ctx.drawImage(seedSprite, sx - coreSz / 2, sy - coreSz / 2, coreSz, coreSz);
      }
      const cm = iv ? 1 - iv.mix : 1;
      if (cm > 0.01) {
        ctx.globalAlpha = baseA * cm;
        ctx.drawImage(s, sx - halo / 2, sy - halo / 2, halo, halo);
        ctx.globalAlpha = (dim ? 0.18 : 1) * cm;
        ctx.drawImage(s, sx - coreSz / 2, sy - coreSz / 2, coreSz, coreSz);
      }
      if (!iv && showLabels && (isHi || isNbr || match || p === G.sel || (G.cam.scale > 1.05 && p.deg > 2))) {
        ctx.globalAlpha = dim ? 0.3 : 0.95;
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.title.length > 24 ? p.title.slice(0, 23) + '…' : p.title, sx, sy + r + 12);
      }
    }
    ctx.globalAlpha = 1;

    // region labels (folder clusters), KRONOS-style
    if (showLabels && !hi && !G.search && labelA > 0.01) {
      ctx.textAlign = 'center';
      for (const rg of regions) {
        const [sx, sy] = w2s(rg.x, rg.y);
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.fillStyle = rg.col;
        ctx.globalAlpha = 0.85 * labelA;
        ctx.fillText((rg.label || rg.f).toUpperCase(), sx, sy - 8);
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillStyle = LABEL_COLOR;
        ctx.globalAlpha = 0.55 * labelA;
        ctx.fillText(rg.n + ' NOTES', sx, sy + 5);
      }
      ctx.globalAlpha = 1;
    }

    // intro overlays: ignition flash + title card
    if (iv) {
      if (iv.flash > 0.01) {
        const [fx, fy] = w2s(0, 0);
        const fr = Math.max(G.W, G.H) * 0.55;
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
        fg.addColorStop(0, `rgba(220,245,255,${0.62 * iv.flash})`);
        fg.addColorStop(0.35, `rgba(100,210,255,${0.3 * iv.flash})`);
        fg.addColorStop(1, 'rgba(100,210,255,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, G.W, G.H);
      }
      if (iv.title > 0.01) {
        ctx.textAlign = 'center';
        ctx.globalAlpha = iv.title;
        ctx.fillStyle = '#eaf6ff';
        ctx.font = '600 30px "Space Grotesk", sans-serif';
        ctx.fillText('S E C O N D B R A I N', G.W / 2, G.H / 2 - 130);
        ctx.fillStyle = 'rgba(100,210,255,0.9)';
        ctx.font = '10px "JetBrains Mono", monospace';
        const dots = '.'.repeat(1 + (Math.floor(iv.el / 350) % 3));
        ctx.fillText((iv.el < IN.igniteAt ? 'SEEDING NEURONS' : 'DIFFERENTIATING REGIONS') + dots, G.W / 2, G.H / 2 - 108);
        ctx.globalAlpha = 1;
      }
    }
  }

  function tick(now) {
    if (!visible) { G.raf = 0; return; }
    const dt = G.lastT ? Math.min(64, now - G.lastT) : 16;
    G.lastT = now;
    let iv = null;
    if (intro) {
      iv = introFrame(now);
    } else {
      // inertial camera glide toward target
      const c = G.cam;
      c.x += (c.tx - c.x) * 0.16; c.y += (c.ty - c.y) * 0.16;
      c.scale += (c.tscale - c.scale) * 0.16;
      if (!paused) {
        physics();
        stepPulses(dt, now);
        calcRegions(now);
      }
    }
    graphRender(iv);
    if (now > nextHud) { updateHud({}); nextHud = now + 1000; }
    G.raf = requestAnimationFrame(tick);
  }

  function nodeAt(sx, sy) {
    for (let i = G.nodes.length - 1; i >= 0; i--) {
      const p = G.nodes[i], [px, py] = w2s(p.x, p.y), r = Math.max(7, p.r * G.cam.scale + 4);
      if ((sx - px) ** 2 + (sy - py) ** 2 <= r * r) return p;
    }
    return null;
  }

  function focusNode(p) {
    G.cam.tx = p.x; G.cam.ty = p.y;
    G.cam.tscale = Math.max(G.cam.tscale, 1.5);
  }

  function closeNote(fit) {
    G.sel = null;
    const doc = $id('noteDoc'), empty = $id('noteEmpty');
    if (doc) doc.hidden = true;
    if (empty) empty.hidden = false;
    if (fit) fitView(false);
  }

  function bestMatch(q) {
    if (!q) return null;
    const hits = G.nodes.filter((n) => n.title.toLowerCase().includes(q));
    if (!hits.length) return null;
    hits.sort((a, b) => {
      const as = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || b.deg - a.deg;
    });
    return hits[0];
  }

  function initGraphOnce() {
    if (graphReady) return; graphReady = true;
    G.canvas = $id('graphCanvas'); G.ctx = G.canvas.getContext('2d');
    const cv = G.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (intro) { skipIntro(); return; }
      try { cv.setPointerCapture(e.pointerId); } catch { /* no capture */ }
      const p = nodeAt(e.offsetX, e.offsetY); G.moved = 0; G.last = { x: e.offsetX, y: e.offsetY };
      if (p) { G.drag = p; G.alpha = Math.max(G.alpha, 0.3); } else { G.panning = true; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (intro) return;
      if (G.drag) { const [wx, wy] = s2w(e.offsetX, e.offsetY); G.drag.x = wx; G.drag.y = wy; G.drag.vx = 0; G.drag.vy = 0; G.moved += 5; }
      else if (G.panning) {
        const dx = (e.offsetX - G.last.x) / G.cam.scale, dy = (e.offsetY - G.last.y) / G.cam.scale;
        G.cam.x -= dx; G.cam.y -= dy; G.cam.tx = G.cam.x; G.cam.ty = G.cam.y;
        G.moved += Math.abs(e.offsetX - G.last.x) + Math.abs(e.offsetY - G.last.y);
        G.last = { x: e.offsetX, y: e.offsetY };
      }
      else { G.hover = nodeAt(e.offsetX, e.offsetY); cv.style.cursor = G.hover ? 'pointer' : 'grab'; }
    });
    const end = (e) => {
      if (intro) return;
      if (G.drag && G.moved < 6) openNote(G.drag);
      else if (G.panning && G.moved < 6) { const p = nodeAt(e.offsetX, e.offsetY); if (p) openNote(p); }
      G.drag = null; G.panning = false;
    };
    cv.addEventListener('pointerup', end);
    // smooth zoom: exponential factor on the target scale, camera glides there;
    // anchor the world point under the cursor
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (intro) return;
      const f = Math.exp(-e.deltaY * 0.0012);
      const ns = clamp(G.cam.tscale * f, 0.15, 5);
      const wx = (e.offsetX - G.W / 2) / G.cam.tscale + G.cam.tx;
      const wy = (e.offsetY - G.H / 2) / G.cam.tscale + G.cam.ty;
      G.cam.tx = wx - (e.offsetX - G.W / 2) / ns;
      G.cam.ty = wy - (e.offsetY - G.H / 2) / ns;
      G.cam.tscale = ns;
    }, { passive: false });

    $id('graphReset').addEventListener('click', () => { if (!intro) { closeNote(false); fitView(false); } });
    $id('graphIntro').addEventListener('click', () => { if (!intro && G.nodes.length) startIntro(); });
    $id('graphPause').addEventListener('click', () => {
      paused = !paused;
      $id('graphPause').textContent = paused ? '▶ resume' : '⏸ pause';
      $id('graphPause').classList.toggle('active', paused);
    });
    $id('graphLabels').addEventListener('click', () => {
      showLabels = !showLabels;
      $id('graphLabels').classList.toggle('active', !showLabels);
      $id('graphLabels').textContent = showLabels ? 'hide labels' : 'show labels';
    });
    $id('graphSearch').addEventListener('input', (e) => { G.search = e.target.value.trim().toLowerCase(); });
    $id('graphSearch').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const hit = bestMatch(G.search);
      if (hit) { G.sel = hit; focusNode(hit); openNote(hit); }
    });
    $id('noteBack').addEventListener('click', () => closeNote(true));
    document.addEventListener('keydown', (e) => {
      if (!visible || e.key !== 'Escape') return;
      if (intro) { skipIntro(); return; }
      if (G.sel) closeNote(true);
    });
    $id('noteBody').addEventListener('click', (e) => {
      const wl = e.target.closest('.wikilink'); if (!wl) return;
      const t = (wl.getAttribute('data-link') || '').toLowerCase();
      const node = G.nodes.find((n) => n.title.toLowerCase() === t);
      if (node) { G.sel = node; focusNode(node); openNote(node); }
    });
  }

  function enterGraph() {
    initGraphOnce();
    requestAnimationFrame(() => {
      sizeCanvas();
      if (vaultLoaded && G.nodes.length && !introPlayed) { introPlayed = true; startIntro(); }
      else if (vaultLoaded && G.nodes.length && !intro && !G.sel) fitView(true);
      if (visible && !G.raf) { G.lastT = 0; G.raf = requestAnimationFrame(tick); }
    });
  }

  async function openNote(p) {
    G.sel = p;
    $id('noteEmpty').hidden = true; $id('noteDoc').hidden = false;
    $id('noteTitle').textContent = p.title; $id('notePath').textContent = p.id;
    $id('noteBody').innerHTML = '<p class="muted">loading…</p>';
    try {
      const data = await AIOS.api.get('/api/vault/note?path=' + encodeURIComponent(p.id));
      $id('noteBody').innerHTML = data.content ? mdToHtml(data.content) : '<p class="muted">empty note</p>';
    } catch { $id('noteBody').innerHTML = '<p class="muted">could not load note</p>'; }
  }

  function openByPath(path) {
    const q = String(path || '');
    const node = G.byId[q]
      || G.nodes.find((n) => n.id.toLowerCase() === q.toLowerCase())
      || G.nodes.find((n) => n.title.toLowerCase() === q.toLowerCase());
    if (node) { if (intro) introFinish(); G.sel = node; focusNode(node); openNote(node); }
    else AIOS.toast('Note not found: ' + q, 'err');
  }

  function mdToHtml(md) {
    const lines = String(md).replace(/\r/g, '').split('\n');
    let html = '', inList = false, inCode = false;
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => `<span class="wikilink" data-link="${esc(a.trim())}">${esc((b || a).trim())}</span>`)
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    for (const raw of lines) {
      if (/^```/.test(raw)) { if (inCode) { html += '</pre>'; inCode = false; } else { html += '<pre>'; inCode = true; } continue; }
      if (inCode) { html += esc(raw) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(raw)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(raw.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const h = raw.match(/^(#{1,6})\s+(.*)/);
      if (h) { const lv = Math.min(3, h[1].length); html += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }
      if (/^\s*$/.test(raw)) continue;
      if (/^>\s?/.test(raw)) { html += '<blockquote>' + inline(raw.replace(/^>\s?/, '')) + '</blockquote>'; continue; }
      if (/^(-{3,}|\*{3,})\s*$/.test(raw)) { html += '<hr>'; continue; }
      html += '<p>' + inline(raw) + '</p>';
    }
    if (inList) html += '</ul>'; if (inCode) html += '</pre>';
    return html;
  }

  function mount(el) {
    el.classList.add('page-graph');
    el.innerHTML = `
      <div class="graph-wrap">
        <div class="graph-hud" id="graphHud"></div>
        <div class="graph-toolbar">
          <input id="graphSearch" class="graph-search" placeholder="Search notes…" autocomplete="off" spellcheck="false" />
          <button class="graph-btn" id="graphPause" title="Pause the simulation">⏸ pause</button>
          <button class="graph-btn" id="graphReset" title="Fit the whole brain in view">⌖ view all</button>
          <button class="graph-btn" id="graphLabels" title="Toggle labels">hide labels</button>
          <button class="graph-btn" id="graphIntro" title="Replay the intro">⟳ intro</button>
        </div>
        <canvas id="graphCanvas"></canvas>
        <div class="graph-empty" id="graphEmpty"></div>
      </div>
      <aside class="note-panel" id="notePanel">
        <div class="note-empty" id="noteEmpty"><span class="empty-title">Second Brain</span><p>Click a neuron to open the note. Scroll to zoom, drag to pan, Esc or “view all” to step back out.</p></div>
        <div class="note-doc" id="noteDoc" hidden>
          <button class="graph-btn note-back" id="noteBack">← view all</button>
          <div class="note-head"><h2 id="noteTitle"></h2><span class="note-path" id="notePath"></span></div>
          <div class="note-body" id="noteBody"></div>
        </div>
      </aside>`;
    AIOS.observe(el.querySelector('.graph-wrap'), () => { if (visible && graphReady) sizeCanvas(); });
  }

  AIOS.bus.on('brain.open', (payload) => {
    const path = payload && payload.path;
    if (!path) return;
    AIOS.showPage('brain');
    if (!vaultLoaded) { pendingOpen = path; loadVault(); return; }
    openByPath(path);
  });

  AIOS.registerPage({
    id: 'brain',
    title: 'Second Brain',
    sub: 'C:\\Dev\\SecondBrain · neural cortex',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="6" cy="7" r="2.2" fill="currentColor"/><circle cx="18" cy="9" r="2.2" fill="currentColor"/><circle cx="9.5" cy="17" r="2.7" fill="currentColor"/><circle cx="17" cy="17.5" r="1.7" fill="currentColor"/><path d="M7.7 8.4l1.4 6.2M8.9 7.4l7 1.2M16.4 10.7l-5.1 4.6M11.6 17.2l3.8.2" stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.65"/></svg>',
    mount,
    onShow() {
      visible = true;
      loadVault();
    },
    onHide() {
      visible = false;
      if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    },
  });
})();
