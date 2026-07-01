'use strict';
/*
 * AIOS — Robbie, the dog mascot (panda-style rig, Robbie skin + a bed/home).
 *
 * He roams the active dashboard like the old panda: walks along tile tops,
 * JUMPS from tile to tile (a real coiling leap that lands on a tile's border),
 * and ducks BEHIND tiles now and then. His home is a dog bed parked in the open
 * space of the "Revenue · This Month" card — he starts curled asleep in it,
 * wakes when you click him, roams, and often trots/leaps back to bed to sleep.
 *
 * Poses (curl / sit / side-walk) are CSS-driven; this file drives position,
 * the jump arc (so he can land on tiles at any height), and the behaviour.
 *
 * --- tuning knobs --------------------------------------------------------------
 *   CFG.homeFrac  : bed x within the open space (0 left .. 1 right)
 *   CFG.homeVFrac : bed y within the card (0 top .. 1 bottom; lower number = higher)
 *   CFG.bedDX/DY  : fine bed nudge in px
 *   CFG.homeProb  : chance, when idle, that he heads home to bed vs. roams
 *   CFG.walkMsPerPx, CFG.jumpProb : pace / how jumpy he is
 */
(() => {
  if (!window.AIOS || !AIOS.bus) return;
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const CFG = {
    homeFrac: 0.30,    // toward the left of the open space
    homeVFrac: 0.74,   // lower in the card
    bedDX: 0, bedDY: 0,
    homeProb: 0.16,    // mostly roams; only heads to bed once in a while
    walkMsPerPx: 16,   // ~62px/s, tuned so his paws plant
    BEDW: 160, BED_PAD: 31.5,
  };
  const RW = 104, RH = 120, FOOT = 110;   // box + paw line (px from box top)

  // --- artwork -------------------------------------------------------------
  const SVG = `
<svg class="dog-svg" viewBox="0 0 120 132" width="104" height="120" xmlns="http://www.w3.org/2000/svg">
  <g id="poseCurl">
    <path d="M30 100 C 26 82, 44 72, 66 73 C 88 74, 100 86, 97 102 C 95 111, 82 116, 64 116 C 46 116, 34 112, 30 100 Z" fill="#211f1c"/>
    <path d="M50 106 C 58 100, 74 100, 84 105 C 89 108, 86 115, 76 116 C 62 117, 50 115, 48 110 Z" fill="#e9e7e0"/>
    <circle cx="66" cy="109" r="1" fill="#211f1c" opacity=".4"/>
    <circle cx="74" cy="108" r="1" fill="#211f1c" opacity=".4"/>
    <path d="M95 98 C 103 106, 99 116, 86 116" stroke="#211f1c" stroke-width="6.5" fill="none" stroke-linecap="round"/>
    <circle cx="86" cy="116" r="3.3" fill="#e9e7e0"/>
    <ellipse cx="42" cy="103" rx="15" ry="13" fill="#211f1c"/>
    <path d="M31 99 Q27 109 35 116 Q43 111 41 100 Z" fill="#15130f"/>
    <path d="M40 91 Q43 98 41 104 L45 104 Q47 98 44 91 Z" fill="#e9e7e0"/>
    <path d="M47 104 Q59 105 59 111 Q56 115 48 113 Q44 109 45 105 Z" fill="#e9e7e0"/>
    <ellipse cx="58" cy="110" rx="3" ry="2.6" fill="#141110"/>
    <path d="M37 101 Q41 104 46 102" stroke="#15130f" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </g>

  <g id="poseSit">
    <g class="tail-sit">
      <path d="M88 96 Q104 96 108 82" stroke="#211f1c" stroke-width="9" fill="none" stroke-linecap="round"/>
      <circle cx="108" cy="82" r="4" fill="#e9e7e0"/>
    </g>
    <ellipse cx="45" cy="99" rx="12" ry="18" fill="#211f1c"/>
    <ellipse cx="75" cy="99" rx="12" ry="18" fill="#211f1c"/>
    <ellipse cx="45" cy="106" rx="9" ry="10" fill="#15130f" opacity=".4"/>
    <ellipse cx="75" cy="106" rx="9" ry="10" fill="#15130f" opacity=".4"/>
    <ellipse cx="42" cy="116" rx="7.5" ry="4.4" fill="#e9e7e0"/>
    <ellipse cx="78" cy="116" rx="7.5" ry="4.4" fill="#e9e7e0"/>
    <ellipse cx="60" cy="80" rx="22" ry="25" fill="#211f1c"/>
    <path d="M60 58 C 49 60, 43 76, 46 92 C 49 105, 71 105, 74 92 C 77 76, 71 60, 60 58 Z" fill="#e9e7e0"/>
    <path d="M60 70 C 54 72, 51 82, 53 92 C 56 100, 64 100, 67 92 C 69 82, 66 72, 60 70 Z" fill="#cfccc2" opacity=".5"/>
    <circle cx="55" cy="86" r="1.1" fill="#211f1c" opacity=".5"/>
    <circle cx="64" cy="90" r="1.1" fill="#211f1c" opacity=".5"/>
    <circle cx="60" cy="80" r="1" fill="#211f1c" opacity=".45"/>
    <g class="paw-wave">
      <path d="M48 90 Q46 106 49 120 L58 120 Q56 104 57 90 Z" fill="#e9e7e0"/>
      <ellipse cx="52" cy="121" rx="7.5" ry="4.6" fill="#e9e7e0"/>
      <path d="M49 122 v3 M53 122.5 v3 M57 122 v3" stroke="#cfccc2" stroke-width="1"/>
      <circle cx="50" cy="104" r="1" fill="#211f1c" opacity=".5"/>
      <circle cx="54" cy="112" r="1" fill="#211f1c" opacity=".45"/>
    </g>
    <path d="M63 90 Q62 106 65 120 L74 120 Q73 104 72 90 Z" fill="#e9e7e0"/>
    <ellipse cx="69" cy="121" rx="7.5" ry="4.6" fill="#e9e7e0"/>
    <path d="M66 122 v3 M70 122.5 v3 M74 122 v3" stroke="#cfccc2" stroke-width="1"/>
    <circle cx="70" cy="108" r="1" fill="#211f1c" opacity=".5"/>
    <g class="dog-head">
      <path class="ear-l" d="M41 18 C 26 16, 17 30, 21 47 C 24 58, 37 56, 41 45 Z" fill="#211f1c"/>
      <path class="ear-r" d="M79 18 C 94 16, 103 30, 99 47 C 96 58, 83 56, 79 45 Z" fill="#211f1c"/>
      <ellipse cx="60" cy="32" rx="22" ry="22" fill="#211f1c"/>
      <path d="M60 12 C 55 13, 54 24, 56 34 L64 34 C 66 24, 65 13, 60 12 Z" fill="#e9e7e0"/>
      <path d="M60 36 C 49 36, 45 47, 49 55 C 53 61, 67 61, 71 55 C 75 47, 71 36, 60 36 Z" fill="#e9e7e0"/>
      <path d="M60 40 C 53 40, 50 48, 53 54 C 57 59, 63 59, 67 54 C 70 48, 67 40, 60 40 Z" fill="#cfccc2" opacity=".4"/>
      <circle cx="52" cy="52" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="56" cy="55" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="64" cy="55" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="68" cy="52" r="0.9" fill="#211f1c" opacity=".55"/>
      <ellipse cx="60" cy="50" rx="5.2" ry="4" fill="#141110"/>
      <path d="M60 54 Q54 60 49 56 M60 54 Q66 60 71 56" stroke="#2a2420" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path class="tongue" d="M55 56 Q60 67 65 56 Z" fill="#cf8a96"/>
      <g class="dog-eyes">
        <path d="M44 28 Q49 25 54 28" stroke="#000" stroke-width="1.2" fill="none" opacity=".5"/>
        <path d="M66 28 Q71 25 76 28" stroke="#000" stroke-width="1.2" fill="none" opacity=".5"/>
        <ellipse cx="49" cy="31" rx="3.6" ry="4" fill="#6e4a22"/>
        <ellipse cx="71" cy="31" rx="3.6" ry="4" fill="#6e4a22"/>
        <circle cx="49" cy="31.6" r="2" fill="#140d05"/>
        <circle cx="71" cy="31.6" r="2" fill="#140d05"/>
        <circle cx="47.9" cy="29.7" r="0.7" fill="#d8d2c4" opacity=".55"/>
        <circle cx="69.9" cy="29.7" r="0.7" fill="#d8d2c4" opacity=".55"/>
      </g>
    </g>
  </g>

  <g id="poseWalk">
    <g class="tailw">
      <path d="M22 64 C 13 66, 6 62, 3 55" stroke="#211f1c" stroke-width="6.5" fill="none" stroke-linecap="round"/>
      <circle cx="3" cy="55" r="3.4" fill="#e9e7e0"/>
    </g>
    <g class="wleg wleg-a">
      <path d="M30 66 C 28 84, 30 100, 32 114 C 32 118, 40 118, 40 114 C 41 100, 42 84, 40 70 Z" fill="#cfccc2"/>
      <ellipse cx="36" cy="116" rx="5.4" ry="3.2" fill="#cfccc2"/>
    </g>
    <g class="wleg wleg-b">
      <path d="M84 66 C 83 84, 84 100, 85 113 C 85 117, 92 117, 92 113 C 93 100, 94 84, 93 68 Z" fill="#cfccc2"/>
      <ellipse cx="88.5" cy="115" rx="5.4" ry="3.2" fill="#cfccc2"/>
    </g>
    <path d="M84 56 C 72 52, 50 53, 36 57 C 29 59, 23 61, 20 66 C 23 71, 28 73, 33 76 C 40 78, 45 76, 51 78 C 59 81, 65 84, 73 84 C 80 85, 85 80, 87 72 C 89 65, 87 60, 84 56 Z" fill="#e9e7e0"/>
    <path d="M82 57 C 70 53, 50 54, 37 58 C 30 60, 24 62, 21 66 C 26 71, 34 72, 44 71 C 58 70, 70 69, 79 65 C 84 63, 85 60, 82 57 Z" fill="#211f1c"/>
    <circle cx="46" cy="80" r="1.1" fill="#211f1c" opacity=".4"/>
    <circle cx="60" cy="82" r="1.1" fill="#211f1c" opacity=".4"/>
    <circle cx="68" cy="80" r="1" fill="#211f1c" opacity=".35"/>
    <g class="wleg wleg-b">
      <path d="M22 64 C 19 78, 21 90, 29 96 C 36 99, 41 94, 40 85 C 39 76, 32 68, 26 64 Z" fill="#211f1c"/>
      <g class="knee knee-b">
        <path d="M30 90 C 27 98, 25 106, 28 113 C 29 117, 31 120, 33 121 C 35 122, 39 121, 38 118 C 36 111, 35 103, 37 95 C 37 91, 33 89, 30 90 Z" fill="#e9e7e0"/>
        <ellipse cx="35" cy="121" rx="6" ry="3.4" fill="#e9e7e0"/>
        <circle cx="34" cy="106" r="1" fill="#211f1c" opacity=".4"/>
      </g>
    </g>
    <g class="wleg wleg-a">
      <path d="M75 62 C 74 76, 75 88, 76 98 C 77 102, 85 102, 85 98 C 86 88, 87 76, 86 64 Z" fill="#e9e7e0"/>
      <path d="M76 63 C 80 60, 85 61, 86 66 C 84 70, 78 70, 75 67 Z" fill="#211f1c"/>
      <g class="knee knee-a">
        <path d="M76 96 C 75 104, 76 113, 77 120 C 78 122, 84 122, 84 120 C 85 113, 85 104, 84 96 Z" fill="#e9e7e0"/>
        <ellipse cx="80" cy="121" rx="6" ry="3.4" fill="#e9e7e0"/>
      </g>
    </g>
    <path d="M78 64 Q86 50 89 44" stroke="#211f1c" stroke-width="17" fill="none" stroke-linecap="round"/>
    <g class="walkhead" transform="translate(90,33) scale(0.82) translate(-60,-34)">
      <path class="ear-l" d="M41 18 C 26 16, 17 30, 21 47 C 24 58, 37 56, 41 45 Z" fill="#211f1c"/>
      <path class="ear-r" d="M79 18 C 94 16, 103 30, 99 47 C 96 58, 83 56, 79 45 Z" fill="#211f1c"/>
      <ellipse cx="60" cy="32" rx="22" ry="22" fill="#211f1c"/>
      <path d="M60 12 C 55 13, 54 24, 56 34 L64 34 C 66 24, 65 13, 60 12 Z" fill="#e9e7e0"/>
      <path d="M60 36 C 49 36, 45 47, 49 55 C 53 61, 67 61, 71 55 C 75 47, 71 36, 60 36 Z" fill="#e9e7e0"/>
      <path d="M60 40 C 53 40, 50 48, 53 54 C 57 59, 63 59, 67 54 C 70 48, 67 40, 60 40 Z" fill="#cfccc2" opacity=".4"/>
      <circle cx="52" cy="52" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="56" cy="55" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="64" cy="55" r="0.9" fill="#211f1c" opacity=".55"/>
      <circle cx="68" cy="52" r="0.9" fill="#211f1c" opacity=".55"/>
      <ellipse cx="60" cy="50" rx="5.2" ry="4" fill="#141110"/>
      <path d="M60 54 Q54 60 49 56 M60 54 Q66 60 71 56" stroke="#2a2420" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path class="tongue" d="M55 56 Q60 71 65 56 Z" fill="#cf8a96"/>
      <g class="dog-eyes">
        <path d="M44 28 Q49 25 54 28" stroke="#000" stroke-width="1.2" fill="none" opacity=".5"/>
        <path d="M66 28 Q71 25 76 28" stroke="#000" stroke-width="1.2" fill="none" opacity=".5"/>
        <ellipse cx="49" cy="31" rx="3.6" ry="4" fill="#6e4a22"/>
        <ellipse cx="71" cy="31" rx="3.6" ry="4" fill="#6e4a22"/>
        <circle cx="49" cy="31.6" r="2" fill="#140d05"/>
        <circle cx="71" cy="31.6" r="2" fill="#140d05"/>
        <circle cx="47.9" cy="29.7" r="0.7" fill="#d8d2c4" opacity=".55"/>
        <circle cx="69.9" cy="29.7" r="0.7" fill="#d8d2c4" opacity=".55"/>
      </g>
    </g>
  </g>
</svg>`;

  const BED = `
<svg viewBox="0 0 160 60" width="160" height="60" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="80" cy="40" rx="76" ry="18" fill="#1b2230"/>
  <ellipse cx="80" cy="34" rx="76" ry="19" fill="#39414f"/>
  <ellipse cx="80" cy="33" rx="60" ry="13" fill="#222a37"/>
  <ellipse cx="80" cy="31.5" rx="57" ry="11.5" fill="#2b3342"/>
</svg>`;

  const MENU = `
    <button data-act="brief"><span class="k">☀</span> Morning brief</button>
    <button data-act="refresh"><span class="k">⟳</span> Refresh data</button>
    <button data-act="ads"><span class="k">◈</span> Jump to Ads</button>
    <button data-act="snooze"><span class="k">💤</span> Go to bed</button>`;

  // --- state ---------------------------------------------------------------
  let dog, svg, shadow, bubble, menu, bed, ready = false, onDash = true, running = false, raf = 0;
  let sleeping = false, bubbleT, zzzT, LBOUND = 2, lastFrame = 0;
  const R = { x: 0, groundY: 0, lift: 0, face: 1, state: 'idle', t: 0, dur: 0, startX: 0, startGround: 0, targetX: 0, targetGround: 0, jumpH: 0, nextAt: 0, goingHome: false, scrolling: false, _sT: 0 };
  const LINES = ['woof.', '🐾', '*sniff*', 'hi', "let's go"];
  const CELE = { lead: '🎉 new lead!', booked: '💰 booked!', 'goal-milestone': '📈 milestone!', 'goal-hit': '🏆 GOAL!' };
  const _lastScroll = {};
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rPick = (a) => a[Math.floor(Math.random() * a.length)];
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // --- build ---------------------------------------------------------------
  function build() {
    if (document.getElementById('robbie')) { ready = true; return true; }
    if (!document.getElementById('kpi-revenue')) return false;
    bed = document.createElement('div');
    bed.className = 'dogbed'; bed.id = 'robbieBed'; bed.style.display = 'none'; bed.innerHTML = BED;
    document.body.appendChild(bed);
    dog = document.createElement('div');
    dog.className = 'dog'; dog.id = 'robbie'; dog.title = 'Robbie'; dog.style.visibility = 'hidden';
    dog.innerHTML =
      `<div class="dog-bubble" id="robbieBubble"></div>` +
      `<div class="clawmenu" id="robbieMenu">${MENU}</div>` +
      `<div class="dog-shadow"></div>` +
      `<div class="dog-body">${SVG}</div>`;
    document.body.appendChild(dog);
    svg = dog.querySelector('.dog-svg');
    shadow = dog.querySelector('.dog-shadow');
    bubble = document.getElementById('robbieBubble');
    menu = document.getElementById('robbieMenu');
    ready = true;
    wire();
    return true;
  }

  // --- helpers -------------------------------------------------------------
  function say(msg, ms = 2100) {
    if (!bubble) return;
    bubble.textContent = msg; bubble.classList.add('show');
    clearTimeout(bubbleT); bubbleT = setTimeout(() => bubble.classList.remove('show'), ms);
  }
  function setPose(p) {
    dog.classList.remove('walk', 'jump', 'curled');
    if (p === 'walk') dog.classList.add('walk');
    else if (p === 'jump') dog.classList.add('jump');
    else if (p === 'curled') dog.classList.add('curled');
  }
  function recalcBounds() {
    const sb = document.querySelector('.sidebar');
    if (sb) { const r = sb.getBoundingClientRect(); if (r.left <= 1 && r.height > innerHeight * 0.5) { LBOUND = Math.round(r.right) + 6; return; } }
    LBOUND = 2;
  }
  function placeFeet(cx, top) { R.x = cx - RW / 2; R.groundY = top - FOOT; }
  function applyTransform() {
    const x = Math.max(LBOUND, Math.min(innerWidth - RW - 2, R.x));
    const y = Math.max(2, Math.min(innerHeight - RH - 2, R.groundY + R.lift));
    dog.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    svg.style.transform = `scaleX(${R.face})`;
    const sh = Math.max(0.3, 1 + R.lift / 95);
    shadow.style.transform = `translateY(${-R.lift}px) scale(${sh})`;
    shadow.style.opacity = String(0.18 + 0.4 * sh);
  }

  // --- where his bed lives (open space of the revenue card) ----------------
  function bedMetrics() {
    const card = document.getElementById('kpi-revenue');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return null;
    let contentRight = r.left + r.width * 0.42;
    card.querySelectorAll('#kpi-revenue-body .hero-figure, #kpi-revenue-body .hero-breakdown').forEach((e) => {
      const er = e.getBoundingClientRect(); if (er.width) contentRight = Math.max(contentRight, er.right);
    });
    const openLeft = Math.min(contentRight + 20, r.right - 130);
    const openRight = r.right - 16;
    const cx = openLeft + (openRight - openLeft) * CFG.homeFrac + CFG.bedDX;
    const top = r.top + r.height * CFG.homeVFrac + CFG.bedDY;
    return { cx, top };
  }
  function positionBed() {
    const m = bedMetrics();
    if (!m || !onDash) { if (bed) bed.style.display = 'none'; return null; }
    bed.style.display = '';
    bed.style.transform = `translate(${Math.round(m.cx - CFG.BEDW / 2)}px, ${Math.round(m.top - CFG.BED_PAD)}px)`;
    return m;
  }
  function placeCurl(m) { placeFeet(m.cx, m.top); R.lift = 0; }

  // --- surfaces he can stand on (tile tops = borders) ----------------------
  function candidateSurfaces() {
    const sels = '.page.active .card, .page.active .kcol, .page.active .skill-btn, .page.active .ptab, #refreshBtn';
    const out = [];
    for (const el of document.querySelectorAll(sels)) {
      if (el === bed || el.id === 'robbie') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 16) continue;
      if (r.bottom < 80 || r.top > innerHeight - 24) continue;
      out.push({ x: r.left + rnd(0.25, 0.75) * r.width, top: Math.max(70, r.top), el });
    }
    return out;
  }

  // --- movement ------------------------------------------------------------
  function startWalk(t) {
    R.state = 'walk'; R.t = 0; R.startX = R.x; R.startGround = R.groundY;
    R.targetX = t.x - RW / 2; R.targetGround = R.groundY;                  // horizontal along this surface
    R.dur = Math.max(480, Math.abs(R.targetX - R.startX) * CFG.walkMsPerPx);
    R.face = R.targetX >= R.x ? 1 : -1;
    setPose('walk');
  }
  function startJump(t) {
    R.state = 'jump'; R.t = 0; R.startX = R.x; R.startGround = R.groundY;
    R.targetX = t.x - RW / 2; R.targetGround = t.top - FOOT;
    const dist = Math.hypot(R.targetX - R.startX, R.targetGround - R.startGround);
    R.dur = Math.min(1100, 520 + dist * 0.45);
    R.jumpH = Math.min(120, 58 + dist * 0.3);
    R.face = R.targetX >= R.x ? 1 : -1;
    setPose('jump');
    dog.classList.toggle('behind', Math.random() < 0.22);
  }
  function land() {
    R.state = 'land'; R.t = 0; setPose('sit');
    if (!R.goingHome && Math.random() < 0.12) say(rPick(LINES));
  }
  function pickAction() {
    if (onDash && !sleeping && Math.random() < CFG.homeProb) { goHome(); return; }
    const c = candidateSurfaces();
    if (!c.length) { R.state = 'idle'; R.nextAt = performance.now() + 1600; return; }
    c.sort((a, b) => Math.abs((a.x - RW / 2) - R.x) - Math.abs((b.x - RW / 2) - R.x));
    const t = rPick(c.slice(0, Math.min(6, c.length)));
    const sameLevel = Math.abs((t.top - FOOT) - R.groundY) < 26;
    if (sameLevel) startWalk(t); else startJump(t);    // jump to reach a tile at a different height
  }
  function goHome() {
    const m = bedMetrics();
    if (!m) { R.state = 'idle'; R.nextAt = performance.now() + 2000; return; }
    R.goingHome = true;
    const t = { x: m.cx, top: m.top, el: null };
    const sameLevel = Math.abs((t.top - FOOT) - R.groundY) < 26;
    if (sameLevel) startWalk(t); else startJump(t);
  }

  // --- sleep / wake --------------------------------------------------------
  function enterSleep() {
    sleeping = true; R.goingHome = false; R.lift = 0; R.state = 'idle';
    setPose('curled');
    const m = bedMetrics(); if (m) placeCurl(m);
    applyTransform();
    scheduleZzz();
  }
  function scheduleZzz() {
    clearInterval(zzzT);
    if (RM.matches) return;
    setTimeout(() => { if (sleeping && onDash) say('💤', 1700); }, 700);
    zzzT = setInterval(() => { if (!sleeping) { clearInterval(zzzT); return; } if (onDash) say('💤', 1700); }, 4500);
  }
  function wake() {
    if (!sleeping) return;
    sleeping = false; clearInterval(zzzT); setPose('sit'); say('🥱');
    R.state = 'idle'; R.nextAt = performance.now() + 700;
  }

  // --- frame loop ----------------------------------------------------------
  function frame(now) {
    if (!running) return;
    const dt = lastFrame ? Math.min(48, now - lastFrame) : 16; lastFrame = now;
    if (sleeping) { applyTransform(); raf = requestAnimationFrame(frame); return; }
    if (R.state === 'idle') {
      R.lift = 0;
      if (R.scrolling) R.nextAt = now + 500;
      else if (now >= R.nextAt) pickAction();
    } else if (R.state === 'walk') {
      R.t += dt / R.dur; const p = Math.min(1, R.t);
      R.x = R.startX + (R.targetX - R.startX) * p;
      R.groundY = R.startGround + (R.targetGround - R.startGround) * p;
      R.lift = 0;
      if (p >= 1) land();
    } else if (R.state === 'jump') {
      R.t += dt / R.dur; const p = Math.min(1, R.t); const e = easeInOut(p);
      R.x = R.startX + (R.targetX - R.startX) * e;
      R.groundY = R.startGround + (R.targetGround - R.startGround) * e;
      R.lift = -Math.sin(p * Math.PI) * R.jumpH;
      if (p >= 1) { dog.classList.remove('behind'); land(); }
    } else if (R.state === 'land') {
      R.t += dt / 220; const p = Math.min(1, R.t); R.lift = 0;
      if (p >= 1) {
        if (R.goingHome) { R.goingHome = false; enterSleep(); }
        else { R.state = 'idle'; R.nextAt = now + rnd(2200, 4600); }
      }
    }
    applyTransform();
    raf = requestAnimationFrame(frame);
  }
  function startLoop() { if (running) return; running = true; lastFrame = 0; raf = requestAnimationFrame(frame); }
  function stopLoop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  // --- scroll: keep him on his tile, and his bed on the card ---------------
  function onUserScroll(e) {
    const pg = e.target; if (!pg || pg.scrollTop == null) return;
    const top = pg.scrollTop; const delta = top - (_lastScroll[pg.id] || 0); _lastScroll[pg.id] = top;
    positionBed();
    if (sleeping) { const m = bedMetrics(); if (m) { placeCurl(m); applyTransform(); } return; }
    if (delta) { R.groundY -= delta; R.startGround -= delta; R.targetGround -= delta; }
    R.scrolling = true; clearTimeout(R._sT);
    R._sT = setTimeout(() => { R.scrolling = false; R.nextAt = performance.now() + 400; }, 200);
  }

  // --- interaction ---------------------------------------------------------
  function wire() {
    dog.addEventListener('click', (e) => {
      if (e.target.closest('.clawmenu')) return;
      if (sleeping) { wake(); return; }
      menu.classList.toggle('open');
    });
    bed.addEventListener('click', () => { if (sleeping) wake(); });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      menu.classList.remove('open');
      const act = b.dataset.act;
      if (act === 'brief') { say('on the briefing ☀'); const g = document.getElementById('briefGen'); if (g) g.click(); }
      else if (act === 'refresh') { say('refreshing… ⟳'); const r = document.getElementById('refreshBtn'); if (r) r.click(); }
      else if (act === 'ads') { say('to the Ads cockpit ◈'); if (AIOS.showPage) AIOS.showPage('ads'); }
      else if (act === 'snooze') { if (!sleeping) goHome(); }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#robbie')) menu.classList.remove('open'); });
    document.querySelectorAll('.page').forEach((pg) => pg.addEventListener('scroll', onUserScroll, { passive: true }));
    window.addEventListener('resize', () => { recalcBounds(); positionBed(); if (sleeping) { const m = bedMetrics(); if (m) { placeCurl(m); applyTransform(); } } }, { passive: true });
  }

  // --- bus -----------------------------------------------------------------
  let lastCele = 0;
  AIOS.bus.on('celebrate', ({ reason } = {}) => {
    if (!ready || RM.matches || !onDash) return;
    const now = Date.now(); if (now - lastCele < 8000) return; lastCele = now;
    if (sleeping) wake();
    say(CELE[reason] || '🎉 woof!');
    setTimeout(() => { if (!sleeping) { startJump({ x: R.x + RW / 2, top: R.groundY + FOOT, el: null }); R.jumpH = 78; } }, 260);
  });

  let lastQuip = 0;
  const QUIPS = ['all systems green', 'lookin good 🐾', "let's ship", 'big day?'];
  AIOS.bus.on('page', (id) => {
    onDash = (id === 'dashboard');
    if (!ready) return;
    if (!onDash) { dog.style.visibility = 'hidden'; if (bed) bed.style.display = 'none'; stopLoop(); return; }
    dog.style.visibility = 'visible'; recalcBounds(); positionBed();
    if (sleeping) { const m = bedMetrics(); if (m) { placeCurl(m); applyTransform(); } }
    startLoop();
    const now = Date.now();
    if (!RM.matches && !sleeping && now - lastQuip > 180000 && Math.random() < 0.25) { lastQuip = now; setTimeout(() => say(rPick(QUIPS)), 800); }
  });

  // --- init ----------------------------------------------------------------
  function init() {
    if (!build()) return false;
    recalcBounds();
    const m = positionBed();
    sleeping = true; setPose('curled');
    if (m) placeCurl(m); else placeFeet(innerWidth * 0.6, innerHeight * 0.5);
    dog.style.visibility = 'visible';
    applyTransform();
    scheduleZzz();
    if (!RM.matches) startLoop();
    return true;
  }
  function boot() {
    if (init()) return;
    let tries = 0;
    const t = setInterval(() => { if (init() || ++tries > 40) clearInterval(t); }, 250);
  }
  AIOS.bus.on('boot.done', boot);
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 200));
})();
