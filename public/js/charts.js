'use strict';
/*
 * AIOS.charts — dependency-free canvas charts.
 * All charts: DPR-aware, colors read from CSS vars at draw time, resize-redraw
 * via AIOS.observe, first draw animates (skipped under reduced motion),
 * bad/empty data renders a "NO DATA" frame instead of throwing.
 */
(() => {
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const cssVar = (name, fb) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  };
  const C = () => ({
    blue: cssVar('--blue', '#0a84ff'),
    cyan: cssVar('--cyan', '#64d2ff'),
    laser: cssVar('--laser', '#3df2ff'),
    green: cssVar('--green', '#30d158'),
    red: cssVar('--red', '#ff453a'),
    amber: cssVar('--amber', '#ffd60a'),
    dim: cssVar('--dim', '#8da6c5'),
    faint: cssVar('--faint', '#4d617e'),
    line: cssVar('--line', 'rgba(80,170,255,0.14)'),
    text: cssVar('--text', '#e9f3ff'),
  });
  const MONO = '"JetBrains Mono", Consolas, monospace';
  const PALETTE_KEYS = ['blue', 'cyan', 'laser', 'green', 'amber'];
  const PALETTE_EXTRA = ['#7d7aff', '#ff7ab8'];
  const paletteAt = (c, i) => (i < PALETTE_KEYS.length ? c[PALETTE_KEYS[i]] : PALETTE_EXTRA[(i - PALETTE_KEYS.length) % PALETTE_EXTRA.length]);

  function setup(canvas) {
    if (!canvas || !canvas.isConnected) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return null;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width), H = Math.round(r.height);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return { ctx, w: W, h: H };
  }

  function noData(canvas) {
    const s = setup(canvas);
    if (!s) return;
    const c = C();
    s.ctx.font = `10px ${MONO}`;
    s.ctx.fillStyle = c.faint;
    s.ctx.textAlign = 'center';
    s.ctx.textBaseline = 'middle';
    s.ctx.fillText('NO DATA', s.w / 2, s.h / 2);
  }

  // first draw animates; redraws (resize) render the final frame
  function mount(canvas, drawFrame) {
    canvas._chart = { draw: () => drawFrame(1) };
    if (!canvas._aiosObserved) {
      canvas._aiosObserved = true;
      AIOS.observe(canvas, () => { if (canvas._chart) canvas._chart.draw(); });
    }
    if (RM.matches) { drawFrame(1); return; }
    const t0 = performance.now();
    const DUR = 640;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    (function tick(now) {
      const p = Math.min(1, (now - t0) / DUR);
      drawFrame(ease(p));
      if (p < 1 && canvas.isConnected) requestAnimationFrame(tick);
    })(t0);
  }

  // ---- shared tooltip ----
  let tip = null;
  function tipShow(html, x, y) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.style.cssText = 'position:fixed;z-index:90;pointer-events:none;background:rgba(9,15,28,.96);' +
        'border:1px solid rgba(100,210,255,.3);border-radius:8px;padding:6px 10px;' +
        `font:11px ${MONO};color:#e9f3ff;box-shadow:0 10px 28px rgba(0,0,0,.5);white-space:nowrap;`;
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(x + 13, innerWidth - tw - 8) + 'px';
    tip.style.top = Math.max(6, y - th - 11) + 'px';
  }
  function tipHide() { if (tip) tip.style.display = 'none'; }

  // one hover binding per canvas; hit regions live on canvas._hits
  function bindHover(canvas, onHit) {
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hits = canvas._hits || [];
      let found = null;
      for (const h of hits) {
        if (h.shape === 'rect' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { found = h; break; }
        if (h.shape === 'pt' && Math.hypot(x - h.x, y - h.y) <= h.r) { found = h; break; }
        if (h.shape === 'arc') {
          const dx = x - h.cx, dy = y - h.cy;
          const dist = Math.hypot(dx, dy);
          if (dist >= h.r0 && dist <= h.r1) {
            let a = Math.atan2(dy, dx);
            if (a < h.a0) a += Math.PI * 2;
            if (a >= h.a0 && a <= h.a1) { found = h; break; }
          }
        }
      }
      if (found) { tipShow(found.html, e.clientX, e.clientY); onHit && onHit(found); }
      else { tipHide(); onHit && onHit(null); }
    });
    canvas.addEventListener('mouseleave', () => { tipHide(); onHit && onHit(null); });
  }

  const money = (n) => AIOS.fmt.money(n);
  const valStr = (v, isMoney) => (isMoney ? money(v) : AIOS.fmt.num(Math.round(v * 100) / 100));

  // =========================================================================
  const charts = {};

  // ---- sparkline ----
  charts.sparkline = (canvas, values, opts = {}) => {
    if (!Array.isArray(values) || values.length < 2 || values.some((v) => v == null || isNaN(v))) return noData(canvas);
    const draw = (p) => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const color = opts.color || c.cyan;
      const pad = 3;
      const min = Math.min(...values), max = Math.max(...values);
      const span = max - min || 1;
      const n = values.length;
      const px = (i) => pad + (i / (n - 1)) * (s.w - pad * 2);
      const py = (v) => s.h - pad - ((v - min) / span) * (s.h - pad * 2);
      const upto = Math.max(2, Math.ceil(n * p));
      s.ctx.beginPath();
      for (let i = 0; i < upto; i++) i ? s.ctx.lineTo(px(i), py(values[i])) : s.ctx.moveTo(px(0), py(values[0]));
      if (opts.fill !== false) {
        const g = s.ctx.createLinearGradient(0, 0, 0, s.h);
        g.addColorStop(0, color + '44');
        g.addColorStop(1, color + '00');
        s.ctx.save();
        s.ctx.lineTo(px(upto - 1), s.h - pad);
        s.ctx.lineTo(px(0), s.h - pad);
        s.ctx.closePath();
        s.ctx.fillStyle = g;
        s.ctx.fill();
        s.ctx.restore();
        s.ctx.beginPath();
        for (let i = 0; i < upto; i++) i ? s.ctx.lineTo(px(i), py(values[i])) : s.ctx.moveTo(px(0), py(values[0]));
      }
      s.ctx.strokeStyle = color;
      s.ctx.lineWidth = 1.6;
      s.ctx.lineJoin = 'round';
      s.ctx.stroke();
      const li = upto - 1;
      s.ctx.save();
      s.ctx.shadowColor = color;
      s.ctx.shadowBlur = 6;
      s.ctx.fillStyle = color;
      s.ctx.beginPath();
      s.ctx.arc(px(li), py(values[li]), 2.4, 0, Math.PI * 2);
      s.ctx.fill();
      s.ctx.restore();
    };
    mount(canvas, draw);
  };

  // ---- bars ----
  charts.bars = (canvas, items, opts = {}) => {
    if (!Array.isArray(items) || !items.length || items.every((it) => !it || !isFinite(it.value))) return noData(canvas);
    const draw = (p) => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const padB = 18, padT = opts.valueLabels ? 17 : 6, padX = 6;
      const max = Math.max(...items.map((it) => it.value), 1);
      const n = items.length;
      const slot = (s.w - padX * 2) / n;
      const bw = Math.min(slot * 0.58, 46);
      const hits = [];
      s.ctx.strokeStyle = c.line;
      s.ctx.beginPath();
      s.ctx.moveTo(padX, s.h - padB + 0.5);
      s.ctx.lineTo(s.w - padX, s.h - padB + 0.5);
      s.ctx.stroke();
      items.forEach((it, i) => {
        const x = padX + slot * i + (slot - bw) / 2;
        const fullH = ((it.value / max) * (s.h - padB - padT)) || 0;
        const bh = Math.max(1.5, fullH * p);
        const y = s.h - padB - bh;
        const g = s.ctx.createLinearGradient(0, y, 0, s.h - padB);
        const col = it.color || c.blue;
        g.addColorStop(0, it.color || c.cyan);
        g.addColorStop(1, col);
        s.ctx.fillStyle = g;
        const rr = Math.min(4, bw / 2, bh);
        s.ctx.beginPath();
        s.ctx.moveTo(x, s.h - padB);
        s.ctx.lineTo(x, y + rr);
        s.ctx.arcTo(x, y, x + rr, y, rr);
        s.ctx.lineTo(x + bw - rr, y);
        s.ctx.arcTo(x + bw, y, x + bw, y + rr, rr);
        s.ctx.lineTo(x + bw, s.h - padB);
        s.ctx.closePath();
        s.ctx.fill();
        const showEvery = n > 8 ? Math.ceil(n / 8) : 1;
        if (i % showEvery === 0) {
          s.ctx.font = `9px ${MONO}`;
          s.ctx.fillStyle = c.faint;
          s.ctx.textAlign = 'center';
          s.ctx.fillText(String(it.label || ''), x + bw / 2, s.h - 6);
        }
        const disp = it.display != null ? String(it.display) : valStr(it.value, opts.money);
        if (opts.valueLabels && p >= 1 && slot >= 30) {
          s.ctx.font = `600 9px ${MONO}`;
          s.ctx.fillStyle = it.displayColor || c.dim;
          s.ctx.textAlign = 'center';
          s.ctx.fillText(disp, x + bw / 2, Math.max(9, y - 5));
        }
        hits.push({ shape: 'rect', x: padX + slot * i, y: padT, w: slot, h: s.h - padB - padT, html: `${AIOS.util.esc(it.label || '')} — <b>${AIOS.util.esc(disp)}</b>` });
      });
      canvas._hits = hits;
    };
    mount(canvas, draw);
    bindHover(canvas);
  };

  // ---- line (smooth area) ----
  charts.line = (canvas, points, opts = {}) => {
    if (!Array.isArray(points) || points.length < 2 || points.some((pt) => !pt || !isFinite(pt.y))) return noData(canvas);
    const draw = (p) => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const padB = 18, padT = 8, padX = 8;
      const ys = points.map((pt) => pt.y);
      const min = Math.min(...ys, 0), max = Math.max(...ys, 1);
      const span = max - min || 1;
      const n = points.length;
      const px = (i) => padX + (i / (n - 1)) * (s.w - padX * 2);
      const py = (v) => padT + (1 - (v - min) / span) * (s.h - padB - padT);
      // clip for draw-on animation
      s.ctx.save();
      s.ctx.beginPath();
      s.ctx.rect(0, 0, s.w * p, s.h);
      s.ctx.clip();
      // smooth path through midpoints
      const path = () => {
        s.ctx.beginPath();
        s.ctx.moveTo(px(0), py(ys[0]));
        for (let i = 1; i < n; i++) {
          const xc = (px(i - 1) + px(i)) / 2;
          const yc = (py(ys[i - 1]) + py(ys[i])) / 2;
          s.ctx.quadraticCurveTo(px(i - 1), py(ys[i - 1]), xc, yc);
        }
        s.ctx.quadraticCurveTo(px(n - 1), py(ys[n - 1]), px(n - 1), py(ys[n - 1]));
      };
      path();
      s.ctx.lineTo(px(n - 1), s.h - padB);
      s.ctx.lineTo(px(0), s.h - padB);
      s.ctx.closePath();
      const fg = s.ctx.createLinearGradient(0, padT, 0, s.h - padB);
      fg.addColorStop(0, c.blue + '3d');
      fg.addColorStop(1, c.blue + '00');
      s.ctx.fillStyle = fg;
      s.ctx.fill();
      path();
      const sg = s.ctx.createLinearGradient(0, 0, s.w, 0);
      sg.addColorStop(0, c.blue);
      sg.addColorStop(1, c.laser);
      s.ctx.strokeStyle = sg;
      s.ctx.lineWidth = 1.8;
      s.ctx.lineJoin = 'round';
      s.ctx.stroke();
      s.ctx.restore();
      // x labels (sparse)
      s.ctx.font = `9px ${MONO}`;
      s.ctx.fillStyle = c.faint;
      s.ctx.textAlign = 'center';
      const showEvery = Math.ceil(n / 7);
      points.forEach((pt, i) => { if (i % showEvery === 0) s.ctx.fillText(String(pt.x || ''), px(i), s.h - 5); });
      canvas._hits = points.map((pt, i) => ({ shape: 'pt', x: px(i), y: py(pt.y), r: 14, html: `${AIOS.util.esc(String(pt.x || ''))} — <b>${valStr(pt.y, opts.money)}</b>` }));
    };
    mount(canvas, draw);
    bindHover(canvas);
  };

  // ---- donut ----
  charts.donut = (canvas, slices, opts = {}) => {
    const good = Array.isArray(slices) && slices.filter((sl) => sl && sl.value > 0);
    if (!good || !good.length) return noData(canvas);
    let hoverIdx = -1;
    const draw = (p) => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const cx = s.w / 2, cy = s.h / 2;
      const R = Math.min(s.w, s.h) / 2 - 8;
      const r0 = R * 0.62;
      const total = good.reduce((a, sl) => a + sl.value, 0);
      let a = -Math.PI / 2;
      const hits = [];
      good.forEach((sl, i) => {
        const sweep = (sl.value / total) * Math.PI * 2 * p;
        const a1 = a + sweep;
        const rOut = R + (i === hoverIdx ? 4 : 0);
        s.ctx.beginPath();
        s.ctx.arc(cx, cy, rOut, a + 0.012, a1 - 0.012);
        s.ctx.arc(cx, cy, r0, a1 - 0.012, a + 0.012, true);
        s.ctx.closePath();
        s.ctx.fillStyle = sl.color || paletteAt(c, i);
        s.ctx.globalAlpha = i === hoverIdx ? 1 : 0.88;
        s.ctx.fill();
        s.ctx.globalAlpha = 1;
        let h0 = a % (Math.PI * 2), h1 = h0 + sweep;
        hits.push({ shape: 'arc', cx, cy, r0, r1: R + 5, a0: h0, a1: h1, idx: i, html: `${AIOS.util.esc(sl.label || '')} — <b>${opts.money === false ? AIOS.fmt.num(sl.value) : money(sl.value)}</b> (${((sl.value / total) * 100).toFixed(1)}%)` });
        a = a1;
      });
      canvas._hits = hits;
      if (opts.centerLabel || opts.centerValue) {
        s.ctx.textAlign = 'center';
        if (opts.centerValue) {
          s.ctx.font = `600 ${Math.max(13, R * 0.3)}px ${MONO}`;
          s.ctx.fillStyle = c.text;
          s.ctx.textBaseline = 'middle';
          s.ctx.fillText(String(opts.centerValue), cx, cy - (opts.centerLabel ? 7 : 0));
        }
        if (opts.centerLabel) {
          s.ctx.font = `9px ${MONO}`;
          s.ctx.fillStyle = c.faint;
          s.ctx.fillText(String(opts.centerLabel).toUpperCase(), cx, cy + (opts.centerValue ? R * 0.22 : 0));
        }
      }
    };
    mount(canvas, draw);
    bindHover(canvas, (hit) => {
      const ni = hit && hit.idx != null ? hit.idx : -1;
      if (ni !== hoverIdx) { hoverIdx = ni; draw(1); }
    });
  };

  // ---- gauge (270° HUD radial) ----
  charts.gauge = (canvas, pct, opts = {}) => {
    if (pct == null || isNaN(pct)) return noData(canvas);
    const target = Math.max(0, Math.min(1, pct));
    const draw = (p) => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const cx = s.w / 2, cy = s.h / 2 + s.h * 0.04;
      const R = Math.min(s.w, s.h) / 2 - 9;
      const lw = Math.max(5, R * 0.13);
      const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 270° from bottom-left
      // track
      s.ctx.beginPath();
      s.ctx.arc(cx, cy, R, A0, A1);
      s.ctx.strokeStyle = c.line;
      s.ctx.lineWidth = lw;
      s.ctx.lineCap = 'round';
      s.ctx.stroke();
      // ticks
      s.ctx.strokeStyle = c.faint;
      s.ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) {
        const a = A0 + (i / 10) * (A1 - A0);
        const r1 = R - lw * 0.85, r2 = R - lw * 1.45;
        s.ctx.beginPath();
        s.ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        s.ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        s.ctx.globalAlpha = 0.5;
        s.ctx.stroke();
        s.ctx.globalAlpha = 1;
      }
      // progress
      const sweep = target * p;
      if (sweep > 0.001) {
        const aEnd = A0 + sweep * (A1 - A0);
        const grad = s.ctx.createLinearGradient(cx - R, cy, cx + R, cy);
        const col = opts.color;
        if (col) { grad.addColorStop(0, col); grad.addColorStop(1, col); }
        else { grad.addColorStop(0, c.blue); grad.addColorStop(1, c.laser); }
        s.ctx.save();
        s.ctx.shadowColor = col || c.blue;
        s.ctx.shadowBlur = 9;
        s.ctx.beginPath();
        s.ctx.arc(cx, cy, R, A0, aEnd);
        s.ctx.strokeStyle = grad;
        s.ctx.lineWidth = lw;
        s.ctx.lineCap = 'round';
        s.ctx.stroke();
        s.ctx.restore();
      }
      // center value
      s.ctx.textAlign = 'center';
      s.ctx.textBaseline = 'middle';
      s.ctx.font = `700 ${Math.max(13, R * 0.42)}px ${MONO}`;
      s.ctx.fillStyle = c.text;
      const center = opts.value != null ? String(opts.value) : Math.round(target * p * 100) + '%';
      s.ctx.fillText(center, cx, cy - (opts.label ? R * 0.06 : 0));
      if (opts.label) {
        s.ctx.font = `${Math.max(8, R * 0.13)}px ${MONO}`;
        s.ctx.fillStyle = c.faint;
        s.ctx.fillText(String(opts.label).toUpperCase(), cx, cy + R * 0.34);
      }
    };
    mount(canvas, draw);
  };

  // ---- heatmap (calendar) ----
  charts.heatmap = (canvas, days, opts = {}) => {
    if (!Array.isArray(days)) return noData(canvas);
    const weeks = opts.weeks || 13;
    const aheadWeeks = opts.aheadWeeks || 0; // weeks of future to show past this week
    const unit = opts.unit || 'bookings';
    const map = new Map(); // date -> { n, up } (up = upcoming/scheduled, not completed)
    for (const d of days) {
      if (!d || !d.date) continue;
      const e = map.get(d.date) || { n: 0, up: false };
      e.n += (d.count || 0);
      if (d.upcoming) e.up = true;
      map.set(d.date, e);
    }
    const draw = () => {
      const s = setup(canvas);
      if (!s) return;
      const c = C();
      const padL = 16, padT = 14;
      const cell = Math.min((s.w - padL - 4) / weeks, (s.h - padT - 2) / 7);
      const gap = Math.max(1.5, cell * 0.14);
      const sz = cell - gap;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      // end on the Saturday `aheadWeeks` past the current week (room for upcoming)
      const end = new Date(today);
      end.setDate(end.getDate() + (6 - end.getDay()) + aheadWeeks * 7);
      const start = new Date(end);
      start.setDate(start.getDate() - weeks * 7 + 1);
      const maxC = Math.max(1, ...Array.from(map.values(), (e) => e.n));
      const hits = [];
      let lastMonth = -1;
      s.ctx.font = `8.5px ${MONO}`;
      s.ctx.textAlign = 'left';
      for (let wk = 0; wk < weeks; wk++) {
        for (let dow = 0; dow < 7; dow++) {
          const d = new Date(start);
          d.setDate(start.getDate() + wk * 7 + dow);
          const iso = d.toISOString().slice(0, 10);
          const e = map.get(iso) || { n: 0, up: false };
          const n = e.n, future = d > today;
          const x = padL + wk * cell, y = padT + dow * cell;
          if (dow === 0 && d.getMonth() !== lastMonth) {
            lastMonth = d.getMonth();
            s.ctx.fillStyle = c.faint;
            s.ctx.fillText(d.toLocaleDateString([], { month: 'short' }), x, padT - 5);
          }
          if (n === 0) {
            // empty cell — future days get a faint dashed look so the upcoming
            // window reads as "open" rather than missing data
            s.ctx.strokeStyle = c.line;
            s.ctx.lineWidth = 1;
            if (future) s.ctx.setLineDash([2, 2]);
            s.ctx.strokeRect(x + 0.5, y + 0.5, sz - 1, sz - 1);
            s.ctx.setLineDash([]);
          } else {
            const lvl = Math.min(3, Math.floor((n / maxC) * 3.999));
            const alpha = [0.3, 0.55, 0.78, 1][lvl];
            s.ctx.globalAlpha = alpha;
            s.ctx.fillStyle = e.up ? c.amber : (lvl >= 2 ? c.cyan : c.blue);
            s.ctx.beginPath();
            s.ctx.roundRect(x, y, sz, sz, 2);
            s.ctx.fill();
            s.ctx.globalAlpha = 1;
          }
          const label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          hits.push({ shape: 'rect', x, y, w: sz, h: sz, html: `${label} — <b>${n}</b> ${e.up ? 'scheduled' : unit}` });
        }
      }
      // weekday letters
      s.ctx.fillStyle = c.faint;
      s.ctx.textAlign = 'left';
      ['M', 'W', 'F'].forEach((ch, i) => {
        s.ctx.fillText(ch, 3, padT + (1 + i * 2) * cell + sz * 0.75);
      });
      canvas._hits = hits;
    };
    mount(canvas, () => draw()); // grid pop-in not worth animating cell-by-cell
    bindHover(canvas);
  };

  window.AIOS.charts = charts;
})();
