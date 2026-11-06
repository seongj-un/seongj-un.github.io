import '@fontsource/dm-serif-display/latin-400.css';
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './style.css';
import { createWorld } from './world.js';
import { createSwarm } from './swarm.js';

const $ = (s, r = document) => r.querySelector(s);
const root = document.documentElement;
const small = window.matchMedia('(max-width: 760px)').matches;
const lowPower = small || (navigator.hardwareConcurrency || 8) <= 4;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const chapters = [...document.querySelectorAll('.chapter')];
const finale = $('#finale');
const counter = $('#chapter-num');
// camera z ranges in which each chapter is on screen (see world.js layout)
const RANGES = [[99, -44], [-62, -122], [-133, -163], [-186, -262]];
const FINALE_AT = 0.962;

const swarm = createSwarm({ layer: $('#swarm'), status: $('#swarm-status'), count: small ? 9 : 18, idle: small ? 0 : 3 });

let world;
try {
  world = createWorld($('#scene'), { lowPower });
} catch (err) {
  console.error(err);
  root.classList.add('no-webgl');
  document.querySelectorAll('[data-build]').forEach((el) => el.classList.add('built'));
}

let target = 0, current = 0;
const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
const readScroll = () => { target = window.scrollY / maxScroll(); };
window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', () => { world && world.resize(); readScroll(); });

const ptr = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  ptr.x = (e.clientX / innerWidth) * 2 - 1;
  ptr.y = -((e.clientY / innerHeight) * 2 - 1);
});

const built = new Set();
let active = -2;
function activate(idx) {
  if (idx === active) return;
  active = idx;
  chapters.forEach((c, i) => {
    c.classList.toggle('is-active', i === idx);
    c.setAttribute('aria-hidden', String(i !== idx));
  });
  const fin = idx === chapters.length;
  finale.classList.toggle('is-active', fin);
  root.classList.toggle('is-light', fin);
  if (idx >= 0) counter.textContent = String(Math.min(idx + 1, chapters.length)).padStart(2, '0');
  if (idx >= 0 && !built.has(idx)) {
    built.add(idx);
    const el = fin ? finale : chapters[idx];
    const roots = idx === 0 ? [$('.topbar'), el] : [el];
    swarm.build(roots, fin ? 'finale' : `chapter ${String(idx + 1).padStart(2, '0')}`);
  }
}

function chapterFor(z, s) {
  if (s >= FINALE_AT) return chapters.length;
  for (let i = 0; i < RANGES.length; i++) if (z <= RANGES[i][0] && z >= RANGES[i][1]) return i;
  return -1;
}

const whiteout = $('#whiteout');
const scrim = $('.scrim');
const scrimFor = (z) => (z > -55 ? 0.78 : z > -128 ? 0.7 : z > -170 ? 0.45 : 1);
let scrimNow = 0.78;
const hint = $('#scroll-hint');
let last = performance.now();
let started = false;

let perfFrames = 0, perfTime = 0;
function frame(now) {
  const raw = (now - last) / 1000;
  const dt = Math.min(0.1, raw);
  last = now;
  // adaptive resolution: sample ~90 frames, step down if the average is under ~45 fps
  if (world && started && raw < 1) {
    perfFrames++; perfTime += raw;
    if (perfFrames === 90) {
      if (perfTime / perfFrames > 0.022) world.degrade();
      perfFrames = 0; perfTime = 0;
    }
  }
  const ease = reduced ? 1 : 1 - Math.exp(-dt * 3.2);
  current += (target - current) * ease;
  if (Math.abs(target - current) < 1e-5) current = target;
  if (world) {
    world.update(current, dt, small ? null : ptr);
    world.render();
    if (started) activate(chapterFor(world.camZ, current));
    scrimNow += (scrimFor(world.camZ) - scrimNow) * Math.min(1, dt * 2);
    scrim.style.opacity = scrimNow.toFixed(3);
  } else if (started) {
    activate(Math.min(chapters.length, Math.floor(current * (chapters.length + 1))));
  }
  const w = Math.min(1, Math.max(0, (current - 0.93) / 0.035));
  whiteout.style.opacity = w.toFixed(3);
  hint.classList.toggle('is-hidden', current > 0.01);
  requestAnimationFrame(frame);
}

readScroll();
current = target;

// ?shot : render-on-demand mode for automated screenshots (no animation loop)
if (new URLSearchParams(location.search).has('shot') && world) {
  window.__shot = (s, steps = 1) => {
    document.querySelectorAll('[data-build]').forEach((el) => el.classList.add('built'));
    started = true;
    for (let i = 0; i < steps; i++) world.update(s, 1 / 60, null);
    world.render();
    activate(chapterFor(world.camZ, s));
    scrim.style.opacity = scrimFor(world.camZ);
    whiteout.style.opacity = Math.min(1, Math.max(0, (s - 0.93) / 0.035)).toFixed(3);
    root.classList.add('is-ready');
    return world.camZ;
  };
} else requestAnimationFrame((t) => {
  last = t;
  frame(t);
  // first frame is on screen: lift the loader, then let the swarm build chapter one
  requestAnimationFrame(() => {
    root.classList.add('is-ready');
    setTimeout(() => { started = true; }, 900);
  });
});
