'use strict';
/*
 * AIOS page: Portfolio — live Yahoo quotes, holdings, allocation donut,
 * upcoming earnings. Ported from v1; donut now uses AIOS.charts, the Total
 * Value KPI gets an in-session sparkline, and each quote poll is published
 * on the bus for the notification center.
 */
(() => {
  const { esc, emptyState } = AIOS.util;
  const $ = (id) => document.getElementById(id);

  const INDICES = [
    { sym: '^GSPC', name: 'S&P 500' },
    { sym: '^IXIC', name: 'Nasdaq' },
    { sym: '^DJI', name: 'Dow' },
  ];
  const ALLOC_COLORS = ['#0a84ff', '#64d2ff', '#5e9bff', '#30d158', '#40e0d0', '#7a8cff', '#4aa8ff', '#3ad0c0'];

  const fmtNum = (n) => { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString('en-US') : '0'; };
  const money = (n, cur) => { const s = (cur === 'USD' || !cur) ? '$' : cur + ' '; return s + fmtNum(Math.round(Number(n) || 0)); };
  const signed = (n) => { const v = Number(n) || 0; return (v >= 0 ? '+$' : '−$') + fmtNum(Math.abs(Math.round(v))); };
  const pctStr = (n) => { const v = Number(n) || 0; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };

  let visible = false;
  let portfolioData = null, portfolioLoaded = false, livePortfolioData = null;
  let liveQuotes = {};
  let quoteTimer = null;
  let editingPortfolio = false;
  const totalHistory = []; // in-session total-value ticks for the KPI sparkline

  // =========================================================================
  function mount(el) {
    el.innerHTML = `
      <div class="market-strip" id="marketStrip"></div>
      <section class="kpi-row">
        <div class="card kpi-mini" id="pf-total"><div class="kpi-head"><span class="kpi-label">Total Value</span><span class="live-dot" id="pfLive" title="live"></span></div><div class="kpi-body" id="pf-total-body"></div><canvas class="pf-spark" id="pfSpark"></canvas></div>
        <div class="card kpi-mini" id="pf-gain"><div class="kpi-head"><span class="kpi-label">Total Gain / Loss</span></div><div class="kpi-body" id="pf-gain-body"></div></div>
        <div class="card kpi-mini" id="pf-day"><div class="kpi-head"><span class="kpi-label">Today</span></div><div class="kpi-body" id="pf-day-body"></div></div>
        <div class="card kpi-mini" id="pf-positions"><div class="kpi-head"><span class="kpi-label">Positions</span></div><div class="kpi-body" id="pf-positions-body"></div></div>
      </section>
      <section class="grid-2">
        <article class="card tile-holdings" id="tile-holdings">
          <div class="card-head"><h2>Holdings</h2><span class="chip" id="mktState" hidden></span>
            <div class="seg" id="dayModeSeg" style="margin-left:auto" title="Day column: auto shows pre/post-market moves outside regular hours">
              <button class="seg-btn" data-daymode="auto">auto</button>
              <button class="seg-btn" data-daymode="reg">regular</button>
            </div>
            <button class="card-action" id="pfEdit" title="Edit holdings" style="margin-left:0">edit</button>
          </div>
          <div class="card-body" id="holdings-body"></div>
        </article>
        <article class="card tile-allocation" id="tile-allocation">
          <div class="card-head"><h2>Allocation</h2></div>
          <div class="card-body" id="allocation-body"></div>
        </article>
      </section>
      <article class="card" id="tile-earnings">
        <div class="card-head"><h2>Upcoming Earnings</h2><div class="earn-filter" id="earnFilter"></div><span class="card-count" id="earnings-count"></span></div>
        <div class="card-body" id="earnings-body"></div>
      </article>`;
    bindEvents(el);
  }

  // =========================================================================
  // PORTFOLIO DATA + RENDER (ported)
  // =========================================================================
  async function loadPortfolio(force) {
    if (portfolioLoaded && !force) { renderPortfolio(livePortfolioData || portfolioData); startQuotePolling(); return; }
    try { portfolioData = await AIOS.api.get('/api/portfolio'); portfolioLoaded = true; }
    catch { portfolioData = { available: false, positions: [] }; }
    renderPortfolio(portfolioData);
    startQuotePolling();
  }

  function renderPortfolio(d) {
    if (editingPortfolio) return;
    if (!d || !d.available) {
      $('pf-total-body').innerHTML = `<div class="kpi-value money">$0</div><div class="kpi-sub">no holdings yet</div>`;
      ['pf-gain-body', 'pf-day-body', 'pf-positions-body'].forEach((id) => { $(id).innerHTML = `<div class="kpi-value">—</div><div class="kpi-sub"></div>`; });
      $('holdings-body').innerHTML = emptyState('No holdings', 'Hit edit to add positions, or drop them into ~/.aios/portfolio.json.', '');
      $('allocation-body').innerHTML = emptyState('Nothing to allocate', 'Add holdings to see your mix.', '');
      return;
    }
    const cur = d.currency || 'USD';
    $('pf-total-body').innerHTML = `<div class="kpi-value money">${esc(money(d.totalValue, cur))}</div><div class="kpi-sub">${d.totalValue > 0 ? d.positions.length + ' positions' : 'add share counts to value it'}</div>`;
    const gCls = d.totalGain >= 0 ? 'pos' : 'neg';
    $('pf-gain-body').innerHTML = `<div class="kpi-value money ${gCls}">${esc(signed(d.totalGain))}</div><div class="kpi-sub"><span class="kpi-change ${gCls}">${esc(pctStr(d.totalGainPct))}</span> all-time</div>`;
    const dCls = d.dayChange >= 0 ? 'pos' : 'neg';
    $('pf-day-body').innerHTML = `<div class="kpi-value money ${dCls}">${esc(signed(d.dayChange))}</div><div class="kpi-sub"><span class="kpi-change ${dCls}">${esc(pctStr(d.dayChangePct))}</span> today</div>`;
    $('pf-positions-body').innerHTML = `<div class="kpi-value">${d.positions.length}</div><div class="kpi-sub">${esc((d.positions[0] && d.positions[0].ticker) || '')} biggest</div>`;

    // day column: in 'auto' mode show the live pre/post-market move while the
    // market is in extended hours; 'reg' pins it to the regular-session change.
    const dayMode = AIOS.state.ui.pfDayMode || 'auto';
    const seg = document.getElementById('dayModeSeg');
    if (seg) seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-daymode') === dayMode));
    const anyState = (d.positions.find((p) => p.state && /^(PRE|POST)/.test(p.state)) || {}).state || '';
    const stateChip = $('mktState');
    if (stateChip) {
      const tag = /^PRE/.test(anyState) ? 'pre-market' : (/^POST/.test(anyState) ? 'after hours' : '');
      stateChip.hidden = !tag;
      stateChip.textContent = tag;
      stateChip.className = 'chip warn';
    }
    const head = `<div class="holdings-head"><span>Ticker</span><span>Name</span><span>Price</span><span>Day</span><span>Value</span></div>`;
    const rows = d.positions.map((p) => {
      const useExt = dayMode === 'auto' && p.ext && p.state && /^(PRE|POST)/.test(p.state);
      const pct = useExt ? p.ext.changePct : p.dayChangePct;
      const dcls = (pct || 0) >= 0 ? 'pos' : 'neg';
      const tag = useExt ? `<span class="ext-tag">${/^PRE/.test(p.state) ? 'pre' : 'post'}</span>` : '';
      const day = p.live ? `<span class="hgain money ${dcls}">${esc(pctStr(pct))}${tag}</span>` : '<span class="hgain muted">—</span>';
      const px = useExt ? p.ext.price : p.price;
      const val = p.shares > 0 ? `<span class="money">${esc(money(p.value, cur))}</span>` : '<span class="muted">—</span>';
      return `<div class="hrow"><span class="tick">${esc(p.ticker)}</span><span class="hname">${esc(p.name || '')}</span><span class="hprice money">${esc(money(px, cur))}</span>${day}<span class="hval-wrap"><span class="hvalue">${val}</span></span></div>`;
    }).join('');
    $('holdings-body').innerHTML = head + rows;

    // allocation donut via charts
    if (!d.positions.some((p) => p.weight > 0)) {
      $('allocation-body').innerHTML = emptyState('Nothing to allocate', 'Add your share counts (Edit) to see your mix.', '');
      return;
    }
    $('allocation-body').innerHTML = `<div class="donut-wrap"><canvas id="allocDonut" style="width:100%;height:100%;min-height:200px"></canvas></div>`;
    const slices = d.positions.filter((p) => p.value > 0).map((p, i) => ({
      label: p.ticker, value: p.value, color: ALLOC_COLORS[i % ALLOC_COLORS.length],
    }));
    AIOS.charts.donut($('allocDonut'), slices, { centerLabel: 'holdings', centerValue: String(d.positions.length) });
  }

  // ---- live quotes (ported) ----
  function applyQuotes(pf, quotes) {
    if (!pf || !pf.positions || !pf.positions.length) return pf;
    let any = false;
    const positions = pf.positions.map((p) => {
      const q = quotes[p.ticker];
      if (!q) return Object.assign({}, p);
      any = true;
      const price = q.price, prevClose = q.prevClose, value = p.shares * price, cost = p.shares * p.avgCost;
      return Object.assign({}, p, { price, prevClose, value, gain: value - cost, gainPct: cost > 0 ? ((value - cost) / cost) * 100 : 0, dayChange: prevClose ? p.shares * (price - prevClose) : 0, dayChangePct: q.changePct, state: q.state, ext: q.ext || null, live: true });
    });
    let totalValue = 0, totalCost = 0, dayChange = 0;
    positions.forEach((p, i) => { totalValue += p.value || 0; totalCost += pf.positions[i].shares * pf.positions[i].avgCost; dayChange += p.dayChange || 0; });
    positions.forEach((p) => { p.weight = totalValue > 0 ? (p.value / totalValue) * 100 : 0; });
    positions.sort((a, b) => (b.value - a.value) || ((b.dayChangePct || 0) - (a.dayChangePct || 0)));
    const totalGain = totalValue - totalCost, prevTotal = totalValue - dayChange;
    return Object.assign({}, pf, { positions, totalValue, totalCost, totalGain, totalGainPct: totalCost > 0 ? (totalGain / totalCost) * 100 : 0, dayChange, dayChangePct: prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0, live: any });
  }
  function renderIndices() {
    const strip = $('marketStrip'); if (!strip) return;
    strip.innerHTML = INDICES.map((ix) => {
      const q = liveQuotes[ix.sym];
      if (!q) return `<div class="mkt-item"><span class="mkt-sym">${esc(ix.name)}</span><span class="muted">…</span></div>`;
      const c = q.changePct >= 0 ? 'pos' : 'neg';
      return `<div class="mkt-item"><span class="mkt-sym">${esc(ix.name)}</span><span class="mkt-px money">${fmtNum(Math.round(q.price))}</span><span class="mkt-chg money ${c}">${esc(pctStr(q.changePct))}</span></div>`;
    }).join('');
  }
  function renderLive() {
    if (editingPortfolio) return;
    livePortfolioData = applyQuotes(portfolioData, liveQuotes);
    renderPortfolio(livePortfolioData);
    renderIndices();
    const dot = $('pfLive');
    if (dot && livePortfolioData && livePortfolioData.live) dot.classList.add('on');
    // in-session total sparkline
    if (livePortfolioData && livePortfolioData.live && livePortfolioData.totalValue > 0) {
      totalHistory.push(livePortfolioData.totalValue);
      if (totalHistory.length > 240) totalHistory.shift();
      if (totalHistory.length > 2) {
        const up = totalHistory[totalHistory.length - 1] >= totalHistory[0];
        AIOS.charts.sparkline($('pfSpark'), totalHistory.slice(), { color: up ? undefined : '#ff453a' });
      }
    }
    AIOS.bus.emit('quotes', { quotes: liveQuotes, portfolio: livePortfolioData });
  }
  async function pollQuotes() {
    if (!visible) { stopQuotePolling(); return; }
    const tickers = (portfolioData && portfolioData.positions ? portfolioData.positions.map((p) => p.ticker) : []);
    const syms = INDICES.map((i) => i.sym).concat(tickers);
    try {
      const r = await AIOS.api.get('/api/quotes?symbols=' + encodeURIComponent(syms.join(',')));
      liveQuotes = Object.assign(liveQuotes, r.quotes || {});
      renderLive();
    } catch { /* keep last */ }
  }
  function startQuotePolling() { stopQuotePolling(); pollQuotes(); quoteTimer = setInterval(pollQuotes, 5000); }
  function stopQuotePolling() { if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; } }

  // =========================================================================
  // EARNINGS (ported)
  // =========================================================================
  let earningsLoaded = false, earningsData = null;
  const earnState = { filter: 'all' };
  async function loadEarnings(force) {
    if (earningsLoaded && !force && earningsData) { renderEarnings(earningsData); return; }
    $('earnings-body').innerHTML = `<div class="empty"><span class="empty-title">Loading</span><p class="empty-body">Pulling upcoming earnings dates…</p></div>`;
    try { earningsData = await AIOS.api.get('/api/earnings'); earningsLoaded = true; }
    catch { earningsData = { available: false, rows: [] }; }
    renderEarnings(earningsData);
  }
  function earnDateLabel(epoch, dateStr) {
    const ms = (Number(epoch) || 0) * 1000;
    const d = ms ? new Date(ms) : new Date(dateStr + 'T00:00');
    if (Number.isNaN(d.getTime())) return { label: dateStr || '', days: null };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
    const label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return { label, days };
  }
  function renderEarnings(d) {
    const body = $('earnings-body'), count = $('earnings-count'), filterEl = $('earnFilter');
    if (filterEl) {
      const heldN = d && d.counts ? d.counts.held : 0;
      filterEl.innerHTML = [['all', 'All'], ['held', 'My holdings']].map(([k, lab]) =>
        `<button class="ptab ${earnState.filter === k ? 'active' : ''}" data-earn="${k}">${lab}${k === 'held' && heldN ? `<span class="ptab-count">${heldN}</span>` : ''}</button>`).join('');
    }
    if (!d || !d.available) { if (count) count.textContent = ''; body.innerHTML = emptyState('No earnings data', 'Upcoming earnings for your holdings and big companies load here.', ''); return; }
    let rows = d.rows || [];
    if (earnState.filter === 'held') rows = rows.filter((r) => r.held);
    if (count) count.textContent = rows.length ? rows.length + ' upcoming' : '';
    if (!rows.length) { body.innerHTML = emptyState('Nothing scheduled', earnState.filter === 'held' ? 'No upcoming earnings for your holdings.' : 'No upcoming earnings found.', ''); return; }
    const head = `<div class="earn-head"><span>Date</span><span>Company</span><span>EPS est</span><span>Rev est</span></div>`;
    body.innerHTML = head + rows.map((r) => {
      const { label, days } = earnDateLabel(r.epoch, r.date);
      const soon = days != null && days <= 7;
      const when = days === 0 ? 'today' : (days != null && days > 0 ? 'in ' + days + 'd' : '');
      const eps = r.epsEstimate != null ? '$' + Number(r.epsEstimate).toFixed(2) : '—';
      const rev = r.revEstimate || '—';
      return `<div class="earn-row${soon ? ' soon' : ''}">
        <span class="earn-date"><span class="ed-day">${esc(label)}</span><span class="ed-rel">${esc(when)}</span></span>
        <span class="earn-co"><span class="earn-tick${r.held ? ' held' : ''}">${esc(r.ticker)}</span><span class="earn-name">${esc(r.name)}${r.isEstimate ? ' <span class="earn-est">est</span>' : ''}</span></span>
        <span class="earn-eps">${esc(eps)}</span>
        <span class="earn-rev">${esc(rev)}</span>
      </div>`;
    }).join('');
  }

  // =========================================================================
  // HOLDINGS EDITOR (ported into a modal; same POST body shape)
  // =========================================================================
  const pfEditRow = (p) => {
    p = p || {};
    return `<div class="hrow pf-erow">
      <input class="pf-in" data-k="ticker" value="${esc(p.ticker || '')}" placeholder="NVDA" maxlength="8">
      <input class="pf-in" data-k="name" value="${esc(p.name || '')}" placeholder="name">
      <input class="pf-in" data-k="shares" type="number" step="any" value="${p.shares != null ? p.shares : ''}" placeholder="shares">
      <input class="pf-in" data-k="avgCost" type="number" step="any" value="${p.avgCost != null ? p.avgCost : ''}" placeholder="avg">
      <input class="pf-in" data-k="price" type="number" step="any" value="${p.price != null ? p.price : ''}" placeholder="price">
    </div>`;
  };
  function openPortfolioEditor() {
    editingPortfolio = true;
    const d = portfolioData || { positions: [] };
    const rows = (d.positions || []).map((p) => pfEditRow(p)).join('');
    const card = AIOS.openModal(`
      <h3>Edit Holdings</h3>
      <div class="holdings-head pf-edit-head"><span>Ticker</span><span>Name</span><span>Shares</span><span>Avg cost</span><span>Price</span></div>
      <div id="pfEditRows">${rows || pfEditRow()}</div>
      <div class="form-actions"><button class="btn" id="pfAddRow">+ Add row</button><button class="btn btn-ghost" id="pfCancel">Cancel</button><button class="btn btn-primary" id="pfSave">Save</button></div>`,
      { onClose: () => { editingPortfolio = false; } });
    card.querySelector('#pfAddRow').addEventListener('click', () => {
      card.querySelector('#pfEditRows').insertAdjacentHTML('beforeend', pfEditRow());
    });
    card.querySelector('#pfCancel').addEventListener('click', () => AIOS.closeModal());
    card.querySelector('#pfSave').addEventListener('click', async () => {
      const holdings = [...card.querySelectorAll('#pfEditRows .pf-erow')].map((r) => {
        const g = (k) => { const el = r.querySelector(`[data-k="${k}"]`); return el ? el.value : ''; };
        return { ticker: g('ticker'), name: g('name'), shares: Number(g('shares')) || 0, avgCost: Number(g('avgCost')) || 0, price: Number(g('price')) || 0 };
      }).filter((h) => h.ticker.trim());
      try {
        portfolioData = await AIOS.api.post('/api/portfolio', { currency: (portfolioData && portfolioData.currency) || 'USD', holdings });
        portfolioLoaded = true;
      } catch { AIOS.toast('Save failed', 'err'); }
      AIOS.closeModal();
      renderPortfolio(portfolioData);
      AIOS.sound('tick');
    });
  }

  // =========================================================================
  function bindEvents(el) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('#pfEdit')) { openPortfolioEditor(); return; }
      const dm = e.target.closest('#dayModeSeg .seg-btn');
      if (dm) {
        AIOS.state.ui.pfDayMode = dm.getAttribute('data-daymode') || 'auto';
        AIOS.saveUi();
        renderLive();
        return;
      }
      const b = e.target.closest('[data-earn]');
      if (b) {
        earnState.filter = b.getAttribute('data-earn') || 'all';
        if (earningsData) renderEarnings(earningsData);
      }
    });
  }

  // =========================================================================
  AIOS.registerPage({
    id: 'portfolio',
    title: 'Portfolio',
    sub: 'live · Yahoo quotes',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 16l4-5 3 3 5-7 4 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    mount,
    onShow() {
      visible = true;
      loadPortfolio();
      loadEarnings();
    },
    onHide() {
      visible = false;
      stopQuotePolling();
    },
  });
})();
