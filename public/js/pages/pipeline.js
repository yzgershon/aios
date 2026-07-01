'use strict';
/*
 * AIOS page: Pipeline — lead kanban (NEW in v2).
 * NEW → CONTACTED → BOOKED → DONE. Nextdoor leads auto-import server-side
 * into 'new'; cards drag between stages; state persists via /api/pipeline.
 */
(() => {
  const { esc, safeUrl } = AIOS.util;
  const SEEN_KEY = 'aios.pipeline.seen.v1';
  const STAGE_LABEL = { new: 'New', contacted: 'Contacted', booked: 'Booked', done: 'Done' };
  const ADVANCE = { new: 'contacted', contacted: 'booked', booked: 'done' };

  let root = null;
  let state = { columns: ['new', 'contacted', 'booked', 'done'], cards: [] };
  let loaded = false;
  let saveTimer = null;
  let armedDelete = null; // {id, ts}

  let seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; } })();
  const saveSeen = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-300))); } catch { /* ignore */ } };

  // =========================================================================
  function mount(el) {
    root = el;
    el.innerHTML = `
      <section class="pipe-stats">
        <div class="card mini-stat"><span class="ms-label">Leads · Month</span><span class="ms-val" id="ps-month">—</span><span class="ms-sub">captured</span></div>
        <div class="card mini-stat"><span class="ms-label">In Progress</span><span class="ms-val" id="ps-active">—</span><span class="ms-sub">new + contacted</span></div>
        <div class="card mini-stat"><span class="ms-label">Booked · Month</span><span class="ms-val" id="ps-booked">—</span><span class="ms-sub">won</span></div>
        <div class="card mini-stat"><span class="ms-label">Pipeline Value</span><span class="ms-val money" id="ps-value">—</span><span class="ms-sub">est, open stages</span></div>
      </section>
      <section class="kanban" id="kanban"></section>`;
    bindEvents(el);
    fetchState();
  }

  async function fetchState(silent) {
    try {
      const s = await AIOS.api.get('/api/pipeline');
      if (s && Array.isArray(s.cards)) {
        state = { columns: s.columns && s.columns.length ? s.columns : state.columns, cards: s.cards };
        loaded = true;
        detectImports();
        render();
      }
    } catch (e) {
      if (!silent) console.error('pipeline fetch', e);
      if (!loaded) {
        const k = document.getElementById('kanban');
        if (k) k.innerHTML = AIOS.util.emptyState('Pipeline offline', 'Could not reach /api/pipeline — restart the AIOS server and refresh.', '');
      }
    }
  }

  function detectImports() {
    const fresh = state.cards.filter((c) => (c.source === 'meta' || c.source === 'nextdoor') && !seen.includes(c.id));
    let any = false;
    for (const c of fresh) {
      AIOS.notify({
        id: 'lead:' + c.id,
        kind: 'lead',
        title: 'New lead captured',
        body: (c.name || c.title || 'Nextdoor lead') + (c.area ? ' · ' + c.area : ''),
        page: 'pipeline',
      });
      any = true;
    }
    if (any) {
      AIOS.bus.emit('celebrate', { reason: 'lead' });
      AIOS.sound('cash');
    }
    // mark everything seen (manual cards too, silently)
    for (const c of state.cards) if (!seen.includes(c.id)) seen.push(c.id);
    if (state.cards.length) saveSeen();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try { await AIOS.api.post('/api/pipeline', state); }
      catch { AIOS.toast('Pipeline save failed', 'err'); fetchState(true); }
    }, 600);
  }

  // =========================================================================
  function render() {
    renderStats();
    const k = document.getElementById('kanban');
    if (!k) return;
    k.innerHTML = state.columns.map((stage) => {
      const cards = state.cards.filter((c) => c.stage === stage);
      const addBtn = stage === 'new' ? `<button class="kcol-add" id="pipeAdd" title="Add lead">+</button>` : '';
      const emptyHint = {
        new: 'Leads land here automatically<br>from your Meta $50 OFF form.',
        contacted: 'Drag leads here once<br>you’ve replied.',
        booked: 'Drag here when they book.<br>💰',
        done: 'Finished jobs.<br>On to the next.',
      }[stage] || '';
      return `<div class="kcol" data-stage="${esc(stage)}">
        <div class="kcol-head">${esc(STAGE_LABEL[stage] || stage)}<span class="chip">${cards.length}</span>${addBtn}</div>
        <div class="kcol-body" data-stage="${esc(stage)}">
          ${cards.map(cardHtml).join('') || `<div class="kcol-empty">${emptyHint}</div>`}
        </div>
      </div>`;
    }).join('');
  }

  function cardHtml(c) {
    const name = c.name || c.title || 'Lead';
    const src = (c.source || 'manual').toLowerCase();
    const href = safeUrl(c.link);
    const val = Number(c.value) || 0;
    const adv = ADVANCE[c.stage] ? `<button class="kc-adv" data-adv="${esc(c.id)}" title="Move to ${esc(STAGE_LABEL[ADVANCE[c.stage]])}">&rarr;</button>` : '';
    const armed = armedDelete && armedDelete.id === c.id && Date.now() - armedDelete.ts < 3000;
    return `<div class="kcard" draggable="true" data-id="${esc(c.id)}">
      <div class="kc-top"><span class="kc-name ell">${esc(name)}</span><button class="kc-x${armed ? ' armed' : ''}" data-del="${esc(c.id)}">${armed ? 'sure?' : '&times;'}</button></div>
      <div class="kc-meta">
        <span class="chip src-${esc(src)}">${esc(src)}</span>
        ${c.area ? `<span class="chip">${esc(c.area)}</span>` : ''}
        <span class="kc-age">${c.createdAt ? esc(AIOS.fmt.ago(c.createdAt)) : ''}</span>
      </div>
      ${c.note ? `<div class="kc-note clamp2">${esc(c.note)}</div>` : ''}
      <div class="kc-foot">
        ${val > 0 ? `<span class="kc-val money">${esc(AIOS.fmt.money(val))}</span>` : ''}
        ${href ? `<a class="kc-link" href="${esc(href)}" target="_blank" rel="noopener">open &nearr;</a>` : ''}
        ${adv}
      </div>
    </div>`;
  }

  function renderStats() {
    const ym = new Date().toISOString().slice(0, 7);
    const inMonth = (c) => (c.createdAt || '').slice(0, 7) === ym;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ps-month', String(state.cards.filter(inMonth).length));
    set('ps-active', String(state.cards.filter((c) => c.stage === 'new' || c.stage === 'contacted').length));
    set('ps-booked', String(state.cards.filter((c) => c.stage === 'booked' && inMonth(c)).length));
    const open = state.cards.filter((c) => c.stage !== 'done').reduce((s, c) => s + (Number(c.value) || 0), 0);
    set('ps-value', open > 0 ? AIOS.fmt.money(open) : '—');
  }

  // =========================================================================
  function moveCard(id, stage) {
    const c = state.cards.find((x) => x.id === id);
    if (!c || c.stage === stage) return;
    const was = c.stage;
    c.stage = stage;
    render();
    scheduleSave();
    if (stage === 'booked' && was !== 'booked') {
      AIOS.sound('success');
      AIOS.bus.emit('celebrate', { reason: 'booked' });
    } else {
      AIOS.sound('tick');
    }
  }

  function openAddModal() {
    const card = AIOS.openModal(`
      <h3>Add Lead</h3>
      <div class="form-row"><label>Name *</label><input id="pl-name" type="text" maxlength="60" placeholder="Sarah from Waltham"></div>
      <div class="form-grid">
        <div class="form-row"><label>Source</label><select id="pl-src">
          <option value="manual">manual</option><option value="nextdoor">nextdoor</option>
          <option value="meta">meta</option><option value="referral">referral</option>
        </select></div>
        <div class="form-row"><label>Area</label><input id="pl-area" type="text" maxlength="30" placeholder="Newton"></div>
      </div>
      <div class="form-row"><label>Note</label><input id="pl-note" type="text" maxlength="140" placeholder="wants interior reset, has a dog"></div>
      <div class="form-grid">
        <div class="form-row"><label>Link</label><input id="pl-link" type="url" placeholder="https://…"></div>
        <div class="form-row"><label>Est. value ($)</label><input id="pl-val" type="number" min="0" step="5"></div>
      </div>
      <div class="form-actions"><button class="btn btn-ghost" id="plCancel">Cancel</button><button class="btn btn-primary" id="plSave">Add lead</button></div>`);
    card.querySelector('#pl-name').focus();
    card.querySelector('#plCancel').addEventListener('click', () => AIOS.closeModal());
    card.querySelector('#plSave').addEventListener('click', () => {
      const name = card.querySelector('#pl-name').value.trim();
      if (!name) { card.querySelector('#pl-name').focus(); return; }
      const c = {
        id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        source: card.querySelector('#pl-src').value,
        area: card.querySelector('#pl-area').value.trim(),
        note: card.querySelector('#pl-note').value.trim(),
        link: card.querySelector('#pl-link').value.trim(),
        value: Number(card.querySelector('#pl-val').value) || 0,
        createdAt: new Date().toISOString(),
        stage: 'new',
      };
      state.cards.unshift(c);
      seen.push(c.id); saveSeen();
      AIOS.closeModal();
      render();
      scheduleSave();
      AIOS.sound('tick');
    });
  }

  // =========================================================================
  function bindEvents(el) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('#pipeAdd')) { openAddModal(); return; }
      const adv = e.target.closest('[data-adv]');
      if (adv) {
        const c = state.cards.find((x) => x.id === adv.getAttribute('data-adv'));
        if (c && ADVANCE[c.stage]) moveCard(c.id, ADVANCE[c.stage]);
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = del.getAttribute('data-del');
        if (armedDelete && armedDelete.id === id && Date.now() - armedDelete.ts < 3000) {
          state.cards = state.cards.filter((c) => c.id !== id);
          armedDelete = null;
          render();
          scheduleSave();
        } else {
          armedDelete = { id, ts: Date.now() };
          render();
          setTimeout(() => { if (armedDelete && Date.now() - armedDelete.ts >= 3000) { armedDelete = null; render(); } }, 3200);
        }
        return;
      }
    });

    // drag & drop
    el.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.kcard');
      if (!card) return;
      e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    el.addEventListener('dragend', (e) => {
      const card = e.target.closest('.kcard');
      if (card) card.classList.remove('dragging');
      el.querySelectorAll('.kcol.drag-over').forEach((c) => c.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      const col = e.target.closest('.kcol');
      if (!col) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.querySelectorAll('.kcol.drag-over').forEach((c) => { if (c !== col) c.classList.remove('drag-over'); });
      col.classList.add('drag-over');
    });
    el.addEventListener('dragleave', (e) => {
      const col = e.target.closest('.kcol');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    el.addEventListener('drop', (e) => {
      const col = e.target.closest('.kcol');
      if (!col) return;
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const stage = col.getAttribute('data-stage');
      if (id && stage) moveCard(id, stage);
    });
  }

  // =========================================================================
  AIOS.registerPage({
    id: 'pipeline',
    title: 'Pipeline',
    sub: 'YDdetailers · leads → booked',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="4" width="5" height="16" rx="1.8" fill="currentColor"/><rect x="9.5" y="4" width="5" height="11" rx="1.8" fill="currentColor"/><rect x="16" y="4" width="5" height="7" rx="1.8" fill="currentColor"/></svg>',
    mount,
    onShow() { if (loaded) fetchState(true); },
    onData() { fetchState(true); },
  });
})();
