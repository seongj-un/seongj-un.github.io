# seongj-un.github.io

Portfolio of Seongjun Park (박성준), 5x engineer.

The page is built live in front of the visitor by a small crew of cursor agents (10 on desktop, 8 on phones): they drag out wireframes, fill grey placeholders, type headings and sweep-select paragraphs, scrolling down section by section. Only agents with work are on screen; an idle one fades out where it stopped and every agent leaves once the page is done. The pill at the bottom shows progress and lets you pause, skip, replay or hide the agents.

- `src/builder.js`: the agents and the director. Every element marked `data-layer` is one layer (`block`, `frame`, `rule`, `type`, `sweep`).
- `src/hero3d.js`: the hero object in Three.js. A trefoil tube with requests flowing through it; it draws as a wireframe, then extrudes solid when its layer is built.
- `src/style.css`, `index.html`: the page itself. Without JavaScript, everything is visible as normal.

```bash
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=343" npm install
npm run dev      # local dev server
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=343" npm run build    # outputs dist/
```

URL flags: `?static` shows the finished page without the build, `?speed=0.5` plays it faster (lower is faster).
The build is skipped for visitors who prefer reduced motion, and after the agents are hidden with the × button (stored in localStorage).

Deploys to GitHub Pages through GitHub Actions on every push to `main`.
