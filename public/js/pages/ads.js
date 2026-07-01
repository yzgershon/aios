'use strict';
/*
 * AIOS page: Advertisements — Meta ads cockpit. Honest pre-launch state
 * ported verbatim from v1 (campaign facts unchanged); v2 adds checkable
 * checklist items and Draft-with-Claude actions on the global terminal.
 */
(() => {
  const { esc } = AIOS.util;
  const $ = (id) => document.getElementById(id);
  const CHECK_KEY = 'aios.ads.check.v1';

  const AD_CAMPAIGNS = [
    { name: 'YDdetailers — Leads — Test 1', obj: 'Leads · Instant form · free $50 wax', status: 'draft', budget: '$10/day', est: 'publishes when video’s cut' },
    { name: 'Retarget site visitors', obj: 'Pixel audience → form/DM', status: 'planned', budget: '$8/day', est: 'pixel now collecting data' },
    { name: 'Seasonal — Winter Prep', obj: 'Sales · interior reset', status: 'planned', budget: '$10/day', est: 'nov–feb push' },
  ];
  const AD_CREATIVE = [
    { icon: '🎥', title: 'Hook video — you two on camera', sub: 'talk + show the work, vertical 9:16, <30s' },
    { icon: '✨', title: 'Before / after reveal', sub: '3s dirty → clean, CapCut, captions on' },
    { icon: '🏷️', title: 'Free $50 wax offer hook', sub: 'lead with the offer for cold traffic' },
    { icon: '💧', title: 'Interior reset close-ups', sub: 'satisfying deep-clean B-roll' },
  ];
  const AD_CHECKLIST = [
    { id: 'ig', done: true, title: 'Instagram @yddetailers live', sub: 'connected as the ad account’s IG.' },
    { id: 'biz', done: true, title: 'Meta Business + Page created', sub: 'YDdetailers Page under the 18+ account.' },
    { id: 'pixel', done: true, title: 'Meta Pixel live on yddetailers.com', sub: 'id 1246148674096033 — on every page, collecting now.' },
    { id: 'form', done: true, title: 'Instant lead form built', sub: '“$50 OFF” form · SMS-verified · → Google Sheets.' },
    { id: 'video', done: false, title: 'Shoot video + publish at $10/day', sub: 'campaign in draft; publishes once the clip’s cut.' },
  ];

  // user ticks on top of the baked-in state (so he can check "shoot video" when done)
  let checks = (() => { try { return JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch { return {}; } })();
  const saveChecks = () => { try { localStorage.setItem(CHECK_KEY, JSON.stringify(checks)); } catch { /* ignore */ } };
  const isDone = (c) => (checks[c.id] != null ? !!checks[c.id] : c.done);

  function mount(el) {
    el.innerHTML = `
      <section class="hero-row">
        <article class="card hero-card ads-hero" id="ads-hero">
          <div class="card-head"><h2>Meta Ads · Performance</h2><span class="hero-tag warn" id="ads-status"><span class="dot warn"></span>in draft</span></div>
          <div class="hero-body" id="ads-hero-body"></div>
        </article>
        <div class="kpi-stack">
          <article class="card kpi-mini"><div class="kpi-head"><span class="kpi-label">Spend (Month)</span></div><div class="kpi-body" id="ads-spend-body"></div></article>
          <article class="card kpi-mini"><div class="kpi-head"><span class="kpi-label">ROAS</span></div><div class="kpi-body" id="ads-roas-body"></div></article>
          <article class="card kpi-mini"><div class="kpi-head"><span class="kpi-label">Cost / Lead</span></div><div class="kpi-body" id="ads-cpl-body"></div></article>
        </div>
      </section>

      <section class="ads-kpi-row">
        <div class="card mini-stat"><span class="ms-label">Reach</span><span class="ms-val" id="ads-reach">—</span><span class="ms-sub">people</span></div>
        <div class="card mini-stat"><span class="ms-label">Impressions</span><span class="ms-val" id="ads-impr">—</span><span class="ms-sub">views</span></div>
        <div class="card mini-stat"><span class="ms-label">Clicks</span><span class="ms-val" id="ads-clicks">—</span><span class="ms-sub">link taps</span></div>
        <div class="card mini-stat"><span class="ms-label">CTR</span><span class="ms-val" id="ads-ctr">—</span><span class="ms-sub">click rate</span></div>
        <div class="card mini-stat"><span class="ms-label">Leads</span><span class="ms-val" id="ads-leads">—</span><span class="ms-sub">this month</span></div>
        <div class="card mini-stat"><span class="ms-label">Bookings</span><span class="ms-val" id="ads-bookings">—</span><span class="ms-sub">from ads</span></div>
      </section>

      <section class="grid-2">
        <article class="card" id="tile-campaigns">
          <div class="card-head"><h2>Campaigns</h2><span class="card-count" id="campaigns-count"></span></div>
          <div class="card-body" id="campaigns-body"></div>
        </article>
        <article class="card" id="tile-adcreative">
          <div class="card-head"><h2>Creative Studio</h2><span class="card-count">drafts</span></div>
          <div class="card-body" id="adcreative-body"></div>
        </article>
      </section>

      <section class="grid-2">
        <article class="card" id="tile-adtips">
          <div class="card-head"><h2>Launch Checklist</h2><span class="card-count" id="adtips-count"></span></div>
          <div class="card-body" id="adtips-body"></div>
        </article>
        <article class="card" id="tile-adaudience">
          <div class="card-head"><h2>Targeting · YDdetailers</h2></div>
          <div class="card-body" id="adaudience-body"></div>
        </article>
      </section>`;
    render();
    bindEvents(el);
  }

  function render() {
    const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
    const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };

    set('ads-hero-body',
      `<div class="hero-figure"><span class="hero-cur money">$</span><span class="hero-num money">0</span></div>` +
      `<div class="ads-explain">Your first campaign — <strong>YDdetailers — Leads — Test 1</strong> — is <strong>built and in draft</strong>: $10/day, Newton +10mi, free $50 wax offer, instant lead form. It publishes the moment your hook video is cut. Once it's live, spend, reach, CPL and leads stream in here — I can wire the Meta Marketing API so it's automatic.</div>` +
      `<div class="ads-cta-row">` +
        `<a class="btn btn-primary" href="https://www.facebook.com/adsmanager/" target="_blank" rel="noopener">Open Ads Manager →</a>` +
        `<a class="btn btn-ghost" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener">Business Suite →</a>` +
        `<button class="btn btn-ghost" data-ad-action="creative">Draft ad creative</button>` +
      `</div>` +
      `<div class="ads-foot">Meta Marketing API not wired — numbers go live when the campaign launches.</div>`);
    set('ads-spend-body', `<div class="kpi-value money">$0</div><div class="kpi-sub">nothing running</div>`);
    set('ads-roas-body', `<div class="kpi-value">—</div><div class="kpi-sub">revenue ÷ spend</div>`);
    set('ads-cpl-body', `<div class="kpi-value">—</div><div class="kpi-sub">per booking lead</div>`);

    txt('campaigns-count', '1 in draft');
    const ch = `<div class="camp-head"><span>Campaign</span><span>Status</span><span>Budget</span><span>Goal</span></div>`;
    set('campaigns-body', ch + AD_CAMPAIGNS.map((c) => (
      `<div class="camp-row"><span class="camp-name">${esc(c.name)}<span class="camp-obj">${esc(c.obj)}</span></span>` +
      `<span class="camp-status ${esc(c.status)}">${esc(c.status)}</span>` +
      `<span class="camp-cell">${esc(c.budget)}</span>` +
      `<span class="camp-cell">${esc(c.est)}</span></div>`
    )).join('') + `<div class="ads-cta-row" style="margin-top:12px"><a class="btn btn-ghost" href="https://www.facebook.com/adsmanager/" target="_blank" rel="noopener">Build in Ads Manager →</a></div>`);

    set('adcreative-body', AD_CREATIVE.map((a) => (
      `<div class="angle-item"><span class="ac-icon">${esc(a.icon)}</span><span class="ac-text"><span class="angle-name">${esc(a.title)}</span><br><span class="angle-desc">${esc(a.sub)}</span></span><button class="angle-go" data-ad-action="creative">Draft with Claude →</button></div>`
    )).join(''));

    const doneN = AD_CHECKLIST.filter(isDone).length;
    txt('adtips-count', doneN + '/' + AD_CHECKLIST.length);
    set('adtips-body', AD_CHECKLIST.map((c) => (
      `<div class="adtip-item ${isDone(c) ? 'done' : ''}" data-check="${esc(c.id)}"><span class="adtip-check">${isDone(c) ? '✓' : ''}</span><span class="adtip-text"><strong>${esc(c.title)}</strong><br>${esc(c.sub)}</span></div>`
    )).join(''));

    set('adaudience-body',
      `<div class="aud-section"><div class="aud-label microlabel">Location</div><div class="aud-chips"><span class="chip accent">Newton +10mi</span><span class="chip">Waltham</span><span class="chip">Watertown</span><span class="chip">Brookline</span></div></div>` +
      `<div class="aud-section"><div class="aud-label microlabel">Age / Gender</div><div class="aud-chips"><span class="chip">25–65</span><span class="chip">all</span></div></div>` +
      `<div class="aud-section"><div class="aud-label microlabel">Targeting</div><div class="aud-chips"><span class="chip accent">Broad</span><span class="chip">Advantage+ on</span><span class="chip">auto placements</span></div></div>` +
      `<div class="aud-section"><div class="aud-label microlabel">Lead capture</div><div class="aud-chips"><span class="chip accent">Instant form</span><span class="chip">SMS-verified</span><span class="chip">→ Google Sheets</span></div></div>`);
  }

  function bindEvents(el) {
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-ad-action]');
      if (a && a.getAttribute('data-ad-action') === 'creative') {
        // terminal is global in v2 — run his ad-drafting skill right here
        if (AIOS.terminal && AIOS.terminal.run) AIOS.terminal.run('draft-nextdoor-ad');
        return;
      }
      const chk = e.target.closest('[data-check]');
      if (chk) {
        const id = chk.getAttribute('data-check');
        const item = AD_CHECKLIST.find((c) => c.id === id);
        if (item) {
          checks[id] = !isDone(item);
          saveChecks();
          render();
          if (checks[id]) AIOS.sound('tick');
        }
      }
    });
  }

  AIOS.registerPage({
    id: 'ads',
    title: 'Advertisements',
    sub: 'Meta · YDdetailers',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9v6h3l8 4V5L7 9H4z" fill="currentColor"/><path d="M18 8.5a4.5 4.5 0 010 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    mount,
  });
})();
