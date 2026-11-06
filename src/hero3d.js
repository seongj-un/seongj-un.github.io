import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Hero object: a glossy trefoil "pipeline" with amber requests flowing through it.
// Build states follow the layer events from builder.js:
//   layerstart -> the wireframe draws itself along the curve
//   layerbuilt -> the solid tube extrudes over the wireframe, then the orbs arrive
//   layerreset -> back to empty

const P = 2, Q = 3, R = 1.3, SY = 1.28;

class Trefoil extends THREE.Curve {
  getPoint(t, out = new THREE.Vector3()) {
    const u = t * P * Math.PI * 2;
    const cs = Math.cos((Q / P) * u);
    return out.set(R * (2 + cs) * 0.5 * Math.cos(u), R * (2 + cs) * 0.5 * Math.sin(u) * SY, R * Math.sin((Q / P) * u) * 0.62);
  }
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createHeroArt(host) {
  const canvas = host.querySelector('canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('WebGL unavailable', err);
    host.classList.add('no-gl');
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.5;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 0, 12.6);

  const key = new THREE.DirectionalLight('#ffffff', 1.7);
  key.position.set(3, 4, 6);
  const rim = new THREE.DirectionalLight('#7fb2ff', 2.2);
  rim.position.set(-5, -2, -4);
  scene.add(key, rim, new THREE.AmbientLight('#ffffff', 0.25));

  const group = new THREE.Group();
  scene.add(group);

  const curve = new Trefoil();
  const solidGeo = new THREE.TubeGeometry(curve, 420, 0.36, 36, true);
  const wireGeo = new THREE.TubeGeometry(curve, 150, 0.37, 10, true);
  const solidMat = new THREE.MeshPhysicalMaterial({ color: '#0f3dff', metalness: 0.0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  const wireMat = new THREE.MeshBasicMaterial({ color: '#5aa9ff', wireframe: true, transparent: true, opacity: 0.55, depthWrite: false });
  const solid = new THREE.Mesh(solidGeo, solidMat);
  const wire = new THREE.Mesh(wireGeo, wireMat);
  group.add(solid, wire);
  const solidCount = solidGeo.index.count;
  const wireCount = wireGeo.index.count;

  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,190,90,0.9)');
    g.addColorStop(0.35, 'rgba(255,150,40,0.35)');
    g.addColorStop(1, 'rgba(255,140,30,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const orbGeo = new THREE.SphereGeometry(0.44, 32, 20);
  const orbMat = new THREE.MeshPhysicalMaterial({ color: '#ffa400', emissive: '#ff6a00', emissiveIntensity: 0.32, roughness: 0.25, clearcoat: 1 });
  const orbs = Array.from({ length: 6 }, (_, i) => {
    const m = new THREE.Mesh(orbGeo, orbMat);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(2.2);
    m.add(glow);
    group.add(m);
    return { m, glow, phase: i / 6 };
  });

  group.rotation.set(0.42, 0, 0.18);

  // build state
  let wireT = 0, solidT = 0, orbT = 0;
  let wireOn = false, solidOn = false;
  host.addEventListener('layerstart', () => { wireOn = true; wake(); });
  host.addEventListener('layerbuilt', () => { wireOn = true; solidOn = true; wake(); });
  host.addEventListener('layerreset', () => { wireOn = solidOn = false; wireT = solidT = orbT = 0; wake(); });

  // pointer parallax
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', (e) => {
    ptr.x = (e.clientX / innerWidth) * 2 - 1;
    ptr.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / h < 0.9 ? 12.6 / (w / h) * 0.9 : 12.6;
    camera.updateProjectionMatrix();
    wake();
  }
  new ResizeObserver(resize).observe(host);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }).observe(host);
  document.addEventListener('visibilitychange', wake);

  const tmp = new THREE.Vector3();
  let raf = 0, last = performance.now(), time = 0, spin = 0;
  function wake() {
    if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;

    wireT = wireOn ? Math.min(1, wireT + dt / 0.9) : 0;
    solidT = solidOn ? Math.min(1, solidT + dt / 1.3) : 0;
    orbT = solidT >= 1 ? Math.min(1, orbT + dt / 0.6) : 0;

    wire.visible = wireT > 0 && solidT < 1;
    wireGeo.setDrawRange(0, Math.floor((wireCount * smooth(0, 1, wireT)) / 3) * 3);
    wireMat.opacity = 0.55 * (1 - smooth(0.6, 1, solidT));
    solid.visible = solidT > 0;
    solidGeo.setDrawRange(0, Math.floor((solidCount * smooth(0, 1, solidT)) / 3) * 3);

    for (const o of orbs) {
      const u = (o.phase + time * 0.045) % 1;
      curve.getPointAt(u, tmp);
      o.m.position.copy(tmp);
      const s = orbT * (1 + 0.04 * Math.sin(time * 3 + o.phase * 9));
      o.m.scale.setScalar(Math.max(0.0001, s));
      o.m.visible = orbT > 0;
    }

    ptr.sx += (ptr.x - ptr.sx) * Math.min(1, dt * 2.5);
    ptr.sy += (ptr.y - ptr.sy) * Math.min(1, dt * 2.5);
    spin += dt * 0.32;
    group.rotation.y = spin + ptr.sx * 0.35;
    group.rotation.x = 0.42 + ptr.sy * 0.18;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  resize();
  wake();

  return {
    setBuilt() { wireOn = solidOn = true; wireT = solidT = orbT = 1; wake(); },
  };
}
