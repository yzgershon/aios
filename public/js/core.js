'use strict';
/*
 * AIOS core — global namespace, page registry, data polling, event bus,
 * formatters, modal/toast helpers. Loads before every other AIOS script.
 */
(() => {
  const LS_UI = 'aios.ui.v2';
  const DATA_POLL_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  // ---- persisted ui prefs ----
  let ui = { privacy: false, muted: false };
  try { ui = Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI) || '{}')); } catch { /* fresh */ }
  const saveUi = () => { try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch { /* full */ } };

  // ---- event bus ----
  const handlers = new Map();
  const bus = {
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); },
    off(evt, fn) { const s = handlers.get(evt); if (s) s.delete(fn); },
    emit(evt, payload) {
      const s = handlers.get(evt);
      if (!s) return;
      for (const fn of [...s]) { try { fn(payload); } catch (e) { console.error(`bus:${evt}`, e); } }
    },
  };

  // ---- service stubs (os.js replaces these via AIOS._implement and drains the queue) ----
  const queues = { notify: [], sound: [], registerCommand: [] };
  const stub = (name) => (...args) => { queues[name].push(args); };

  // ---- fetch helpers ----
  const api = {
    async get(path) {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
      return r.json();
    },
    async post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
      return r.json().catch(() => ({}));
    },
  };

  // ---- formatters ----
  const fmt = {
    money(n, { sign = false, dp } = {}) {
      if (n == null || isNaN(n)) return '—';
      const neg = n < 0;
      const abs = Math.abs(n);
      const digits = dp != null ? dp : (abs < 100 && abs !== Math.round(abs) ? 2 : 0);
      const body = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      return neg ? '−' + body : (sign ? '+' + body : body);
    },
    compact(n) {
      if (n == null || isNaN(n)) return '—';
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
      if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
      return String(Math.round(n));
    },
    num(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US'); },
    pct(n, { sign = false, dp = 1 } = {}) {
      if (n == null || isNaN(n)) return '—';
      const s = n > 0 && sign ? '+' : '';
      return s + Number(n).toFixed(dp) + '%';
    },
    date(d) { return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }); },
    time(d) { return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    ago(ts) {
      const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
  };

  // ---- shared dom/string utilities (ported semantics from v1 app.js) ----
  const util = {
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    safeUrl(u) {
      try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; }
      catch { return null; }
    },
    fmtDuration(sec) {
      if (sec == null || isNaN(sec)) return '';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    },
    emptyState(title, body, ctaText, ctaHref) {
      const cta = ctaText
        ? (ctaHref
            ? `<a class="empty-cta" href="${util.esc(ctaHref)}" target="_blank" rel="noopener">${util.esc(ctaText)}</a>`
            : `<span class="empty-cta">${util.esc(ctaText)}</span>`)
        : '';
      return `<div class="empty"><span class="empty-title">${util.esc(title)}</span><p class="empty-body">${util.esc(body)}</p>${cta}</div>`;
    },
  };

  // ---- pages ----
  const pages = [];
  let currentPage = null;
  let mounted = false;

  function buildNav() {
    const nav = $('sideNav');
    if (!nav) return;
    nav.innerHTML = '';
    for (const p of pages) {
      const b = document.createElement('button');
      b.className = 'side-item';
      b.dataset.page = p.id;
      b.title = p.title;
      b.innerHTML = p.icon || '';
      b.addEventListener('click', () => { AIOS.showPage(p.id); AIOS.sound('nav'); });
      nav.appendChild(b);
    }
  }

  function showPage(id) {
    const next = pages.find((p) => p.id === id);
    if (!next || (currentPage && currentPage.id === id)) return;
    if (currentPage && currentPage.onHide) { try { currentPage.onHide(); } catch (e) { console.error(e); } }
    currentPage = next;
    document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === 'page-' + id));
    document.querySelectorAll('.side-item[data-page]').forEach((el) => el.classList.toggle('active', el.dataset.page === id));
    const t = $('pageTitle'); if (t) t.textContent = next.title;
    const s = $('pageSub'); if (s) s.textContent = next.sub || '';
    if (next.onShow) { try { next.onShow(); } catch (e) { console.error(e); } }
    bus.emit('page', id);
  }

  // ---- data polling ----
  let pollTimer = null;
  async function refreshData() {
    try {
      const data = await api.get('/api/data');
      AIOS.state.data = data;
      const u = $('updatedAt'); if (u) u.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      bus.emit('data', data);
      for (const p of pages) { if (p.onData) { try { p.onData(data); } catch (e) { console.error(`onData:${p.id}`, e); } } }
    } catch (e) {
      console.error('refreshData', e);
      AIOS.toast('Data refresh failed', 'err');
    }
  }

  // ---- modal ----
  function openModal(content, { onClose } = {}) {
    closeModal();
    const root = $('modalRoot');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = '<div class="modal-backdrop"></div><div class="modal-card" role="dialog"></div>';
    const card = wrap.querySelector('.modal-card');
    if (typeof content === 'string') card.innerHTML = content; else card.appendChild(content);
    wrap.querySelector('.modal-backdrop').addEventListener('click', closeModal);
    root.appendChild(wrap);
    root._onClose = onClose || null;
    requestAnimationFrame(() => wrap.classList.add('open'));
    return card;
  }
  function closeModal() {
    const root = $('modalRoot');
    if (!root || !root.firstChild) return;
    const cb = root._onClose; root._onClose = null;
    root.innerHTML = '';
    if (cb) { try { cb(); } catch (e) { console.error(e); } }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---- toast ----
  function toast(msg, kind = 'info') {
    const box = $('toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = 'toast toast-' + kind;
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, 3500);
  }

  // ---- shared ResizeObserver (canvas redraws) ----
  const roMap = new Map();
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const en of entries) {
          const fn = roMap.get(en.target);
          if (fn) requestAnimationFrame(() => { try { fn(en.target); } catch (e) { console.error(e); } });
        }
      })
    : null;
  function observe(el, fn) { if (!ro || !el) return; roMap.set(el, fn); ro.observe(el); }

  // ---- privacy ----
  const privacy = {
    get on() { return !!ui.privacy; },
    toggle() {
      ui.privacy = !ui.privacy; saveUi();
      applyPrivacy();
      bus.emit('privacy', ui.privacy);
    },
  };
  function applyPrivacy() {
    document.body.classList.toggle('privacy', !!ui.privacy);
    const btn = $('privacyBtn');
    if (btn) {
      btn.querySelector('.eye-open').hidden = !!ui.privacy;
      btn.querySelector('.eye-off').hidden = !ui.privacy;
    }
  }

  // ---- sound mute toggle (engine itself lives in os.js) ----
  function applyMute() {
    const btn = $('soundBtn');
    if (!btn) return;
    btn.querySelector('.snd-on').hidden = !!ui.muted;
    btn.querySelector('.snd-off').hidden = !ui.muted;
  }

  // ---- topbar greeting clock ----
  function updateHello() {
    const now = new Date();
    const h = now.getHours();
    const greet = h < 5 ? 'Late night, Yish' : (h < 12 ? 'Good morning, Yish' : (h < 17 ? 'Good afternoon, Yish' : (h < 21 ? 'Good evening, Yish' : 'Good night, Yish')));
    const g = $('helloGreet'); if (g) g.textContent = greet;
    const d = $('helloDate'); if (d) d.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    const t = $('helloTime'); if (t) t.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // ---- public namespace ----
  window.AIOS = {
    state: { data: null, ui, crm: null },
    bus,
    api,
    fmt,
    util,
    saveUi,
    registerPage(def) { pages.push(def); if (mounted) mountPage(def); },
    showPage,
    refreshData,
    openModal,
    closeModal,
    toast,
    observe,
    privacy,
    proxyImg(u) { return '/api/img?url=' + encodeURIComponent(u); },
    notify: stub('notify'),
    sound: stub('sound'),
    registerCommand: stub('registerCommand'),
    _pages: pages,
    _implement(name, fn) {
      window.AIOS[name] = fn;
      const q = queues[name] || [];
      queues[name] = [];
      for (const args of q) { try { fn(...args); } catch (e) { console.error(`drain:${name}`, e); } }
    },
  };

  function mountPage(p) {
    const el = $('page-' + p.id);
    if (!el) { console.error(`no shell for page ${p.id}`); return; }
    try { p.mount(el); } catch (e) { console.error(`mount:${p.id}`, e); }
    if (AIOS.state.data && p.onData) { try { p.onData(AIOS.state.data); } catch (e) { console.error(e); } }
  }

  // ---- boot ----
  document.addEventListener('DOMContentLoaded', () => {
    buildNav();
    for (const p of pages) mountPage(p);
    mounted = true;
    applyPrivacy();
    applyMute();
    updateHello();
    setInterval(updateHello, 20000);

    if (pages.length) showPage(pages[0].id);

    $('refreshBtn') && $('refreshBtn').addEventListener('click', () => { refreshData(); AIOS.sound('tick'); });
    $('privacyBtn') && $('privacyBtn').addEventListener('click', () => privacy.toggle());
    $('soundBtn') && $('soundBtn').addEventListener('click', () => {
      ui.muted = !ui.muted; saveUi(); applyMute();
      if (!ui.muted) AIOS.sound('tick');
    });

    refreshData();
    pollTimer = setInterval(refreshData, DATA_POLL_MS);
  });
})();
