import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './style.css';
import { createBuilder } from './builder.js';
import { createHeroArt } from './hero3d.js';

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
window.__builderStarted = true;

const params = new URLSearchParams(location.search);
const small = window.matchMedia('(max-width: 760px)').matches;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const agentsOff = localStorage.getItem('agents') === 'off';
const speed = Math.min(3, Math.max(0.2, parseFloat(params.get('speed')) || 1));

const art = createHeroArt($('.hero-art'));
const builder = createBuilder({
  overlay: $('#overlay'),
  pill: $('#pill'),
  page: $('.page'),
  count: small ? 8 : 10,
  keep: 0,
  speed,
});

$('#replay').addEventListener('click', () => builder.replay());

const copyBtn = $('#copy-email');
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('abeua53@gmail.com');
    copyBtn.textContent = 'Copied';
  } catch {
    copyBtn.textContent = 'Select it';
  }
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1600);
});

(async () => {
  try { await document.fonts.ready; } catch { /* fonts are optional */ }
  if (reduced || agentsOff || params.has('static')) {
    builder.showBuilt({ off: agentsOff });
    if (art) art.setBuilt();
  } else {
    builder.start();
  }
})();

root.classList.add('js-ready');
