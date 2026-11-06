// The page is assembled live by a swarm of cursor agents.
// Every element marked [data-layer] is one "layer"; agents claim layers and build them:
//   block  - drag out a wireframe, fill it grey, then swap in the real element
//   frame  - drag out a wireframe, then the container's border/background appears
//   rule   - draw a hairline along the element's top (or bottom) edge
//   type   - type the text in with an I-beam cursor
//   sweep  - select-and-reveal a paragraph left to right
// The director walks the sections top to bottom, scrolling the page as it goes.
// If the visitor scrolls on their own, it switches to building whatever is on screen.

const PALETTE = ['#ff5a36', '#ffd23f', '#3ddc97', '#ff6fb5', '#5aa9ff', '#f4f4f0', '#b18cff', '#4de1e8'];
const ARROW = 'M1.5 1.5 L1.5 14 L5 10.6 L7.6 16 L10 15 L7.4 9.6 L12.4 9.6 Z';
const PRI = { rule: 0, frame: 1, block: 2, type: 3, sweep: 4 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createBuilder({ overlay, pill, page, count = 40, keep = 4, speed = 1 }) {
  const root = document.documentElement;
  const layers = [...document.querySelectorAll('[data-layer]')];
  const sections = [...document.querySelectorAll('[data-section]')];
  const total = layers.length;
  const fx = new Set();
  const typing = new Map();
  const inFlight = new Set();
  const pauseWaiters = [];
  const S = speed;

  let runId = 0;
  let running = false;
  let paused = false;
  let auto = true;
  let built = 0;
  let t0 = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let elapsed = 0;
  let agentsOff = false;

  // ---------- overlay ----------
  const sizeOverlay = () => { overlay.style.height = `${page.offsetHeight}px`; };
  sizeOverlay();
  new ResizeObserver(sizeOverlay).observe(page);

  const navH = () => (document.querySelector('.nav')?.offsetHeight || 0);
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  };
  const docTop = (el) => el.getBoundingClientRect().top + scrollY;
  const label = (el) => el.dataset.label || el.tagName.toLowerCase();

  function box(r, cls, tag) {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (cls.startsWith('wf')) d.innerHTML = '<i class="h tl"></i><i class="h tr"></i><i class="h bl"></i><i class="h br"></i>';
    if (tag) d.insertAdjacentHTML('beforeend', `<span class="wf-tag">${esc(tag)}</span>`);
    overlay.appendChild(d);
    fx.add(d);
    return d;
  }
  function fade(d, delay = 0) {
    setTimeout(() => {
      d.classList.add('out');
      setTimeout(() => { d.remove(); fx.delete(d); }, 600);
    }, delay);
  }

  // ---------- agents ----------
  const agents = Array.from({ length: count }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'agent';
    el.style.setProperty('--c', PALETTE[i % PALETTE.length]);
    el.innerHTML = `<svg class="arrow" viewBox="0 0 18 18" width="21" height="21" aria-hidden="true"><path d="${ARROW}"/></svg><svg class="ibeam" viewBox="0 0 10 18" width="11" height="20" aria-hidden="true"><path d="M2 1.5h6M5 1.5v15M2 16.5h6"/></svg>`;
    overlay.appendChild(el);
    return { el, x: -60, y: -60, vx: 0, vy: 0, tx: -60, ty: -60, glide: null, arrive: null, chain: Promise.resolve(), pending: 0, on: false, idle: true, busy: false, w: rnd(0, 6.28) };
  });

  function edgePoint() {
    const w = innerWidth, h = innerHeight, y0 = scrollY;
    switch (Math.floor(Math.random() * 4)) {
      case 0: return { x: rnd(0, w), y: y0 - 30 };
      case 1: return { x: w + 30, y: y0 + rnd(0, h) };
      case 2: return { x: rnd(0, w), y: y0 + h + 30 };
      default: return { x: -30, y: y0 + rnd(0, h) };
    }
  }
  function show(a, on) {
    if (on && !a.on) {
      const p = edgePoint();
      a.x = p.x; a.y = p.y; a.vx = 0; a.vy = 0;
    }
    a.on = on;
    a.el.classList.toggle('on', on);
  }
  function moveTo(a, x, y, timeout = 1500) {
    a.glide = null;
    a.tx = x; a.ty = y;
    return new Promise((res) => {
      a.arrive = res;
      setTimeout(() => { if (a.arrive === res) { a.arrive = null; res(); } }, timeout);
    });
  }
  function glide(a, x0, y0, x1, y1, ms, onStep) {
    return new Promise((res) => { a.glide = { x0, y0, x1, y1, t0: performance.now(), ms, res, onStep }; });
  }
  function releaseAgents() {
    for (const a of agents) {
      if (a.glide) { const g = a.glide; a.glide = null; g.res(); }
      if (a.arrive) { const r = a.arrive; a.arrive = null; r(); }
      a.el.classList.remove('ib');
      a.chain = Promise.resolve();
      a.pending = 0;
      a.idle = true;
    }
  }

  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    for (const a of agents) {
      if (!a.on) continue;
      if (a.glide) {
        const g = a.glide;
        if (paused) g.t0 += dt * 1000;
        const t = Math.min(1, (now - g.t0) / g.ms);
        const e = ease(t);
        a.tx = g.x0 + (g.x1 - g.x0) * e;
        a.ty = g.y0 + (g.y1 - g.y0) * e;
        if (g.onStep) g.onStep(e);
        if (t >= 1) { a.glide = null; g.res(); }
      } else if (a.idle) {
        a.w += dt;
        a.tx += Math.sin(a.w * 1.3) * 0.35;
        a.ty += Math.cos(a.w * 1.1) * 0.35;
      }
      const k = a.glide ? 320 : a.idle ? 10 : 110;
      const c = 2 * Math.sqrt(k) * 0.85;
      a.vx += ((a.tx - a.x) * k - a.vx * c) * dt;
      a.vy += ((a.ty - a.y) * k - a.vy * c) * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      if (a.arrive && Math.hypot(a.tx - a.x, a.ty - a.y) < 4) { const r = a.arrive; a.arrive = null; r(); }
      a.el.style.transform = `translate3d(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px, 0)`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // idle agents drift around whatever is on screen
  setInterval(() => {
    for (const a of agents) {
      if (!a.on || !a.idle || a.busy || a.glide) continue;
      if (Math.random() < 0.55) {
        a.tx = rnd(innerWidth * 0.04, innerWidth * 0.96);
        a.ty = scrollY + rnd(innerHeight * 0.1, innerHeight * 0.9);
      }
    }
  }, 1700);

  // ---------- pause / abort ----------
  const alive = (run) => run === runId;
  const gate = () => (paused ? new Promise((r) => pauseWaiters.push(r)) : Promise.resolve());
  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    if (p) pausedAt = performance.now();
    else {
      pausedTotal += performance.now() - pausedAt;
      pauseWaiters.splice(0).forEach((r) => r());
    }
    updatePill();
  }

  function markBuilt(el) {
    if (el.classList.contains('built')) return;
    el.classList.add('built');
    built++;
    el.dispatchEvent(new CustomEvent('layerbuilt'));
    updatePill();
  }

  // ---------- layer jobs ----------
  async function jobDrag(a, el, run) {
    const r = docRect(el);
    await moveTo(a, r.x, r.y);
    await gate();
    if (!alive(run)) return;
    el.dispatchEvent(new CustomEvent('layerstart'));
    const d = box(r, 'wf wf--drag', `${label(el)}  ${Math.round(r.w)} × ${Math.round(r.h)}`);
    d.style.clipPath = 'inset(0 100% 100% 0)';
    const ms = clamp(200 + Math.hypot(r.w, r.h) * 0.6, 260, 650) * S;
    await glide(a, r.x, r.y, r.x + r.w, r.y + r.h, ms, (e) => {
      d.style.clipPath = `inset(0 ${(1 - e) * 100}% ${(1 - e) * 100}% 0)`;
    });
    if (!alive(run)) return;
    d.style.clipPath = 'none';
    if (el.dataset.layer === 'block') {
      d.classList.add('fill');
      await sleep(260 * S);
    }
    if (el.hasAttribute('data-hold')) await sleep(700 * S);
    if (!alive(run)) return;
    markBuilt(el);
    fade(d, 380);
  }

  async function jobRule(a, el, run) {
    const r = docRect(el);
    const y = el.dataset.edge === 'bottom' ? r.y + r.h - 1 : r.y;
    await moveTo(a, r.x, y);
    await gate();
    if (!alive(run)) return;
    const ln = box({ x: r.x, y, w: r.w, h: 1 }, 'ln');
    await glide(a, r.x, y, r.x + r.w, y, clamp(r.w * 0.55, 280, 900) * S, (e) => { ln.style.transform = `scaleX(${e})`; });
    if (!alive(run)) return;
    markBuilt(el);
    fade(ln, 150);
  }

  async function jobType(a, el, run) {
    const r = docRect(el);
    await moveTo(a, r.x - 4, r.y + Math.min(r.h, 40) / 2 - 9);
    await gate();
    if (!alive(run)) return;
    const html = el.innerHTML;
    const text = el.textContent;
    typing.set(el, html);
    const d = box(r, 'wf wf--sel', label(el));
    a.el.classList.add('ib');
    el.classList.add('typing');
    el.innerHTML = `<span class="tt"></span><span class="caret"></span><span class="tr">${esc(text)}</span>`;
    const [tS, caret, rS] = el.children;
    const n = text.length;
    const dur = clamp(n * 24, 220, 900) * S;
    let start = performance.now();
    let i = 0;
    while (i < n && alive(run)) {
      if (paused) { const p = performance.now(); await gate(); start += performance.now() - p; }
      await nextFrame();
      i = Math.max(i + 1, Math.round(((performance.now() - start) / dur) * n));
      i = Math.min(n, i);
      tS.textContent = text.slice(0, i);
      rS.textContent = text.slice(i);
      const cr = caret.getBoundingClientRect();
      a.tx = cr.left + scrollX - 4;
      a.ty = cr.top + scrollY + cr.height / 2 - 9;
    }
    if (typing.get(el) === html) { el.innerHTML = html; typing.delete(el); }
    el.classList.remove('typing');
    a.el.classList.remove('ib');
    if (!alive(run)) return;
    markBuilt(el);
    fade(d, 260);
  }

  async function jobSweep(a, el, run) {
    const r = docRect(el);
    await moveTo(a, r.x, r.y + 4);
    await gate();
    if (!alive(run)) return;
    const hl = box(r, 'hl');
    el.classList.add('sweeping');
    el.style.clipPath = 'inset(-6px 100% -6px -4px)';
    a.el.classList.add('ib');
    const ms = clamp(r.w * 0.9, 360, 800) * S;
    await glide(a, r.x, r.y + 2, r.x + r.w, r.y + Math.max(2, r.h - 16), ms, (e) => {
      el.style.clipPath = `inset(-6px ${(1 - e) * 100}% -6px -4px)`;
      hl.style.transform = `scaleX(${e})`;
    });
    el.style.clipPath = '';
    el.classList.remove('sweeping');
    a.el.classList.remove('ib');
    if (!alive(run)) return;
    markBuilt(el);
    fade(hl, 240);
  }

  const JOBS = { block: jobDrag, frame: jobDrag, rule: jobRule, type: jobType, sweep: jobSweep };

  function assign(a, el, delay, run) {
    a.pending++;
    a.idle = false;
    if (!a.on) show(a, true);
    const job = a.chain.then(async () => {
      if (delay) await sleep(delay);
      if (!alive(run)) return;
      a.idle = false;
      try { await JOBS[el.dataset.layer](a, el, run); }
      catch (err) { console.error(err); markBuilt(el); }
    }).finally(() => {
      if (alive(run)) inFlight.delete(el);
      a.pending = Math.max(0, a.pending - 1);
      if (!a.pending) a.idle = true;
    });
    a.chain = job;
    return job;
  }

  function dispatch(batch, run) {
    batch.sort((p, q) => (PRI[p.dataset.layer] - PRI[q.dataset.layer]) || (docTop(p) - docTop(q)));
    const crew = agents.slice().sort((p, q) => (p.pending - q.pending) || (Math.random() - 0.5));
    return Promise.all(batch.map((el, i) => {
      inFlight.add(el);
      const a = crew[i % crew.length];
      const late = PRI[el.dataset.layer] >= 3 ? 180 : 0;
      const delay = i < crew.length ? (i * 34 + late) * S : 0;
      return assign(a, el, delay, run);
    }));
  }

  // ---------- section guides ----------
  function drawGuide(sec, run) {
    const wrap = sec.querySelector('.wrap') || sec;
    const w = docRect(wrap);
    const s = docRect(sec);
    const style = getComputedStyle(wrap);
    const x = w.x + parseFloat(style.paddingLeft || '0') - 1;
    const g = box({ x, y: s.y, w: 1, h: s.h }, 'guide');
    const a = agents.slice().sort((p, q) => p.pending - q.pending)[0];
    a.pending++;
    a.idle = false;
    if (!a.on) show(a, true);
    a.chain = a.chain.then(async () => {
      await moveTo(a, x, s.y + 4, 700);
      if (!alive(run)) return;
      await glide(a, x, s.y, x, s.y + Math.min(s.h, innerHeight * 0.9), 520 * S, (e) => { g.style.transform = `scaleY(${e})`; });
      g.style.transform = 'scaleY(1)';
    }).finally(() => { a.pending = Math.max(0, a.pending - 1); if (!a.pending) a.idle = true; });
    return g;
  }

  function review(sec, run) {
    const items = [...sec.querySelectorAll('[data-review]')];
    if (!items.length) return;
    const a = agents.slice().sort((p, q) => p.pending - q.pending)[0];
    a.pending++;
    a.idle = false;
    if (!a.on) show(a, true);
    a.chain = a.chain.then(async () => {
      for (const it of items) {
        if (!alive(run)) return;
        const r = docRect(it);
        await moveTo(a, r.x + r.w - 10, r.y + 8, 420);
        const d = box(r, 'wf wf--review', 'review · pass');
        fade(d, 420);
        await sleep(110 * S);
      }
    }).finally(() => { a.pending = Math.max(0, a.pending - 1); if (!a.pending) a.idle = true; });
  }

  // ---------- scrolling ----------
  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
  function smoothScroll(y, ms, run) {
    const from = scrollY;
    const to = clamp(y, 0, maxScroll());
    if (Math.abs(to - from) < 2) return Promise.resolve();
    const tStart = performance.now();
    return new Promise((res) => {
      const step = (now) => {
        // run === -1 is the closing scroll back to the top; it ignores the build state
        if (run !== -1 && (!alive(run) || !auto)) return res();
        if (run === -1 && running) return res();
        const t = Math.min(1, (now - tStart) / ms);
        window.scrollTo(0, from + (to - from) * ease(t));
        if (t < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }
  const goManual = () => {
    if (running && auto) { auto = false; updatePill(); }
  };
  addEventListener('wheel', goManual, { passive: true });
  addEventListener('touchmove', goManual, { passive: true });
  addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) goManual();
  });

  // ---------- director ----------
  async function direct(run) {
    let current = null;
    let guide = null;
    const closeSection = (sec) => {
      if (guide) { fade(guide, 500); guide = null; }
      if (sec) review(sec, run);
    };
    while (alive(run)) {
      await gate();
      if (!alive(run)) return;
      const rest = layers.filter((l) => !l.classList.contains('built') && !inFlight.has(l));
      if (!rest.length) {
        if (!inFlight.size) break;
        await sleep(120);
        continue;
      }
      let batch;
      if (auto) {
        const sec = sections.find((s) => rest.some((l) => s.contains(l)));
        if (sec !== current) {
          closeSection(current);
          current = sec;
          if (sec && !sec.classList.contains('nav')) guide = drawGuide(sec, run);
        }
        const own = rest.filter((l) => sec.contains(l)).sort((p, q) => docTop(p) - docTop(q));
        const top = docTop(own[0]);
        const fixedNav = sec.classList.contains('nav');
        if (!fixedNav && (top < scrollY + navH() || top > scrollY + innerHeight - 140)) {
          await smoothScroll(top - navH() - 40, 750 * S, run);
          if (!alive(run)) return;
        }
        const limit = scrollY + innerHeight - 30;
        batch = fixedNav ? own : own.filter((l) => docTop(l) < limit);
        if (!batch.length) batch = [own[0]];
      } else {
        const lo = scrollY - 40;
        const hi = scrollY + innerHeight + 40;
        batch = rest.filter((l) => {
          const r = l.getBoundingClientRect();
          return r.bottom + scrollY > lo && r.top + scrollY < hi;
        });
        if (!batch.length) { await sleep(160); continue; }
      }
      await dispatch(batch, run);
    }
    if (!alive(run)) return;
    closeSection(current);
    await sleep(500);
    if (alive(run)) finish(run, true);
  }

  function finish(run, natural) {
    running = false;
    elapsed = (performance.now() - t0 - pausedTotal) / 1000;
    root.classList.remove('building');
    updatePill();
    disperse();
    if (natural && auto && run === runId) {
      setTimeout(() => { if (!running) smoothScroll(0, 1500, -1); }, 900);
    }
  }

  function disperse() {
    agents.forEach((a, i) => {
      a.idle = true;
      if (i < keep && !agentsOff) {
        a.tx = rnd(innerWidth * 0.55, innerWidth * 0.95);
        a.ty = scrollY + rnd(innerHeight * 0.15, innerHeight * 0.7);
      } else if (a.on) {
        const p = edgePoint();
        moveTo(a, p.x, p.y, 2200).then(() => { if (!running) show(a, false); });
      }
    });
  }

  // agents inspect whatever link the visitor hovers once the page is built
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('a, button');
    if (!t || running || agentsOff || pill.contains(t)) return;
    const a = agents.find((x) => x.on && x.idle && !x.busy);
    if (!a) return;
    a.busy = true;
    const r = docRect(t);
    moveTo(a, r.x + r.w - 8, r.y + r.h - 6, 900).then(() => {
      const d = box(r, 'wf wf--sel', t.tagName === 'A' ? 'a:hover' : 'button:hover');
      fade(d, 650);
      setTimeout(() => { a.busy = false; }, 900);
    });
  });

  // ---------- reset helpers ----------
  function clearEffects() {
    fx.forEach((d) => d.remove());
    fx.clear();
    typing.forEach((html, el) => { el.innerHTML = html; });
    typing.clear();
    layers.forEach((l) => { l.style.clipPath = ''; l.classList.remove('typing', 'sweeping'); });
  }

  function start() {
    const run = ++runId;
    running = true;
    auto = true;
    paused = false;
    pausedTotal = 0;
    t0 = performance.now();
    root.classList.add('building');
    agents.forEach((a, i) => {
      show(a, true);
      a.idle = true;
      a.tx = rnd(innerWidth * 0.05, innerWidth * 0.95);
      a.ty = scrollY + rnd(innerHeight * 0.1, innerHeight * 0.9);
      a.el.style.transitionDelay = `${i * 12}ms`;
    });
    updatePill();
    sleep(650 * S).then(() => direct(run));
  }

  function skip() {
    if (!running) return;
    runId++;
    pauseWaiters.splice(0).forEach((r) => r());
    paused = false;
    releaseAgents();
    clearEffects();
    inFlight.clear();
    layers.forEach(markBuilt);
    finish(runId, false);
  }

  function replay() {
    runId++;
    pauseWaiters.splice(0).forEach((r) => r());
    releaseAgents();
    clearEffects();
    inFlight.clear();
    built = 0;
    layers.forEach((l) => { l.classList.remove('built'); l.dispatchEvent(new CustomEvent('layerreset')); });
    agentsOff = false;
    root.classList.remove('agents-off');
    localStorage.removeItem('agents');
    window.scrollTo(0, 0);
    start();
  }

  function showBuilt({ off = false } = {}) {
    agentsOff = off;
    root.classList.toggle('agents-off', off);
    root.classList.remove('building');
    layers.forEach(markBuilt);
    elapsed = 0;
    updatePill();
    if (!off) agents.slice(0, keep).forEach((a) => { show(a, true); a.tx = rnd(innerWidth * 0.55, innerWidth * 0.95); a.ty = rnd(innerHeight * 0.2, innerHeight * 0.7); });
  }

  // ---------- status pill ----------
  const pText = pill.querySelector('[data-p=text]');
  const pBar = pill.querySelector('[data-p=bar]');
  const pMain = pill.querySelector('[data-p=main]');
  const pSkip = pill.querySelector('[data-p=skip]');
  function updatePill() {
    pBar.style.transform = `scaleX(${total ? built / total : 0})`;
    if (running) {
      pText.innerHTML = `<b>${count}</b> agents <span class="sep">·</span> ${built} / ${total} layers${auto ? '' : ' <span class="sep">·</span> following you'}`;
      pMain.textContent = paused ? 'Resume' : 'Pause';
      pSkip.hidden = false;
    } else {
      pText.innerHTML = elapsed ? `Built by <b>${count}</b> agents in ${elapsed.toFixed(1)}s` : `${total} layers <span class="sep">·</span> built by agents`;
      pMain.textContent = 'Replay';
      pSkip.hidden = true;
    }
  }
  pMain.addEventListener('click', () => {
    if (running) setPaused(!paused);
    else replay();
  });
  pSkip.addEventListener('click', skip);
  pill.querySelector('[data-p=close]').addEventListener('click', () => {
    skip();
    agentsOff = true;
    root.classList.add('agents-off');
    localStorage.setItem('agents', 'off');
    agents.forEach((a) => show(a, false));
  });

  return { start, skip, replay, showBuilt, get running() { return running; } };
}
