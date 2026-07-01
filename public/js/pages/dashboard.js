'use strict';
/*
 * AIOS page: Command Center (dashboard).
 * Ports every v1 tile (hero revenue, net worth ticker, CRM KPIs, content
 * carousel, trending, local demand, competitors, comments, to-do) and adds
 * the AI Daily Briefing, revenue chart, and bookings heatmap cards.
 */
(() => {
  const { esc, safeUrl, fmtDuration, emptyState } = AIOS.util;
  const $ = (id) => document.getElementById(id);
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // ---- v1 formatters (ported) ----
  const fmtNum = (n) => { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString('en-US') : '0'; };
  const abbrev = (n) => AIOS.fmt.compact(Number(n) || 0);
  const timeAgo = AIOS.fmt.ago;
  const looksIso = (s) => typeof s === 'string' && /\d{4}-\d{2}-\d{2}T/.test(s);
  const whenLabel = (t) => (t ? (looksIso(t) ? timeAgo(t) : t) : '');
  const money = (n) => '$' + fmtNum(Math.round(n));
  const signed = (n) => (n >= 0 ? '+$' : '−$') + fmtNum(Math.round(Math.abs(n)));

  let lastData = null;
  let visible = false;
  const editing = { mrr: false };

  // =========================================================================
  // MOUNT — build the page DOM
  // =========================================================================
  function mount(el) {
    el.innerHTML = `
      <section class="hero-row">
        <article class="card hero-card" id="kpi-revenue">
          <div class="card-head"><button class="hero-nav" id="revPrev" title="Previous month" aria-label="Previous month">‹</button><h2 id="revenue-title">Revenue · This Month</h2><button class="hero-nav" id="revNext" title="Next month" aria-label="Next month" disabled>›</button><span class="hero-tag" id="revenue-tag">detailing + stocks</span></div>
          <div class="hero-body" id="kpi-revenue-body"></div>
        </article>
        <div class="kpi-stack">
          <article class="card kpi-mini" id="kpi-mrr">
            <div class="kpi-head"><span class="kpi-label">Net Worth</span><button class="kpi-edit" id="nwEdit" title="Edit">edit</button></div>
            <div class="kpi-body" id="kpi-mrr-body"></div>
          </article>
          <article class="card kpi-mini" id="kpi-customers">
            <div class="kpi-head"><span class="kpi-label">Customers</span></div>
            <div class="kpi-body" id="kpi-customers-body"></div>
          </article>
          <article class="card kpi-mini" id="kpi-jobs">
            <div class="kpi-head"><span class="kpi-label">Upcoming Jobs</span></div>
            <div class="kpi-body" id="kpi-jobs-body"></div>
          </article>
        </div>
      </section>

      <section class="grid-3 dash-intel">
        <article class="card brief-card" id="tile-brief">
          <div class="card-head"><h2>AI Daily Briefing</h2><button class="card-action" id="briefGen">generate</button></div>
          <div class="card-body" id="brief-body"></div>
        </article>
        <article class="card" id="tile-revchart">
          <div class="card-head"><h2>Revenue · Trend</h2>
            <button class="hero-nav" id="trendPrev" title="Back in time">‹</button><button class="hero-nav" id="trendNext" title="Forward" disabled>›</button><span class="card-count" id="trendRange"></span>
            <div class="seg" id="revValSeg" style="margin-left:auto">
              <button class="seg-btn active" data-revval="$">$</button>
              <button class="seg-btn" data-revval="%">%</button>
            </div>
            <div class="seg" id="revSeg">
              <button class="seg-btn active" data-rev="month">6 mo</button>
              <button class="seg-btn" data-rev="week">weekly</button>
            </div>
          </div>
          <div class="card-body chart-card-body"><canvas id="revChart"></canvas></div>
        </article>
        <article class="card" id="tile-heatmap">
          <div class="card-head"><h2>Bookings · Heatmap</h2><button class="hero-nav" id="heatPrev" title="Back in time">‹</button><button class="hero-nav" id="heatNext" title="Forward" disabled>›</button><span class="card-count" id="heat-count"></span></div>
          <div class="card-body chart-card-body"><canvas id="heatChart"></canvas></div>
        </article>
      </section>

      <section class="grid-2 dash-content">
        <article class="card tile-content" id="tile-content">
          <div class="card-head"><h2>Content</h2><div class="platform-tabs" id="platformTabs"></div></div>
          <div class="card-body" id="content-body"></div>
        </article>
        <article class="card tile-trending" id="tile-trending">
          <div class="card-head"><h2>Trending · Copy These</h2><span class="card-count" id="trending-count"></span></div>
          <div class="card-body" id="trending-body"></div>
        </article>
      </section>

      <section class="grid-3 dash-watch">
        <article class="card tile-local" id="tile-local">
          <div class="card-head"><h2>Local Demand</h2><span class="card-count" id="local-count"></span></div>
          <div class="card-body" id="local-body"></div>
        </article>
        <article class="card tile-competitors" id="tile-competitors">
          <div class="card-head"><h2>Competitor Watch</h2><span class="card-count" id="competitors-count"></span></div>
          <div class="card-body" id="competitors-body"></div>
        </article>
        <article class="card tile-comments" id="tile-comments">
          <div class="card-head"><h2>Comments</h2><div class="platform-tabs" id="commentTabs"></div></div>
          <div class="card-body" id="comments-body"></div>
        </article>
      </section>

      <article class="card" id="tile-todo">
        <div class="card-head"><h2>Focus · To-Do</h2><span class="card-count" id="todo-count"></span><button class="card-action" id="todoReset" title="Reset checks">reset</button></div>
        <div class="card-body" id="todo-body"></div>
      </article>

      <div class="fresh-strip" id="freshStrip" title="When each data source last succeeded"></div>`;
    bindEvents(el);
    renderTodo();
    loadTodoSeeds();
    renderBrief({ status: 'loading' });
    loadBrief();
    loadNwHistory();
    loadFreshness();
  }

  const safe = (fn) => { try { fn(); } catch (e) { console.error('dash tile:', e); } };

  function onData(data) {
    lastData = data;
    safe(() => renderNewBanner(data.content));
    safe(() => renderContent(data));
    safe(() => renderTrending(data.trends));
    safe(() => renderLocalDemand(data.localDemand));
    safe(() => renderCompetitors(data.trends));
    safe(() => renderComments(data.comments));
    safe(() => { if (!editing.mrr) renderNetWorth(data); });
    safe(() => detectFreshLeads(data));
    safe(() => loadFreshness()); // rides the 5-min data poll
  }

  // =========================================================================
  // TRENDING (ported)
  // =========================================================================
  function trendRow(r) {
    const href = safeUrl(r.url);
    const thumb = safeUrl(r.thumbnail);
    const views = r.views != null ? abbrev(r.views) + ' views' : '';
    const time = whenLabel(r.publishedAt);
    const media = thumb ? `<div class="tr-thumb"><img loading="lazy" src="${esc(AIOS.proxyImg(thumb))}" alt="" onerror="this.parentElement.remove()"></div>` : '';
    const meta = `<div class="row-meta">${r.channel ? `<span class="tr-chan">${esc(r.channel)}</span>` : ''}${views ? `<span class="tr-views">${esc(views)}</span>` : ''}${time ? `<span class="row-time">${esc(time)}</span>` : ''}</div>`;
    const inner = `${media}<div class="tr-text"><div class="row-title">${esc(r.title)}</div>${meta}</div>`;
    return `<div class="row tr-row">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
  }
  function renderTrending(d) {
    const body = $('trending-body'), count = $('trending-count');
    if (!d || !d.available) {
      count.textContent = '';
      body.innerHTML = (d && d.reason === 'no_api_key')
        ? emptyState('Add a YouTube key', 'Trending detailing videos load here once a YouTube Data API key is set in .env.', '')
        : emptyState('Loading trends', 'Pulling the top short-form detailing videos to copy. Refreshes every few hours.', '');
      return;
    }
    const rows = (d.trending || []);
    count.textContent = rows.length ? rows.length + ' to steal' : '';
    if (!rows.length) { body.innerHTML = emptyState('Quiet', 'No trending videos in the latest pull.', ''); return; }
    body.innerHTML = rows.map(trendRow).join('');
  }

  // =========================================================================
  // LOCAL DEMAND (ported)
  // =========================================================================
  const LOCAL_TOWNS = 'Newton, Waltham, Watertown & Brookline';
  const LOCAL_LAUNCHPAD = [
    { label: 'Nextdoor — search "detailing"', source: 'Nextdoor', url: 'https://nextdoor.com/search/posts/?query=car%20detailing', note: 'Reply to anyone asking for a detailer near you.' },
    { label: 'Facebook — local "car detailing" posts', source: 'Facebook', url: 'https://www.facebook.com/search/posts/?q=car%20detailing%20newton', note: 'Check local groups + Marketplace wanted posts.' },
    { label: 'Facebook Marketplace — detailing requests', source: 'Marketplace', url: 'https://www.facebook.com/marketplace/search/?query=car%20detailing', note: 'Filter to your area; DM people who want a detail.' },
    { label: 'Google — "mobile detailing near me"', source: 'Google', url: 'https://www.google.com/search?q=mobile+car+detailing+newton+ma', note: 'See who ranks; find gaps you can fill.' },
  ];
  function leadStatusLine(nd) {
    if (!nd || !nd.configured) return '';
    const when = nd.lastPolledAt ? 'checked ' + timeAgo(nd.lastPolledAt) : 'starting…';
    const err = nd.lastError ? ` · <span class="lead-err">inbox error</span>` : '';
    return `<div class="lead-status"><span class="nd-dot"></span>Nextdoor inbox connected · ${esc(when)}${err}</div>`;
  }
  function renderLocalDemand(d) {
    const body = $('local-body'), count = $('local-count');
    const leads = (d && Array.isArray(d.leads)) ? d.leads : [];
    const nd = (d && d.nextdoor) || {};
    const fresh = (d && d.freshCount) || 0;
    if (count) {
      count.textContent = fresh ? fresh + ' new' : (leads.length ? leads.length + ' leads' : (nd.configured ? 'watching' : 'go find them'));
      count.classList.toggle('hot', fresh > 0);
    }
    if (leads.length) {
      const rows = leads.map((r) => {
        const href = safeUrl(r.link);
        const time = whenLabel(r.capturedAt || r.time);
        const newchip = r.fresh ? '<span class="lead-new">NEW</span>' : '';
        const top = `<div class="row-toprow"><div class="row-title">${esc(r.title)}</div>${newchip}${time ? `<span class="row-time">${esc(time)}</span>` : ''}</div>`;
        const note = r.note ? `<div class="row-sub">${esc(r.note)}</div>` : '';
        const src = r.source === 'Nextdoor' ? '<span class="chip nd">Nextdoor</span>' : (r.source ? `<span class="chip">${esc(r.source)}</span>` : '');
        const meta = `<div class="row-meta">${src}${r.area ? esc(r.area) + ' · ' : ''}${r.matched ? '“' + esc(r.matched) + '” ' : ''}${href ? '<span class="arrow">&rarr;</span> open post' : ''}</div>`;
        const inner = top + note + meta;
        return `<div class="row${r.fresh ? ' lead-fresh' : ''}">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
      }).join('');
      body.innerHTML = leadStatusLine(nd) + rows;
      return;
    }
    const intro = nd.configured
      ? `<div class="local-intro">Watching your Nextdoor inbox for anyone near <strong>${esc(LOCAL_TOWNS)}</strong> asking about a detail or car wash. Nothing yet — or hunt manually:</div>`
      : `<div class="local-intro">Hunt people looking for a detailer near <strong>${esc(LOCAL_TOWNS)}</strong>. Connect a Nextdoor inbox (ask me) to auto-capture these:</div>`;
    body.innerHTML = leadStatusLine(nd) + intro + LOCAL_LAUNCHPAD.map((r) => (
      `<div class="row"><a href="${esc(r.url)}" target="_blank" rel="noopener"><div class="row-toprow"><div class="row-title">${esc(r.label)}</div><span class="arrow">&rarr;</span></div><div class="row-meta"><span class="chip">${esc(r.source)}</span>${esc(r.note)}</div></a></div>`
    )).join('');
  }

  // fresh-lead session detection → celebrate + bus event
  let seenFresh = -1;
  function detectFreshLeads(data) {
    const fresh = (data.localDemand && data.localDemand.freshCount) || 0;
    if (seenFresh >= 0 && fresh > seenFresh) {
      AIOS.bus.emit('lead.fresh', { count: fresh });
      AIOS.bus.emit('celebrate', { reason: 'lead' });
    }
    seenFresh = fresh;
  }

  // =========================================================================
  // NEW-POST BANNER (ported)
  // =========================================================================
  function renderNewBanner(content) {
    const host = $('content-body');
    if (!host) return;
    const n = content && content.newCount ? content.newCount : 0;
    const existing = document.getElementById('newPostBanner');
    if (existing) existing.remove();
    if (!n) return;
    const newest = content.newest;
    const label = newest ? `${newest.platform ? newest.platform.toUpperCase() + ' · ' : ''}${(newest.title || 'New post').slice(0, 50)}` : `${n} new post${n > 1 ? 's' : ''}`;
    const banner = document.createElement('div');
    banner.id = 'newPostBanner';
    banner.className = 'new-banner';
    banner.innerHTML = `<span class="new-dot"></span><span class="new-label">New post detected — ${esc(label)}</span>`;
    host.parentElement.insertBefore(banner, host);
  }

  // =========================================================================
  // CONTENT CAROUSEL (ported)
  // =========================================================================
  const contentState = { items: [], filtered: [], platform: '', youtube: null, platforms: {}, igMetric: 'views' };
  // Instagram cards can toggle between views and likes; views is the default.
  // Falls back to whichever metric the post actually has (images have no views).
  function igStat(it) {
    const wantViews = contentState.igMetric === 'views';
    const v = it.views, l = it.likes;
    if (wantViews) {
      if (v != null) return abbrev(v) + ' views';
      if (l != null) return abbrev(l) + ' likes';
    } else {
      if (l != null) return abbrev(l) + ' likes';
      if (v != null) return abbrev(v) + ' views';
    }
    return it.stat || '';
  }
  const cardStat = (it) => (it.platform === 'instagram' ? igStat(it) : (it.stat || ''));
  const PLATFORMS = [
    { key: 'youtube', label: 'YouTube' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'tiktok', label: 'TikTok' },
  ];
  const statItem = (num, lab) => `<div class="yt-stat"><span class="num">${esc(num)}</span><span class="lab">${esc(lab)}</span></div>`;
  function statStrip(platform) {
    const P = contentState.platforms || {};
    const yt = P.youtube, ig = P.instagram, tt = P.tiktok;
    let items = [];
    if (platform === 'youtube') {
      if (yt && yt.available && yt.stats) items = [statItem(abbrev(yt.stats.subscriberCount), 'Subscribers'), statItem(abbrev(yt.stats.viewCount), 'Total views'), statItem(fmtNum(yt.stats.videoCount), 'Videos')];
    } else if (platform === 'instagram') {
      if (ig && ig.available && ig.instagram) items = [statItem(abbrev(ig.instagram.followers), 'Followers'), statItem(abbrev(ig.instagram.avgLikes), 'Avg likes'), statItem(abbrev(ig.instagram.avgComments), 'Avg comments')];
    } else if (platform === 'tiktok') {
      if (tt && tt.available && tt.tiktok) items = [statItem(abbrev(tt.tiktok.followers), 'Followers'), statItem(abbrev(tt.tiktok.hearts), 'Total likes'), statItem(fmtNum(tt.tiktok.videoCount), 'Videos')];
    }
    return items.length ? `<div class="content-stats">${items.join('')}</div>` : '';
  }
  function renderContent(data) {
    const tabsEl = $('platformTabs');
    const c = (data && data.content) || { items: [], counts: { all: 0 } };
    contentState.items = Array.isArray(c.items) ? c.items : [];
    contentState.youtube = data ? data.youtube : null;
    contentState.platforms = data ? { youtube: data.youtube, instagram: data.social, tiktok: data.tiktok } : {};
    const counts = c.counts || {};
    const avail = PLATFORMS.filter((p) => counts[p.key]);
    if (!contentState.platform || !counts[contentState.platform]) {
      contentState.platform = avail.length ? avail.slice().sort((a, b) => counts[b.key] - counts[a.key])[0].key : 'youtube';
    }
    tabsEl.innerHTML = avail.map((p) => {
      const n = counts[p.key] || 0;
      const cls = p.key === 'instagram' ? 'ig' : (p.key === 'tiktok' ? 'tt' : '');
      return `<button class="ptab ${cls} ${contentState.platform === p.key ? 'active' : ''}" data-platform="${esc(p.key)}">${esc(p.label)}<span class="ptab-count">${n}</span></button>`;
    }).join('');
    if (!contentState.items.length) {
      contentState.filtered = [];
      const y = contentState.youtube;
      $('content-body').innerHTML = emptyState('No content yet',
        (y && y.reason === 'no_api_key' ? 'Add a YouTube key or connect Apify to pull your latest posts. ' : '') + 'You can also seed ~/.aios/content-sample.json.',
        'YouTube setup → README');
      return;
    }
    renderContentBody(data);
  }
  function renderContentBody(data) {
    const body = $('content-body');
    const c = data ? data.content : null;
    const stats = statStrip(contentState.platform);
    let hint = '';
    if (c && c.sample) {
      hint = `<div class="content-hint"><span class="sample-badge">Sample</span> <span>example posts &mdash; add your keys to pull real content</span></div>`;
    }
    const filtered = contentState.items.filter((i) => i.platform === contentState.platform);
    contentState.filtered = filtered;
    const cards = filtered.map((it, idx) => contentCard(it, idx)).join('');
    const arrows = filtered.length > 2
      ? `<button class="carousel-arrow prev" data-scroll="-1" aria-label="Previous">&#8249;</button><button class="carousel-arrow next" data-scroll="1" aria-label="Next">&#8250;</button>`
      : '';
    const m = contentState.igMetric;
    const toggle = (contentState.platform === 'instagram' && filtered.some((i) => i.views != null || i.likes != null))
      ? `<div class="seg content-metric" id="igMetric">
          <button class="seg-btn ${m === 'views' ? 'active' : ''}" data-metric="views">Views</button>
          <button class="seg-btn ${m === 'likes' ? 'active' : ''}" data-metric="likes">Likes</button>
        </div>`
      : '';
    body.innerHTML = stats + hint + toggle + `<div class="carousel">${arrows}<div class="carousel-track" id="carouselTrack">${cards}</div></div>`;
  }
  function contentCard(it, idx) {
    const plat = ['youtube', 'instagram', 'tiktok'].includes(it.platform) ? it.platform : 'youtube';
    const thumb = safeUrl(it.thumbnail);
    const posterText = esc(it.poster || it.title || '');
    const media = `<div class="cc-poster">${posterText}</div>` + (thumb ? `<img loading="lazy" src="${esc(AIOS.proxyImg(thumb))}" alt="" onerror="this.remove()">` : '');
    const dur = it.durationSec ? `<span class="cc-dur">${fmtDuration(it.durationSec)}</span>` : '';
    const fresh = it.isNew ? '<span class="cc-new">NEW</span>' : '';
    const meta = [cardStat(it), whenLabel(it.time)].filter(Boolean).join(' · ');
    return `<button class="content-card" data-card="${idx}">
      <div class="cc-thumb ${plat}">${media}<span class="cc-badge ${plat}">${esc(it.platform)}</span>${fresh}<span class="cc-expand">&#10138;</span>${dur}</div>
      <div class="cc-title">${esc(it.title || it.poster || '')}</div>
      <div class="cc-meta">${esc(meta)}</div>
    </button>`;
  }
  function openLightbox(idx) {
    const it = (contentState.filtered || [])[idx];
    if (!it) return;
    const plat = ['youtube', 'instagram', 'tiktok'].includes(it.platform) ? it.platform : 'youtube';
    const thumb = safeUrl(it.thumbnail);
    const url = safeUrl(it.url);
    const media = `<div class="lb-poster">${esc(it.poster || it.title || '')}</div>` + (thumb ? `<img src="${esc(AIOS.proxyImg(thumb))}" alt="" onerror="this.remove()">` : '');
    const meta = [cardStat(it), whenLabel(it.time)].filter(Boolean).join(' · ');
    $('lightboxCard').innerHTML = `
      <button class="lb-close" data-close="1" aria-label="Close">&times;</button>
      <div class="lb-thumb ${plat}">${media}</div>
      <div class="lb-body">
        <div class="lb-badge ${plat}">${esc(it.platform)}</div>
        <div class="lb-title">${esc(it.title || it.poster || '')}</div>
        ${meta ? `<div class="lb-meta">${esc(meta)}</div>` : ''}
        ${url ? `<a class="lb-open" href="${esc(url)}" target="_blank" rel="noopener">Open &rarr;</a>` : ''}
      </div>`;
    $('lightbox').hidden = false;
  }
  function closeLightbox() { $('lightbox').hidden = true; $('lightboxCard').innerHTML = ''; }

  // =========================================================================
  // COMPETITORS (ported)
  // =========================================================================
  function renderCompetitors(d) {
    const body = $('competitors-body'), count = $('competitors-count');
    if (!d || !d.available) { if (count) count.textContent = ''; body.innerHTML = emptyState('Loading', 'Top recent detailing videos from other creators load here.', ''); return; }
    const rows = d.competitors || [];
    if (count) count.textContent = rows.length ? rows.length + ' channels' : '';
    if (!rows.length) { body.innerHTML = emptyState('Quiet', 'No competitor videos in the latest pull.', ''); return; }
    body.innerHTML = rows.map((r) => {
      const href = safeUrl(r.url);
      const views = r.views != null ? abbrev(r.views) + ' views' : '';
      const inner = `<div class="row-toprow"><div class="row-title">${esc(r.channel)}</div>${views ? `<span class="delta-badge">${esc(views)}</span>` : ''}</div><div class="row-sub">${esc(r.title)}</div><div class="row-meta">${whenLabel(r.publishedAt)}${href ? ' <span class="arrow">&rarr;</span> watch' : ''}</div>`;
      return `<div class="row">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
    }).join('');
  }

  // =========================================================================
  // COMMENTS (ported)
  // =========================================================================
  const commentState = { items: [], platform: 'all' };
  const COMMENT_PLATFORMS = [
    { key: 'all', label: 'All' },
    { key: 'youtube', label: 'YouTube' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'tiktok', label: 'TikTok' },
  ];
  function renderComments(d) {
    const tabsEl = $('commentTabs');
    commentState.items = (d && Array.isArray(d.comments)) ? d.comments : [];
    const counts = commentState.items.reduce((a, c) => { a[c.platform] = (a[c.platform] || 0) + 1; a.all++; return a; }, { all: 0 });
    if (commentState.platform !== 'all' && !counts[commentState.platform]) commentState.platform = 'all';
    if (tabsEl) {
      tabsEl.innerHTML = COMMENT_PLATFORMS.filter((p) => p.key === 'all' || counts[p.key]).map((p) => {
        const n = p.key === 'all' ? counts.all : counts[p.key];
        const cls = p.key === 'instagram' ? 'ig' : (p.key === 'tiktok' ? 'tt' : '');
        return `<button class="ptab ${cls} ${commentState.platform === p.key ? 'active' : ''}" data-cplatform="${esc(p.key)}">${esc(p.label)}<span class="ptab-count">${n}</span></button>`;
      }).join('');
    }
    renderCommentBody();
  }
  function renderCommentBody() {
    const body = $('comments-body');
    if (!commentState.items.length) {
      body.innerHTML = emptyState('No comments yet', 'Genuine comments on your YouTube and Instagram posts show here as they come in — each tagged with the video it’s from.', '');
      return;
    }
    const rows = commentState.items.filter((c) => commentState.platform === 'all' || c.platform === commentState.platform);
    if (!rows.length) { body.innerHTML = emptyState('Quiet', 'No comments on this platform yet.', ''); return; }
    body.innerHTML = rows.map((c) => {
      const href = safeUrl(c.url);
      const plat = ['youtube', 'instagram', 'tiktok'].includes(c.platform) ? c.platform : 'youtube';
      const likes = c.likes > 0 ? `<span class="cmt-likes">${abbrev(c.likes)} ♥</span>` : '';
      const from = c.video ? `<span class="cmt-from">on “${esc(String(c.video).slice(0, 46))}”</span>` : '';
      const meta = `<div class="row-meta"><span class="cmt-plat ${plat}">${esc(c.platform)}</span>${c.author ? esc('@' + c.author) : ''}${likes}${href ? ' <span class="arrow">&rarr;</span> open' : ''}</div>`;
      const inner = `<div class="row-sub">&ldquo;${esc(c.text)}&rdquo;</div>${from}${meta}`;
      return `<div class="row">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
    }).join('');
  }

  // =========================================================================
  // NET WORTH KPI + live 10s ticker (ported)
  // =========================================================================
  function renderNetWorth(data) {
    const body = $('kpi-mrr-body');
    const nw = (data && data.netWorth) || {};
    const cur = nw.currency || 'USD';
    const sym = cur === 'USD' ? '$' : cur + ' ';
    const total = Number(nw.total) || 0;
    const value = total <= 0 ? '💸💸💸' : `${sym}${fmtNum(Math.round(total))}`;
    const savingsBit = (Number(nw.savings) || 0) > 0 ? ` · Savings ${sym}${abbrev(nw.savings)}` : '';
    const sub = total <= 0
      ? 'tap edit to set bike + bank'
      : `Bike ${sym}${abbrev(nw.motorcycle || 0)} · Bank ${sym}${abbrev(nw.cash || 0)}${savingsBit} · Stocks ${sym}${abbrev(Math.round(nw.stocks || 0))}`;
    body.innerHTML = `<div class="kpi-value money">${total <= 0 ? value : esc(value)}</div><div class="kpi-sub">${esc(sub)}</div><canvas class="kpi-spark" id="nwSpark"></canvas>`;
    drawNwSpark(total);
  }

  // Net-worth sparkline — daily snapshots from the server plus today's live
  // total, so the tile shows where the number has been, not just where it is.
  let nwHistory = [];
  async function loadNwHistory() {
    try { const r = await AIOS.api.get('/api/networth/history'); nwHistory = Array.isArray(r.history) ? r.history : []; }
    catch { nwHistory = []; }
    if (lastData) renderNetWorth(lastData);
  }
  function drawNwSpark(liveTotal) {
    const canvas = $('nwSpark'); if (!canvas) return;
    const today = new Date().toISOString().slice(0, 10);
    const pts = nwHistory.filter((h) => h && h.total > 0 && h.date !== today).map((h) => h.total);
    if (liveTotal > 0) pts.push(liveTotal);
    if (pts.length < 2) { canvas.style.display = 'none'; return; }
    canvas.style.display = 'block';
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 180, h = 22;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = (max - min) || 1;
    const x = (i) => 2 + (i / (pts.length - 1)) * (w - 4);
    const y = (v) => h - 3 - ((v - min) / span) * (h - 7);
    const up = pts[pts.length - 1] >= pts[0];
    ctx.beginPath();
    pts.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
    ctx.strokeStyle = up ? 'rgba(48,209,88,0.85)' : 'rgba(255,69,58,0.85)';
    ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.beginPath();
    ctx.arc(x(pts.length - 1), y(pts[pts.length - 1]), 2, 0, Math.PI * 2);
    ctx.fillStyle = up ? '#30d158' : '#ff453a'; ctx.fill();
  }

  // Freshness strip — when each upstream source last actually succeeded.
  const FRESH_SOURCES = [
    ['crm', 'CRM'], ['quotes', 'Quotes'], ['youtube', 'YouTube'], ['trends', 'Trends'],
    ['social', 'Social'], ['nextdoor', 'Nextdoor'], ['brief', 'Brief'],
  ];
  async function loadFreshness() {
    const el = $('freshStrip'); if (!el) return;
    let src = {};
    try { const r = await AIOS.api.get('/api/freshness'); src = (r && r.sources) || {}; } catch { /* leave empty */ }
    el.innerHTML = FRESH_SOURCES.map(([key, label]) => {
      const ts = src[key];
      const age = ts ? Date.now() - new Date(ts).getTime() : null;
      const cls = age == null ? 'off' : (age < 2 * 3600e3 ? 'ok' : (age < 24 * 3600e3 ? 'warn' : 'bad'));
      const when = ts ? timeAgo(ts) : 'never';
      return `<span class="fresh-chip" title="${esc(label)} last succeeded: ${esc(when)}"><span class="fresh-dot ${cls}"></span>${esc(label)}<em>${esc(when)}</em></span>`;
    }).join('');
  }

  let dashTimer = null, dashHoldings = [], dashBaselines = {}, liveQuotes = {};
  async function loadDashStocks() {
    try {
      const pf = await AIOS.api.get('/api/portfolio');
      dashHoldings = (pf && pf.positions) ? pf.positions.map((p) => ({ ticker: p.ticker, shares: p.shares, price: p.price })) : [];
    } catch { /* keep prior holdings */ }
    if (stocksMonth && stocksMonth.perTicker) {
      dashBaselines = {};
      stocksMonth.perTicker.forEach((p) => { dashBaselines[p.ticker] = p.baseline; });
    }
    startDashPolling();
  }
  function startDashPolling() { stopDashPolling(); pollDashStocks(); dashTimer = setInterval(pollDashStocks, 10000); }
  function stopDashPolling() { if (dashTimer) { clearInterval(dashTimer); dashTimer = null; } }
  async function pollDashStocks() {
    if (!visible) { stopDashPolling(); return; }
    if (!dashHoldings || !dashHoldings.length) return;
    const syms = dashHoldings.map((h) => h.ticker).filter(Boolean);
    try {
      const r = await AIOS.api.get('/api/quotes?symbols=' + encodeURIComponent(syms.join(',')));
      liveQuotes = Object.assign(liveQuotes, r.quotes || {});
    } catch { /* keep last quotes */ }
    const priceOf = (h) => { const q = liveQuotes[h.ticker]; return (q && q.price != null) ? q.price : (Number(h.price) || 0); };
    const stocksValue = dashHoldings.reduce((s, h) => s + (Number(h.shares) || 0) * priceOf(h), 0);
    const a = (lastData && lastData.metrics && lastData.metrics.assets) || { motorcycle: 0, cash: 0, savings: 0, currency: 'USD' };
    if (lastData) {
      const moto = Number(a.motorcycle) || 0, cash = Number(a.cash) || 0, savings = Number(a.savings) || 0;
      lastData.netWorth = Object.assign({}, lastData.netWorth, {
        available: true, currency: a.currency || 'USD',
        motorcycle: moto, cash, savings, stocks: stocksValue, total: moto + cash + savings + stocksValue, live: true,
      });
      if (!editing.mrr) renderNetWorth(lastData);
    }
    if (stocksMonth && stocksMonth.available && Object.keys(dashBaselines).length) {
      let gain = 0, any = false;
      dashHoldings.forEach((h) => { const b = dashBaselines[h.ticker]; if (b != null) { gain += (Number(h.shares) || 0) * (priceOf(h) - b); any = true; } });
      if (any) { stocksMonth.monthGain = gain; renderDashKpis(businessData); }
    }
  }

  // assets edit → modal (same POST body shape as v1)
  function openAssetsEditor() {
    if (!lastData) return;
    editing.mrr = true;
    const a = (lastData.metrics && lastData.metrics.assets) || { motorcycle: 0, cash: 0, savings: 0 };
    const card = AIOS.openModal(`
      <h3>Net Worth · Assets</h3>
      <div class="form-row"><label>Motorcycle ($)</label><input id="edit-nw-moto" type="number" value="${Number(a.motorcycle) || 0}"></div>
      <div class="form-row"><label>Bank ($)</label><input id="edit-nw-cash" type="number" value="${Number(a.cash) || 0}"></div>
      <div class="form-row"><label>Savings ($)</label><input id="edit-nw-savings" type="number" step="0.01" value="${Number(a.savings) || 0}"></div>
      <div class="kpi-sub" style="margin-bottom:4px">Stocks pull live from your Portfolio.</div>
      <div class="form-actions"><button class="btn btn-ghost" id="nwCancel">Cancel</button><button class="btn btn-primary" id="nwSave">Save</button></div>`,
      { onClose: () => { editing.mrr = false; } });
    card.querySelector('#nwCancel').addEventListener('click', () => AIOS.closeModal());
    card.querySelector('#nwSave').addEventListener('click', async () => {
      const cur = JSON.parse(JSON.stringify(lastData.metrics || {}));
      cur.assets = cur.assets || {};
      cur.assets.motorcycle = Number(card.querySelector('#edit-nw-moto').value) || 0;
      cur.assets.cash = Number(card.querySelector('#edit-nw-cash').value) || 0;
      cur.assets.savings = Number(card.querySelector('#edit-nw-savings').value) || 0;
      cur.assets.currency = cur.assets.currency || 'USD';
      try { lastData.metrics = await AIOS.api.post('/api/metrics', cur); }
      catch { AIOS.toast('Save failed', 'err'); }
      const sv = (lastData.metrics && lastData.metrics.assets) || cur.assets;
      const stocks = (lastData.netWorth && lastData.netWorth.stocks) || 0;
      lastData.netWorth = Object.assign({}, lastData.netWorth, {
        available: true, currency: sv.currency || 'USD',
        motorcycle: sv.motorcycle, cash: sv.cash, savings: sv.savings, stocks,
        total: (Number(sv.motorcycle) || 0) + (Number(sv.cash) || 0) + (Number(sv.savings) || 0) + stocks,
      });
      AIOS.closeModal();
      renderNetWorth(lastData);
      AIOS.sound('tick');
    });
  }

  // =========================================================================
  // CRM (Firestore) + hero revenue + KPIs (ported) + crm publish for goals
  // =========================================================================
  // CRM reads go through the server (GET /api/crm) — the read-only Firestore
  // credential lives in ~/.crm-service-creds.json on the PC and is never
  // served to the browser.
  let businessLoaded = false, businessData = null;
  function computeBusiness(clients, bookings) {
    const today = new Date().toISOString().slice(0, 10);
    const ym = today.slice(0, 7);
    const done = (b) => b.status === 'completed' || !b.status;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const monthRev = bookings.filter((b) => (b.date || '').startsWith(ym) && done(b)).reduce((s, b) => s + num(b.price), 0);
    const lastM = new Date(); lastM.setDate(1); lastM.setMonth(lastM.getMonth() - 1);
    const lastYm = lastM.toISOString().slice(0, 7);
    const todayDay = Number(today.slice(8, 10));
    const lastMonthRev = bookings.filter((b) => {
      const d = b.date || '';
      return d.startsWith(lastYm) && Number(d.slice(8, 10)) <= todayDay && done(b);
    }).reduce((s, b) => s + num(b.price), 0);
    const allRev = bookings.filter(done).reduce((s, b) => s + num(b.price), 0);
    const upcoming = bookings.filter((b) => (b.date || '') >= today && b.status !== 'cancelled')
      .sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
    const jobsThisMonth = bookings.filter((b) => (b.date || '').startsWith(ym)).length;
    return { customers: clients.length, monthRev, lastMonthRev, allRev, upcoming, jobsThisMonth, clients, bookings };
  }
  async function loadBusiness(force) {
    if (businessLoaded && !force) { renderDashKpis(businessData); return; }
    renderDashKpis({ loading: true });
    try {
      const r = await AIOS.api.get('/api/crm' + (force ? '?force=1' : ''));
      if (!r || !r.available) throw new Error((r && r.error) || 'CRM unavailable');
      businessData = computeBusiness(r.clients || [], r.bookings || []);
      businessLoaded = true;
      AIOS.state.crm = businessData;
      AIOS.bus.emit('crm', businessData);
      renderRevChart();
      renderHeatmap();
    } catch (e) {
      businessData = { error: String((e && e.message) || e) };
    }
    renderDashKpis(businessData);
  }
  let stocksMonth = null;
  async function loadStocksMonth(force) {
    if (stocksMonth && !force) { renderDashKpis(businessData); return; }
    try { stocksMonth = await AIOS.api.get('/api/stocks/month'); }
    catch { stocksMonth = null; }
    renderDashKpis(businessData);
  }

  // hero figure count-up
  let lastHeroShown = null;
  function countUpHero(target) {
    const el = document.querySelector('#kpi-revenue-body .hero-num');
    if (!el) return;
    const final = fmtNum(Math.round(Math.abs(target)));
    if (RM.matches || lastHeroShown === null || Math.abs(target - lastHeroShown) < 1) {
      el.textContent = final;
      lastHeroShown = target;
      return;
    }
    const from = lastHeroShown, to = Math.abs(target);
    lastHeroShown = target;
    const t0 = performance.now(), DUR = 750;
    (function tick(now) {
      const p = Math.min(1, (now - t0) / DUR);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtNum(Math.round(Math.abs(from) + (to - Math.abs(from)) * ease));
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
      else el.textContent = final;
    })(t0);
  }

  // hero month navigation: 0 = this month, -1 = last month, etc.
  let heroMonthOffset = 0;
  // past-month stock P/L, fetched on demand and cached by ym ('loading' while in flight)
  let stocksByYm = {};
  function loadStocksForYm(ym) {
    if (stocksByYm[ym] !== undefined) return;
    stocksByYm[ym] = 'loading';
    AIOS.api.get('/api/stocks/month?ym=' + ym)
      .then((r) => { stocksByYm[ym] = r || { available: false }; if (heroYm(heroMonthOffset) === ym) renderDashKpis(businessData); })
      .catch(() => { stocksByYm[ym] = { available: false }; });
  }
  function heroMonthDate(offset) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return d; }
  function heroYm(offset) { const d = heroMonthDate(offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  function monthRevFor(bookings, offset) {
    const ym = heroYm(offset);
    const done = (b) => b.status === 'completed' || !b.status;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const rev = (bookings || []).filter((b) => (b.date || '').startsWith(ym) && done(b)).reduce((s, b) => s + num(b.price), 0);
    const jobs = (bookings || []).filter((b) => (b.date || '').startsWith(ym)).length;
    return { rev, jobs };
  }
  // oldest month (as a negative offset from this month) that has any booking
  function earliestHeroOffset(bookings) {
    let min = null;
    for (const b of bookings || []) { const ym = (b.date || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(ym) && (min === null || ym < min)) min = ym; }
    if (min === null) return 0;
    const now = new Date(); const [y, m] = min.split('-').map(Number);
    return Math.min(0, (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth()));
  }
  function renderHero(d) {
    const crmOk = d && !d.error && !d.loading;
    const titleEl = $('revenue-title'), tagEl = $('revenue-tag'), prevBtn = $('revPrev'), nextBtn = $('revNext');
    const minOff = crmOk ? earliestHeroOffset(d.bookings) : 0;
    if (heroMonthOffset > 0) heroMonthOffset = 0;
    if (heroMonthOffset < minOff) heroMonthOffset = minOff;
    const isCurrent = heroMonthOffset === 0;
    const date = heroMonthDate(heroMonthOffset);
    let detail = null, lastDetail = 0, jobs = 0;
    if (crmOk) {
      if (isCurrent) { detail = Number(d.monthRev) || 0; lastDetail = Number(d.lastMonthRev) || 0; jobs = d.jobsThisMonth || 0; }
      else { const cur = monthRevFor(d.bookings, heroMonthOffset); detail = cur.rev; jobs = cur.jobs; lastDetail = monthRevFor(d.bookings, heroMonthOffset - 1).rev; }
    }
    // stocks P/L: live for this month, computed from historical closes for past months
    let stock = null;
    if (isCurrent) {
      stock = (stocksMonth && stocksMonth.available) ? Number(stocksMonth.monthGain) || 0 : null;
    } else if (crmOk) {
      const ym = heroYm(heroMonthOffset);
      const s = stocksByYm[ym];
      if (s === undefined) loadStocksForYm(ym); // fetch, then re-render when it lands
      else if (s && s !== 'loading' && s.available) stock = Number(s.monthGain) || 0;
    }
    if (titleEl) titleEl.textContent = isCurrent ? 'Revenue · This Month' : 'Revenue · ' + date.toLocaleDateString([], { month: 'long', year: 'numeric' });
    if (tagEl) tagEl.textContent = stock != null ? 'detailing + stocks' : 'detailing';
    if (nextBtn) nextBtn.disabled = !crmOk || heroMonthOffset >= 0;
    if (prevBtn) prevBtn.disabled = !crmOk || heroMonthOffset <= minOff;
    renderHeroRevenue(detail, stock, jobs, lastDetail, { date });
  }

  function renderHeroRevenue(detail, stock, jobsThisMonth, lastDetail, opts) {
    opts = opts || {};
    const refDate = opts.date || new Date();
    const body = $('kpi-revenue-body'); if (!body) return;
    if (detail == null && stock == null) {
      body.innerHTML = `<div class="hero-figure"><span class="hero-cur">$</span><span class="hero-num">—</span></div><div class="hero-foot">CRM offline — can't read this month's revenue</div>`;
      return;
    }
    const total = (detail || 0) + (stock || 0);
    const sign = total < 0 ? '−' : '';
    const figCls = total >= 0 ? 'pos' : 'neg';
    const max = Math.max(Math.abs(detail || 0), Math.abs(stock || 0), 1);
    const bar = (v) => Math.max(3, Math.round((Math.abs(v) / max) * 100));
    const monthName = refDate.toLocaleDateString([], { month: 'long' });
    let deltaHtml = '';
    if (detail != null) {
      const lm = new Date(refDate); lm.setDate(1); lm.setMonth(lm.getMonth() - 1);
      const lastName = lm.toLocaleDateString([], { month: 'short' });
      if (lastDetail > 0) {
        const pct = ((detail - lastDetail) / lastDetail) * 100;
        const cls = pct > 0.5 ? 'pos' : (pct < -0.5 ? 'neg' : 'flat');
        const arrow = pct > 0.5 ? '▲' : (pct < -0.5 ? '▼' : '▬');
        deltaHtml = `<span class="hero-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(0)}% vs ${esc(lastName)}</span>`;
      } else if (detail > 0) {
        deltaHtml = `<span class="hero-delta pos">▲ new vs ${esc(lastName)}</span>`;
      } else {
        deltaHtml = `<span class="hero-delta flat">▬ 0% vs ${esc(lastName)}</span>`;
      }
    }
    const rows = [];
    if (detail != null) rows.push(`<div class="hb-item"><span class="hb-name">Detailing</span><span class="hb-track"><span class="hb-fill detail" style="width:${bar(detail)}%"></span></span><span class="hb-val money pos">${esc(money(detail))}</span></div>`);
    if (stock != null) rows.push(`<div class="hb-item"><span class="hb-name">Stocks</span><span class="hb-track"><span class="hb-fill ${stock >= 0 ? 'pos' : 'neg'}" style="width:${bar(stock)}%"></span></span><span class="hb-val money ${stock >= 0 ? 'pos' : 'neg'}">${esc(signed(stock))}</span></div>`);
    const jobs = jobsThisMonth || 0;
    body.innerHTML =
      `<div class="hero-figure ${figCls}"><span class="hero-cur money">${sign}$</span><span class="hero-num money">${esc(fmtNum(Math.round(Math.abs(total))))}</span>${deltaHtml}</div>` +
      `<div class="hero-breakdown">${rows.join('')}</div>` +
      `<div class="hero-foot">${esc(monthName)}${detail != null ? ' · ' + jobs + ' job' + (jobs === 1 ? '' : 's') + ' booked' : ''}${stock != null ? ' · stocks are paper P/L' : ''}</div>`;
    countUpHero(total);
  }
  function renderDashKpis(d) {
    const kpi = (id, val, sub) => { const el = $(id); if (el) el.innerHTML = `<div class="kpi-value">${val}</div><div class="kpi-sub">${esc(sub || '')}</div>`; };
    if (d && d.loading) { const b = $('kpi-revenue-body'); if (b) b.innerHTML = `<div class="hero-figure"><span class="hero-cur">$</span><span class="hero-num">…</span></div>`; kpi('kpi-customers-body', '…', ''); kpi('kpi-jobs-body', '…', ''); return; }
    const crmOk = d && !d.error && !d.loading;
    renderHero(d);
    if (!crmOk) { kpi('kpi-customers-body', '—', 'CRM offline'); kpi('kpi-jobs-body', '—', ''); return; }
    kpi('kpi-customers-body', fmtNum(d.customers), 'total');
    kpi('kpi-jobs-body', fmtNum(d.upcoming.length), d.upcoming[0] ? 'next ' + fmtBookingDate(d.upcoming[0].date) : 'none scheduled');
  }
  function fmtBookingDate(d) {
    if (!d) return '';
    const x = new Date(d + 'T00:00');
    return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // =========================================================================
  // NEW: revenue chart + bookings heatmap (from CRM bookings)
  // =========================================================================
  let revMode = 'month', revValMode = '$';
  // window paging: 0 = window ends now; each step back = 1 month / 1 week
  let revOffset = 0, heatOffset = 0;
  const isDone = (b) => b.status === 'completed' || !b.status;
  const bPrice = (b) => { const n = Number(b.price); return Number.isFinite(n) ? n : 0; };
  function earliestBookingDate() {
    let min = null;
    for (const b of (businessData && businessData.bookings) || []) {
      const d = (b.date || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (min === null || d < min)) min = d;
    }
    return min;
  }
  function renderRevChart() {
    const canvas = $('revChart');
    if (!canvas) return;
    const bookings = (businessData && businessData.bookings) || [];
    if (!bookings.length) { AIOS.charts.bars(canvas, [], {}); return; }
    if (revOffset < 0) revOffset = 0;
    let items = [];
    let windowStart = null, windowEnd = null; // for the range label + prev cap
    if (revMode === 'month') {
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i - revOffset);
        const ym = d.toISOString().slice(0, 7);
        if (i === 5) windowStart = new Date(d);
        if (i === 0) windowEnd = new Date(d);
        const v = bookings.filter((b) => (b.date || '').startsWith(ym) && isDone(b)).reduce((s, b) => s + bPrice(b), 0);
        items.push({ label: d.toLocaleDateString([], { month: 'short' }), value: v });
      }
    } else {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const monday = new Date(now); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - revOffset * 7);
      for (let i = 7; i >= 0; i--) {
        const w0 = new Date(monday); w0.setDate(w0.getDate() - i * 7);
        const w1 = new Date(w0); w1.setDate(w1.getDate() + 7);
        if (i === 7) windowStart = new Date(w0);
        if (i === 0) windowEnd = new Date(w1);
        const a = w0.toISOString().slice(0, 10), b1 = w1.toISOString().slice(0, 10);
        const v = bookings.filter((b) => { const d = b.date || ''; return d >= a && d < b1 && isDone(b); }).reduce((s, b) => s + bPrice(b), 0);
        items.push({ label: (w0.getMonth() + 1) + '/' + w0.getDate(), value: v });
      }
    }
    // nav state + range label (only shown when looking at the past)
    const range = $('trendRange'), tPrev = $('trendPrev'), tNext = $('trendNext');
    if (range) {
      range.textContent = revOffset > 0 && windowStart && windowEnd
        ? windowStart.toLocaleDateString([], { month: 'short', year: '2-digit' }) + ' – ' + windowEnd.toLocaleDateString([], { month: 'short', year: '2-digit' })
        : '';
    }
    if (tNext) tNext.disabled = revOffset <= 0;
    if (tPrev) {
      const earliest = earliestBookingDate();
      // stop paging back once the window's END has moved past the oldest booking
      tPrev.disabled = !!(earliest && windowEnd && windowEnd.toISOString().slice(0, 10) < earliest);
    }
    if (!items.some((it) => it.value > 0)) { AIOS.charts.bars(canvas, [], {}); return; }
    // bar HEIGHTS are always revenue; the $/% toggle switches the printed labels
    items.forEach((it, i) => {
      if (revValMode === '%') {
        const prev = i > 0 ? items[i - 1].value : null;
        if (prev == null) { it.display = '—'; }
        else if (prev > 0) {
          const pct = ((it.value - prev) / prev) * 100;
          it.display = (pct > 0 ? '+' : '') + pct.toFixed(0) + '%';
          it.displayColor = pct > 0.5 ? '#30d158' : (pct < -0.5 ? '#ff453a' : undefined);
        } else { it.display = it.value > 0 ? 'new' : '0%'; }
      } else {
        it.display = AIOS.fmt.money(Math.round(it.value));
      }
    });
    AIOS.charts.bars(canvas, items, { money: true, valueLabels: true });
  }
  function renderHeatmap() {
    const canvas = $('heatChart');
    if (!canvas) return;
    const bookings = (businessData && businessData.bookings) || [];
    const todayIso = new Date().toISOString().slice(0, 10);
    const byDay = {}; // date -> { count, upcoming }
    let doneTotal = 0, upTotal = 0;
    for (const b of bookings) {
      const d = (b.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || b.status === 'cancelled') continue;
      const future = d > todayIso;
      if (!future && !isDone(b)) continue; // past no-show/pending — skip, as before
      const e = byDay[d] || (byDay[d] = { count: 0, upcoming: false });
      e.count++;
      if (future) { e.upcoming = true; upTotal++; } else doneTotal++;
    }
    const hc = $('heat-count');
    if (heatOffset < 0) heatOffset = 0;
    if (hc) {
      hc.textContent = heatOffset > 0
        ? 'window −' + (heatOffset * 4) + ' wk'
        : [doneTotal ? doneTotal + ' completed' : '', upTotal ? upTotal + ' upcoming' : ''].filter(Boolean).join(' · ');
    }
    const hPrev = $('heatPrev'), hNext = $('heatNext');
    if (hNext) hNext.disabled = heatOffset <= 0;
    if (hPrev) {
      const earliest = earliestBookingDate();
      // window end ≈ today − heatOffset*4wk (+4 ahead); stop once it's past the oldest booking
      const end = new Date(); end.setDate(end.getDate() - heatOffset * 28 + 28);
      hPrev.disabled = !!(earliest && end.toISOString().slice(0, 10) < earliest);
    }
    AIOS.charts.heatmap(
      canvas,
      Object.entries(byDay).map(([date, e]) => ({ date, count: e.count, upcoming: e.upcoming })),
      { weeks: 13, aheadWeeks: 4, unit: 'bookings', backWeeks: heatOffset * 4 },
    );
  }

  // =========================================================================
  // NEW: AI Daily Briefing
  // =========================================================================
  let briefTimer = null, briefPollStart = 0, briefNotified = '';
  function stopBriefPoll() { if (briefTimer) { clearInterval(briefTimer); briefTimer = null; } }
  function renderBrief(b) {
    const body = $('brief-body'); if (!body) return;
    if (!b || b.status === 'none') {
      body.innerHTML = emptyState('No briefing yet', 'Claude reads your second brain and writes a daily action plan right here.', '') +
        `<div style="text-align:center"><button class="btn btn-primary" id="briefGo">Generate briefing</button></div>`;
      return;
    }
    if (b.status === 'loading') { body.innerHTML = `<div class="brief-generating">CONNECTING</div>`; return; }
    if (b.status === 'generating') { body.innerHTML = `<div class="brief-generating">CLAUDE IS THINKING</div>`; return; }
    if (b.status === 'error') {
      body.innerHTML = emptyState('Generation failed', String(b.error || 'The claude CLI run errored — try again.').slice(0, 140), '') +
        `<div style="text-align:center"><button class="btn btn-ghost" id="briefGo">Retry</button></div>`;
      return;
    }
    briefLatest = b;
    briefIdx = 0;
    paintBrief(b, 0);
    if (b.generatedAt && briefNotified && briefNotified !== b.generatedAt) {
      AIOS.notify({ id: 'brief:' + b.generatedAt, kind: 'system', title: 'Daily briefing ready', body: String(b.text || '').slice(0, 80), page: 'dashboard' });
      AIOS.sound('success');
    }
    if (b.generatedAt) briefNotified = b.generatedAt;
  }

  // Brief history pager — ‹ pages back through the last 14 briefs (server keeps
  // them in ~/.aios/brief-history.json), › returns toward today.
  let briefLatest = null, briefHist = null, briefIdx = 0;
  function briefList() {
    const list = (briefHist || []).slice();
    if (briefLatest && briefLatest.generatedAt && !list.some((x) => x.generatedAt === briefLatest.generatedAt)) {
      list.push({ generatedAt: briefLatest.generatedAt, text: briefLatest.text });
    }
    return list; // chronological, oldest first
  }
  function paintBrief(entry, idx) {
    const body = $('brief-body'); if (!body || !entry) return;
    const list = briefList();
    const n = list.length;
    const canBack = briefHist === null ? true : idx < n - 1; // before history loads, let ‹ try
    const when = entry.generatedAt ? timeAgo(entry.generatedAt) : 'just now';
    body.innerHTML = `<div class="brief-text">${esc(String(entry.text || '').trim())}</div>` +
      `<div class="brief-meta"><button class="hero-nav brief-nav" id="briefPrev" title="Older brief" ${canBack ? '' : 'disabled'}>‹</button>` +
      `<span>${idx > 0 ? 'Brief from ' + esc(when) : 'Generated ' + esc(when)}${n > 1 ? ' · ' + (n - idx) + '/' + n : ''}</span>` +
      `<button class="hero-nav brief-nav" id="briefNext" title="Newer brief" ${idx > 0 ? '' : 'disabled'}>›</button></div>`;
  }
  async function pageBrief(dir) {
    if (briefHist === null) {
      try { const r = await AIOS.api.get('/api/brief/history'); briefHist = Array.isArray(r.briefs) ? r.briefs : []; }
      catch { briefHist = []; }
    }
    const list = briefList();
    if (!list.length) return;
    briefIdx = Math.max(0, Math.min(list.length - 1, briefIdx + dir));
    paintBrief(list[list.length - 1 - briefIdx], briefIdx);
  }
  async function loadBrief() {
    let b = null;
    try { b = await AIOS.api.get('/api/brief'); } catch { b = { status: 'none' }; }
    if (b && b.generatedAt && !briefNotified) briefNotified = b.generatedAt; // don't notify for pre-existing brief
    renderBrief(b);
    if (b && b.status === 'generating') startBriefPoll();
  }
  function startBriefPoll() {
    stopBriefPoll();
    briefPollStart = Date.now();
    briefTimer = setInterval(async () => {
      if (Date.now() - briefPollStart > 4 * 60 * 1000) { stopBriefPoll(); return; }
      try {
        const b = await AIOS.api.get('/api/brief');
        renderBrief(b);
        if (b.status === 'ready' || b.status === 'error') stopBriefPoll();
      } catch { /* poll again */ }
    }, 5000);
  }
  async function generateBrief() {
    renderBrief({ status: 'generating' });
    try { await AIOS.api.post('/api/brief/generate', {}); }
    catch { AIOS.toast('Could not start the briefing', 'err'); renderBrief({ status: 'none' }); return; }
    AIOS.sound('open');
    startBriefPoll();
  }

  // =========================================================================
  // TO-DO (ported — same localStorage key, his checks survive)
  // =========================================================================
  // Seeds live server-side in ~/.aios/todos.json (GET /api/todos) so updating
  // them is a data edit, not a code edit. Checks/custom/hidden stay in
  // localStorage exactly as before.
  let todoSeed = [];
  async function loadTodoSeeds() {
    try {
      const r = await AIOS.api.get('/api/todos');
      todoSeed = Array.isArray(r.items) ? r.items : [];
    } catch { todoSeed = []; }
    renderTodo();
  }
  const TODO_KEY = 'aios.todo.v1';
  let todoState = (() => { try { return Object.assign({ done: {}, custom: [], hidden: {}, expanded: {} }, JSON.parse(localStorage.getItem(TODO_KEY) || '{}')); } catch { return { done: {}, custom: [], hidden: {}, expanded: {} }; } })();
  const saveTodo = () => { try { localStorage.setItem(TODO_KEY, JSON.stringify(todoState)); } catch { /* ignore */ } };
  const todoItems = () => todoSeed.concat(todoState.custom || []).filter((t) => !todoState.hidden[t.id]);
  function renderTodo() {
    const body = $('todo-body'), count = $('todo-count'); if (!body) return;
    const items = todoItems();
    const openN = items.filter((t) => !todoState.done[t.id]).length;
    if (count) count.textContent = openN ? openN + ' open' : 'all clear ✓';
    const add = `<div class="todo-add"><input id="todoInput" placeholder="Add a task…" maxlength="90" autocomplete="off"><button id="todoAdd" class="btn">Add</button></div>`;
    const rows = items.map((t) => {
      const done = !!todoState.done[t.id];
      const open = !!(todoState.expanded && todoState.expanded[t.id]);
      const hasSub = !!t.sub;
      return `<div class="todo ${done ? 'done' : ''} ${open ? 'open' : ''}" data-todo="${esc(t.id)}">`
        + `<button class="todo-box" data-todocheck="${esc(t.id)}" title="Mark done">✓</button>`
        + `<div class="todo-main"${hasSub ? ` data-todotoggle="${esc(t.id)}"` : ''}>`
          + `<div class="todo-row1">`
            + `<span class="todo-title">${esc(t.title)}</span>`
            + `<span class="todo-tag ${esc(t.tag || '')}">${esc(t.tag || '')}</span>`
            + (hasSub ? `<span class="todo-caret">&#9656;</span>` : '')
          + `</div>`
          + (hasSub ? `<div class="todo-detail"><p class="todo-sub">${esc(t.sub)}</p></div>` : '')
        + `</div>`
        + `<button class="todo-del" data-tododel="${esc(t.id)}" title="Remove">&times;</button>`
        + `</div>`;
    }).join('');
    body.innerHTML = add + rows;
  }
  function addTodo() {
    const inp = $('todoInput'); if (!inp) return;
    const v = inp.value.trim(); if (!v) return;
    todoState.custom = todoState.custom || [];
    todoState.custom.push({ id: 'c-' + Date.now(), title: v, tag: 'me' });
    saveTodo(); renderTodo();
    AIOS.sound('tick');
  }

  // =========================================================================
  // EVENTS (scoped to the page element where possible)
  // =========================================================================
  function bindEvents(el) {
    el.addEventListener('click', (e) => {
      // content tabs / carousel / cards
      const pt = e.target.closest('#platformTabs .ptab');
      if (pt) {
        contentState.platform = pt.getAttribute('data-platform') || contentState.platform;
        el.querySelectorAll('#platformTabs .ptab').forEach((b) => b.classList.toggle('active', b === pt));
        renderContentBody(lastData);
        return;
      }
      const mt = e.target.closest('#igMetric .seg-btn');
      if (mt) {
        contentState.igMetric = mt.getAttribute('data-metric') || 'views';
        renderContentBody(lastData);
        return;
      }
      const arrow = e.target.closest('.carousel-arrow');
      if (arrow) {
        const track = $('carouselTrack');
        if (track) track.scrollBy({ left: (Number(arrow.getAttribute('data-scroll')) || 1) * Math.max(240, track.clientWidth * 0.8), behavior: 'smooth' });
        return;
      }
      const card = e.target.closest('.content-card');
      if (card) { openLightbox(Number(card.getAttribute('data-card'))); return; }
      // comment tabs
      const ct = e.target.closest('#commentTabs .ptab');
      if (ct) {
        commentState.platform = ct.getAttribute('data-cplatform') || 'all';
        el.querySelectorAll('#commentTabs .ptab').forEach((b) => b.classList.toggle('active', b === ct));
        renderCommentBody();
        return;
      }
      // hero month navigation
      if (e.target.closest('#revPrev')) { heroMonthOffset -= 1; renderDashKpis(businessData); return; }
      if (e.target.closest('#revNext')) { heroMonthOffset += 1; renderDashKpis(businessData); return; }
      // trend / heatmap window paging
      if (e.target.closest('#trendPrev')) { revOffset += 1; renderRevChart(); return; }
      if (e.target.closest('#trendNext')) { revOffset -= 1; renderRevChart(); return; }
      if (e.target.closest('#heatPrev')) { heatOffset += 1; renderHeatmap(); return; }
      if (e.target.closest('#heatNext')) { heatOffset -= 1; renderHeatmap(); return; }
      // brief history pager
      if (e.target.closest('#briefPrev')) { pageBrief(1); return; }
      if (e.target.closest('#briefNext')) { pageBrief(-1); return; }
      // revenue chart mode
      const rs = e.target.closest('#revSeg .seg-btn');
      if (rs) {
        revMode = rs.getAttribute('data-rev') || 'month';
        el.querySelectorAll('#revSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === rs));
        renderRevChart();
        return;
      }
      const rv = e.target.closest('#revValSeg .seg-btn');
      if (rv) {
        revValMode = rv.getAttribute('data-revval') || '$';
        el.querySelectorAll('#revValSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === rv));
        renderRevChart();
        return;
      }
      // brief
      if (e.target.closest('#briefGen') || e.target.closest('#briefGo')) { generateBrief(); return; }
      // net worth edit
      if (e.target.closest('#nwEdit')) { openAssetsEditor(); return; }
      // todo
      if (e.target.closest('#todoReset')) { todoState.done = {}; saveTodo(); renderTodo(); return; }
      if (e.target.closest('#todoAdd')) { addTodo(); return; }
      const del = e.target.closest('[data-tododel]');
      if (del) { const id = del.getAttribute('data-tododel'); if (id.indexOf('c-') === 0) todoState.custom = (todoState.custom || []).filter((t) => t.id !== id); else todoState.hidden[id] = true; delete todoState.done[id]; saveTodo(); renderTodo(); return; }
      const check = e.target.closest('[data-todocheck]');
      if (check) { const id = check.getAttribute('data-todocheck'); todoState.done[id] = !todoState.done[id]; saveTodo(); renderTodo(); if (todoState.done[id]) AIOS.sound('tick'); return; }
      const tog = e.target.closest('[data-todotoggle]');
      if (tog) { const id = tog.getAttribute('data-todotoggle'); todoState.expanded = todoState.expanded || {}; todoState.expanded[id] = !todoState.expanded[id]; saveTodo(); renderTodo(); return; }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'todoInput') { e.preventDefault(); addTodo(); }
    });
    // lightbox close (global element)
    $('lightbox').addEventListener('click', (e) => {
      if (e.target.classList.contains('lightbox-backdrop') || e.target.closest('[data-close]')) closeLightbox();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  }

  // =========================================================================
  // REGISTER
  // =========================================================================
  AIOS.registerPage({
    id: 'dashboard',
    title: 'Command Center',
    sub: 'YDdetailers · content & growth',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="3" width="8" height="5" rx="2" fill="currentColor"/><rect x="13" y="10" width="8" height="11" rx="2" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="2" fill="currentColor"/></svg>',
    mount,
    onData,
    onShow() {
      visible = true;
      loadBusiness();
      loadStocksMonth();
      loadDashStocks();
    },
    onHide() {
      visible = false;
      stopDashPolling();
      stopBriefPoll();
    },
  });
})();
