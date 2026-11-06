// A swarm of labelled cursors that "build" each chapter: they fly to an element,
// frame it with a bounding box, then sweep across it while it is revealed.

const VARIANTS = ['orange', 'dark', 'light', 'orange', 'dark'];
const CURSOR = 'M1.5 1.5 L1.5 14 L5 10.6 L7.6 16 L10 15 L7.4 9.6 L12.4 9.6 Z';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

export function createSwarm({ layer, status, count = 16, idle = 3 }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = !reduced && localStorage.getItem('swarm') !== 'off';
  const allItems = () => [...document.querySelectorAll('[data-build]')];
  const ids = new Set();
  while (ids.size < count) ids.add(Math.floor(rnd(1, 64)));

  const agents = [...ids].map((id, i) => {
    const el = document.createElement('div');
    const v = VARIANTS[i % VARIANTS.length];
    el.className = `agent agent--${v}`;
    el.innerHTML = `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="${CURSOR}"/></svg><span class="agent-tag">agent-${String(id).padStart(2, '0')}</span>`;
    layer.appendChild(el);
    const p = offscreen();
    return { el, id, x: p.x, y: p.y, vx: 0, vy: 0, tx: p.x, ty: p.y, glide: null, arrive: null, chain: Promise.resolve(), visible: false, idle: false };
  });

  function offscreen() {
    const w = innerWidth, h = innerHeight, e = Math.floor(Math.random() * 4);
    if (e === 0) return { x: rnd(0, w), y: -40 };
    if (e === 1) return { x: w + 40, y: rnd(0, h) };
    if (e === 2) return { x: rnd(0, w), y: h + 40 };
    return { x: -40, y: rnd(0, h) };
  }

  function show(a, on) {
    a.visible = on;
    a.el.classList.toggle('is-on', on);
  }

  function moveTo(a, x, y, timeout = 1600) {
    a.glide = null;
    a.tx = x; a.ty = y;
    return new Promise((res) => {
      a.arrive = res;
      setTimeout(() => { if (a.arrive === res) { a.arrive = null; res(); } }, timeout);
    });
  }

  function glide(a, x0, y0, x1, y1, ms) {
    return new Promise((res) => { a.glide = { x0, y0, x1, y1, t0: performance.now(), ms, res }; });
  }

  function box(rect, label, a) {
    const b = document.createElement('div');
    b.className = `agent-box agent-box--${a.el.classList.contains('agent--light') ? 'light' : 'orange'}`;
    const pad = 6;
    b.style.left = `${rect.left - pad}px`;
    b.style.top = `${rect.top - pad}px`;
    b.style.width = `${rect.width + pad * 2}px`;
    b.style.height = `${rect.height + pad * 2}px`;
    if (rect.top < 28) b.classList.add('agent-box--below');
    b.innerHTML = `<span class="agent-box-tag">${label} · agent-${String(a.id).padStart(2, '0')}</span>`;
    layer.appendChild(b);
    return b;
  }

  function setStatus(text) {
    const built = allItems().filter((i) => i.classList.contains('built')).length;
    const total = allItems().length;
    status.querySelector('[data-s=count]').textContent = enabled ? `${count} agents` : 'swarm off';
    status.querySelector('[data-s=layers]').textContent = `${built}/${total} layers`;
    status.querySelector('[data-s=bar]').style.transform = `scaleX(${total ? built / total : 0})`;
    status.querySelector('[data-s=state]').textContent = text;
    const btn = status.querySelector('button');
    btn.textContent = enabled ? 'Swarm on' : 'Swarm off';
    btn.setAttribute('aria-pressed', String(enabled));
  }

  let running = 0;
  async function build(roots, label) {
    const items = roots.flatMap((r) => [...r.querySelectorAll('[data-build]:not(.built)'), ...(r.matches('[data-build]:not(.built)') ? [r] : [])]);
    if (!items.length) return;
    if (!enabled) {
      items.forEach((i) => i.classList.add('built'));
      setStatus('idle');
      return;
    }
    running++;
    setStatus(`building ${label}`);
    await sleep(380);
    const crew = agents.slice().sort(() => Math.random() - 0.5);
    const jobs = items.map((item, idx) => {
      const a = crew[idx % crew.length];
      a.idle = false;
      const job = a.chain.then(() => work(a, item, idx * 110));
      a.chain = job.catch(() => {});
      return job;
    });
    await Promise.all(jobs);
    running--;
    setStatus(running ? 'building' : 'idle');
    await sleep(600);
    if (!running) disperse();
  }

  async function work(a, item, delay) {
    await sleep(delay);
    if (!enabled) { item.classList.add('built'); return; }
    const r = item.getBoundingClientRect();
    if (!a.visible) {
      const p = offscreen();
      a.x = p.x; a.y = p.y;
      show(a, true);
    }
    await moveTo(a, r.left - 4, r.top + 2);
    const b = box(r, item.dataset.build, a);
    await sleep(240);
    item.classList.add('built');
    setStatus(`building`);
    const y = r.top + Math.min(r.height * 0.6, 40);
    await glide(a, r.left, y, r.right, y, Math.max(380, Math.min(950, r.width * 1.4)));
    setStatus('building');
    setTimeout(() => b.classList.add('is-out'), 650);
    setTimeout(() => b.remove(), 1300);
  }

  function disperse() {
    agents.forEach((a, i) => {
      if (i < idle && enabled) {
        a.idle = true;
        a.tx = rnd(innerWidth * 0.5, innerWidth * 0.92);
        a.ty = rnd(innerHeight * 0.18, innerHeight * 0.6);
      } else {
        a.idle = false;
        const p = offscreen();
        moveTo(a, p.x, p.y, 2000).then(() => { if (!a.idle) show(a, false); });
      }
    });
  }

  // idle agents wander and inspect whatever link the visitor hovers
  setInterval(() => {
    agents.forEach((a) => {
      if (!a.idle || !enabled || a.glide) return;
      if (Math.random() < 0.5) { a.tx = rnd(innerWidth * 0.45, innerWidth * 0.95); a.ty = rnd(innerHeight * 0.12, innerHeight * 0.62); }
    });
  }, 2600);
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('a, button');
    if (!t || !enabled) return;
    const a = agents.find((x) => x.idle && !x.busy);
    if (!a) return;
    a.busy = true;
    const r = t.getBoundingClientRect();
    moveTo(a, r.right - 6, r.bottom - 4, 900).then(() => {
      const b = box(r, t.tagName === 'A' ? 'a:link' : 'button', a);
      setTimeout(() => b.classList.add('is-out'), 700);
      setTimeout(() => { b.remove(); a.busy = false; }, 1300);
    });
  });

  status.querySelector('button').addEventListener('click', () => {
    enabled = !enabled;
    localStorage.setItem('swarm', enabled ? 'on' : 'off');
    if (!enabled) {
      agents.forEach((a) => { a.idle = false; show(a, false); });
      layer.querySelectorAll('.agent-box').forEach((b) => b.remove());
      allItems().forEach((i) => i.classList.add('built'));
    } else {
      disperse();
      agents.slice(0, idle).forEach((a) => { const p = offscreen(); a.x = p.x; a.y = p.y; show(a, true); });
    }
    document.documentElement.classList.toggle('swarm-on', enabled);
    setStatus('idle');
  });

  // spring integration
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    for (const a of agents) {
      if (a.glide) {
        const g = a.glide;
        const t = Math.min(1, (now - g.t0) / g.ms);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        a.tx = g.x0 + (g.x1 - g.x0) * e;
        a.ty = g.y0 + (g.y1 - g.y0) * e + Math.sin(t * Math.PI * 6) * 2;
        if (t >= 1) { a.glide = null; g.res(); }
      }
      const k = a.idle ? 18 : 70, c = 2 * Math.sqrt(k) * 0.82;
      a.vx += ((a.tx - a.x) * k - a.vx * c) * dt;
      a.vy += ((a.ty - a.y) * k - a.vy * c) * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      if (a.arrive && Math.hypot(a.tx - a.x, a.ty - a.y) < 3 && Math.hypot(a.vx, a.vy) < 60) {
        const r = a.arrive; a.arrive = null; r();
      }
      if (a.visible || a.arrive) a.el.style.transform = `translate3d(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px, 0)`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  document.documentElement.classList.toggle('swarm-on', enabled);
  setStatus('waiting');

  return { build, get enabled() { return enabled; }, setStatus };
}
