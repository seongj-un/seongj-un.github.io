# seongj-un.github.io

Portfolio of Seongjun Park (박성준), backend developer.

A scroll-driven 3D flight: a paper plane leaves a desk and flies through four chapters (meadow, forest, tunnel, sky cliffs) before the screen fades to white. A small swarm of cursor "agents" frames and reveals each chapter's text as it appears.

- Scene: Three.js, every model built in code (`src/world.js`), no external assets
- Overlay: plain DOM and CSS (`src/swarm.js`, `src/style.css`)
- Build: Vite. Deploy: GitHub Actions to GitHub Pages on every push to `main`

```bash
npm install
npm run dev      # local dev server
npm run build    # outputs dist/
```

`?shot` in the URL disables the animation loop and exposes `window.__shot(progress)` for taking stills.

The swarm can be switched off from the pill at the bottom; the choice is kept in localStorage. It is also off when the visitor prefers reduced motion.
