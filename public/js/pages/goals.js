'use strict';
/*
 * AIOS page: Goals — savings targets with HUD rings (NEW in v2).
 * Rings via AIOS.charts.gauge; projections from the CRM detailing pace
 * (published by the dashboard on bus 'crm'); milestones celebrate.
 */
(() => {
  const { esc, emptyState } = AIOS.util;
  const $ = (id) => document.getElementById(id);
  const MILESTONES = [25, 50, 75, 100];

  let goals = [];
  let loaded = false;
  let saveTimer = null;

  // monthly detailing pace = average of the last 3 full-ish calendar months
  function monthlyPace() {
    const crm = AIOS.state.crm;
    if (!crm || !Array.isArray(crm.bookings)) return null;
    const done = (b) => b.status === 'completed' || !b.status;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    let total = 0, months = 0;
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const ym = d.toISOString().slice(0, 7);
      const v = crm.bookings.filter((b) => (b.date || '').startsWith(ym) && done(b)).reduce((s, b) => s + num(b.price), 0);
      total += v; months++;
    }
    const pace = months ? total / months : 0;
    return pace > 0 ? pace : null;
  }

  function projection(g) {
    const remaining = Math.max(0, (Number(g.target) || 0) - (Number(g.saved) || 0));
    if (remaining === 0) return 'target hit 🏁';
    const pace = monthlyPace();
    if (!pace) return 'at your pace: —';
    const days = Math.ceil(remaining / (pace / 30));
    const eta = new Date(); eta.setDate(eta.getDate() + days);
    const label = eta.toLocaleDateString([], { month: 'short', year: 'numeric' });
    return `at your pace (${AIOS.fmt.money(Math.round(pace))}/mo): ~${label}`;
  }

  // =========================================================================
  function mount(el) {
    el.innerHTML = `
      <section class="goals-summary">
        <div class="card mini-stat"><span class="ms-label">Total Saved</span><span class="ms-val money" id="gs-saved">—</span><span class="ms-sub">across goals</span></div>
        <div class="card mini-stat"><span class="ms-label">Total Target</span><span class="ms-val money" id="gs-target">—</span><span class="ms-sub">combined</span></div>
        <div class="card mini-stat"><span class="ms-label">Overall</span><span class="ms-val" id="gs-pct">—</span><span class="ms-sub">of the way there</span></div>
      </section>
      <div class="goal-grid" id="goalGrid"></div>`;
    bindEvents(el);
    fetchGoals();
    AIOS.bus.on('crm', () => { if (loaded) render(); });
  }

  async function fetchGoals() {
    try {
      const s = await AIOS.api.get('/api/goals');
      goals = (s && Array.isArray(s.goals)) ? s.goals : [];
      loaded = true;
    } catch {
      goals = [];
    }
    render();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try { await AIOS.api.post('/api/goals', { goals }); }
      catch { AIOS.toast('Goals save failed', 'err'); }
    }, 500);
  }

  // =========================================================================
  function render() {
    renderSummary();
    const grid = $('goalGrid');
    if (!grid) return;
    if (!goals.length) {
      grid.innerHTML = `
        <article class="card goal-card" style="grid-column:1/-1">
          ${emptyState('No goals yet', 'Set your first target — every dollar YDdetailers makes can push a ring forward.', '')}
          <button class="btn btn-primary" id="goalFirst">+ Set your first goal</button>
        </article>`;
      return;
    }
    grid.innerHTML = goals.map((g) => {
      const pct = Math.min(1, (Number(g.saved) || 0) / Math.max(1, Number(g.target) || 1));
      const hit = pct >= 1;
      const remaining = Math.max(0, (Number(g.target) || 0) - (Number(g.saved) || 0));
      return `<article class="card goal-card${hit ? ' done' : ''}" data-goal="${esc(g.id)}">
        <canvas class="goal-ring" data-ring="${esc(g.id)}"></canvas>
        <div class="goal-name"><span>${esc(g.icon || '🎯')}</span>${esc(g.name)}</div>
        <div class="goal-fig"><span class="money">${esc(AIOS.fmt.money(Number(g.saved) || 0))}</span> of <span class="money">${esc(AIOS.fmt.money(Number(g.target) || 0))}</span></div>
        <div class="goal-proj">${hit ? 'DONE — go get it 🏁' : `<span class="money">${esc(AIOS.fmt.money(remaining))}</span> to go · ${esc(projection(g))}`}${g.deadline ? `<br><span class="chip">${esc(new Date(g.deadline + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}</div>
        <div class="goal-actions">
          <button class="btn" data-progress="${esc(g.id)}">+ Add progress</button>
          <button class="btn btn-ghost" data-edit="${esc(g.id)}" title="Edit">✎</button>
        </div>
      </article>`;
    }).join('') + `
      <button class="card goal-card goal-add" id="goalAdd"><span class="plus">+</span>New goal</button>`;
    // draw rings after DOM lands
    requestAnimationFrame(() => {
      for (const g of goals) {
        const c = grid.querySelector(`[data-ring="${CSS.escape(g.id)}"]`);
        if (!c) continue;
        const pct = Math.min(1, (Number(g.saved) || 0) / Math.max(1, Number(g.target) || 1));
        AIOS.charts.gauge(c, pct, { label: pct >= 1 ? 'COMPLETE' : 'of target', color: pct >= 1 ? getComputedStyle(document.documentElement).getPropertyValue('--green').trim() : undefined });
      }
    });
  }

  function renderSummary() {
    const saved = goals.reduce((s, g) => s + (Number(g.saved) || 0), 0);
    const target = goals.reduce((s, g) => s + (Number(g.target) || 0), 0);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('gs-saved', goals.length ? AIOS.fmt.money(saved) : '—');
    set('gs-target', goals.length ? AIOS.fmt.money(target) : '—');
    set('gs-pct', target > 0 ? Math.round((saved / target) * 100) + '%' : '—');
  }

  // =========================================================================
  function checkMilestones(g) {
    const pct = ((Number(g.saved) || 0) / Math.max(1, Number(g.target) || 1)) * 100;
    const last = Number(g.lastMilestone) || 0;
    let crossed = 0;
    for (const m of MILESTONES) if (pct >= m && m > last) crossed = m;
    if (!crossed) return;
    g.lastMilestone = crossed;
    AIOS.notify({
      id: 'goal:' + g.id + ':' + crossed,
      kind: 'system',
      title: `${g.icon || '🎯'} ${g.name} — ${crossed}%`,
      body: crossed === 100 ? 'TARGET HIT 🏁' : 'Keep pushing',
      page: 'goals',
    });
    AIOS.sound('cash');
    AIOS.bus.emit('celebrate', { reason: crossed === 100 ? 'goal-hit' : 'goal-milestone' });
  }

  function openGoalModal(existing) {
    const g = existing || {};
    const card = AIOS.openModal(`
      <h3>${existing ? 'Edit Goal' : 'New Goal'}</h3>
      <div class="form-row"><label>Name *</label><input id="g-name" type="text" maxlength="80" value="${esc(g.name || '')}" placeholder="New bike fund"></div>
      <div class="form-grid">
        <div class="form-row"><label>Icon (emoji)</label><input id="g-icon" type="text" maxlength="8" value="${esc(g.icon || '🎯')}"></div>
        <div class="form-row"><label>Deadline (optional)</label><input id="g-deadline" type="date" value="${esc(g.deadline || '')}"></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label>Target ($) *</label><input id="g-target" type="number" min="1" step="50" value="${g.target != null ? Number(g.target) : ''}"></div>
        <div class="form-row"><label>Saved so far ($)</label><input id="g-saved" type="number" min="0" step="10" value="${g.saved != null ? Number(g.saved) : 0}"></div>
      </div>
      <div class="form-actions">
        ${existing ? '<button class="btn btn-danger" id="gDelete">Delete</button>' : ''}
        <button class="btn btn-ghost" id="gCancel">Cancel</button>
        <button class="btn btn-primary" id="gSave">${existing ? 'Save' : 'Create goal'}</button>
      </div>`);
    card.querySelector('#g-name').focus();
    card.querySelector('#gCancel').addEventListener('click', () => AIOS.closeModal());
    if (existing) {
      let armed = false;
      const del = card.querySelector('#gDelete');
      del.addEventListener('click', () => {
        if (!armed) { armed = true; del.textContent = 'Sure? Delete forever'; setTimeout(() => { armed = false; if (del.isConnected) del.textContent = 'Delete'; }, 3000); return; }
        goals = goals.filter((x) => x.id !== g.id);
        AIOS.closeModal();
        render();
        scheduleSave();
      });
    }
    card.querySelector('#gSave').addEventListener('click', () => {
      const name = card.querySelector('#g-name').value.trim();
      const target = Number(card.querySelector('#g-target').value);
      if (!name) { card.querySelector('#g-name').focus(); return; }
      if (!(target > 0)) { card.querySelector('#g-target').focus(); return; }
      const saved = Math.max(0, Number(card.querySelector('#g-saved').value) || 0);
      const icon = card.querySelector('#g-icon').value.trim() || '🎯';
      const deadline = card.querySelector('#g-deadline').value || undefined;
      if (existing) {
        Object.assign(g, { name, target, saved, icon, deadline });
        checkMilestones(g);
      } else {
        const ng = { id: 'g-' + Date.now().toString(36), name, icon, target, saved, deadline, lastMilestone: 0 };
        goals.push(ng);
        checkMilestones(ng);
      }
      AIOS.closeModal();
      render();
      scheduleSave();
      AIOS.sound('tick');
    });
  }

  function openProgressModal(g) {
    const card = AIOS.openModal(`
      <h3>${esc(g.icon || '🎯')} ${esc(g.name)} · Add Progress</h3>
      <div class="form-row"><label>Amount to add ($)</label><input id="p-amt" type="number" min="0" step="10" placeholder="50"></div>
      <div class="kpi-sub" style="margin-bottom:4px">${esc(AIOS.fmt.money(Number(g.saved) || 0))} saved · ${esc(AIOS.fmt.money(Math.max(0, (Number(g.target) || 0) - (Number(g.saved) || 0))))} to go</div>
      <div class="form-actions"><button class="btn btn-ghost" id="pCancel">Cancel</button><button class="btn btn-primary" id="pSave">Add</button></div>`);
    const amt = card.querySelector('#p-amt');
    amt.focus();
    const commit = () => {
      const v = Number(amt.value);
      if (!(v > 0)) { amt.focus(); return; }
      g.saved = (Number(g.saved) || 0) + v;
      checkMilestones(g);
      AIOS.closeModal();
      render();
      scheduleSave();
    };
    card.querySelector('#pCancel').addEventListener('click', () => AIOS.closeModal());
    card.querySelector('#pSave').addEventListener('click', commit);
    amt.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  }

  // =========================================================================
  function bindEvents(el) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('#goalAdd') || e.target.closest('#goalFirst')) { openGoalModal(null); return; }
      const prog = e.target.closest('[data-progress]');
      if (prog) {
        const g = goals.find((x) => x.id === prog.getAttribute('data-progress'));
        if (g) openProgressModal(g);
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const g = goals.find((x) => x.id === edit.getAttribute('data-edit'));
        if (g) openGoalModal(g);
      }
    });
  }

  // =========================================================================
  AIOS.registerPage({
    id: 'goals',
    title: 'Goals',
    sub: 'targets · savings · streaks',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>',
    mount,
    onShow() { if (loaded) fetchGoals(); },
  });
})();
