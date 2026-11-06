import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, noise3, fbm2, smoothstep, clamp } from './noise.js';

/*
  One continuous world laid out along -Z:
    z  +12 .. -58   Sunny Meadow   (desk, paper plane, hills, fences)
    z  -58 .. -130  Enchanted Forest (tall trunks, light shafts, mushrooms)
    z -130 .. -173  The Tunnel     (dark rock tube, bright exit)
    z -173 .. -300  Sky Cliffs     (floating islands, waterfalls, cloud sea)
  The camera rides a spline; the paper plane flies just ahead of it.
*/

const CAMERA_PATH = [
  [0, 1.95, 5.2], [0.2, 2.2, -3], [-1.6, 2.5, -18], [1.4, 2.4, -34], [-0.6, 2.3, -50],
  [0, 2.2, -64], [-2.4, 2.1, -80], [1.8, 2.2, -96], [-1, 2.1, -112], [0, 2.2, -124],
  [0, 2.2, -136], [0, 2.2, -150], [0, 2.3, -163], [0, 2.8, -174],
  [0, 4.6, -190], [4.5, 6, -212], [-2.5, 7.5, -236], [1.5, 9, -258], [0, 11, -280], [0, 13.5, -302],
];

// Environment keyframes keyed by camera z (descending).
const ENV = [
  { z: 12, top: '#2b7ddc', hor: '#cfe4f4', fog: '#cfe4f4', near: 30, far: 175, hemi: 1.55, sun: 2.4, grass: 1.0, dust: 0.35, glow: 0 },
  { z: -46, top: '#2b7ddc', hor: '#cfe4f4', fog: '#cfe4f4', near: 30, far: 175, hemi: 1.55, sun: 2.4, grass: 1.0, dust: 0.35, glow: 0 },
  { z: -66, top: '#5c9cc2', hor: '#a8c8b0', fog: '#7f9f78', near: 6, far: 88, hemi: 1.1, sun: 1.7, grass: 0.72, dust: 0.9, glow: 0 },
  { z: -116, top: '#46808d', hor: '#6f8c63', fog: '#4f6d47', near: 4, far: 72, hemi: 0.9, sun: 1.3, grass: 0.55, dust: 1.0, glow: 0 },
  { z: -128, top: '#2a382d', hor: '#34412f', fog: '#2c3829', near: 2, far: 58, hemi: 0.7, sun: 0.9, grass: 0.4, dust: 1.0, glow: 0.4 },
  { z: -133, top: '#cfe0ee', hor: '#eef4f8', fog: '#eaf2f8', near: 6, far: 120, hemi: 0.8, sun: 1.2, grass: 0.4, dust: 0.9, glow: 1 },
  { z: -166, top: '#cfe0ee', hor: '#eef4f8', fog: '#eaf2f8', near: 10, far: 170, hemi: 1.0, sun: 1.6, grass: 0.4, dust: 0.6, glow: 1 },
  { z: -184, top: '#2a78d6', hor: '#e2edf6', fog: '#dce9f3', near: 45, far: 430, hemi: 1.6, sun: 2.5, grass: 1.0, dust: 0.0, glow: 0.2 },
  { z: -262, top: '#2a78d6', hor: '#e2edf6', fog: '#dce9f3', near: 45, far: 430, hemi: 1.6, sun: 2.5, grass: 1.0, dust: 0.0, glow: 0 },
  { z: -284, top: '#cfe3f5', hor: '#ffffff', fog: '#fbfaf7', near: 4, far: 70, hemi: 1.9, sun: 2.0, grass: 1.0, dust: 0.0, glow: 0 },
  { z: -304, top: '#fbfaf7', hor: '#fbfaf7', fog: '#fbfaf7', near: 0, far: 12, hemi: 2.0, sun: 2.0, grass: 1.0, dust: 0.0, glow: 0 },
].map((k) => ({ ...k, top: new THREE.Color(k.top), hor: new THREE.Color(k.hor), fog: new THREE.Color(k.fog) }));

export function createWorld(canvas, opts = {}) {
  const low = !!opts.lowPower;
  const rand = mulberry32(20261106);
  const rr = (a, b) => a + (b - a) * rand();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.25 : 1.6));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = !low;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfe4f4, 30, 175);
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 1600);

  const curve = new THREE.CatmullRomCurve3(CAMERA_PATH.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  // z -> path x lookup (path z is monotonic)
  const zTable = [];
  for (let i = 0; i <= 1500; i++) zTable.push(curve.getPointAt(i / 1500));
  function pathAtZ(z) {
    if (z >= zTable[0].z) return zTable[0];
    for (let i = 1; i < zTable.length; i++) {
      if (zTable[i].z <= z) {
        const a = zTable[i - 1], b = zTable[i];
        const t = (z - a.z) / (b.z - a.z || 1);
        return new THREE.Vector3().lerpVectors(a, b, t);
      }
    }
    return zTable[zTable.length - 1];
  }
  const pathX = (z) => pathAtZ(z).x;

  // ---------- geometry helpers ----------
  const KEEP = ['position', 'normal', 'color'];
  function prep(geo) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
    return g;
  }
  const tmpC = new THREE.Color();
  function colorize(geo, fn) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      fn(tmpC, p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 0);
      col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }
  function blob(r, detail, amp, seed, squash = 1) {
    let g = new THREE.IcosahedronGeometry(r, detail);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = noise3(v.x * 1.4 / r + seed, v.y * 1.4 / r + seed * 0.3, v.z * 1.4 / r);
      v.multiplyScalar(1 + (n - 0.5) * amp);
      if (v.y < -r * 0.25) v.y = -r * 0.25 + (v.y + r * 0.25) * 0.55;
      v.y *= squash;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  }
  const C = (hex) => new THREE.Color(hex);
  const shadeGreen = (lo, hi, base) => (c, x, y, z, ny) => {
    const t = clamp(0.5 + ny * 0.5, 0, 1);
    c.copy(lo).lerp(hi, t);
    const n = noise3(x * 0.8 + base, y * 0.8, z * 0.8);
    c.multiplyScalar(0.86 + n * 0.28);
  };

  // ---------- tree / bush prototypes ----------
  function roundTree(seed, palette) {
    const parts = [];
    const trunk = new THREE.CylinderGeometry(0.15, 0.3, 3.4, 7, 3);
    trunk.translate(0, 1.7, 0);
    parts.push(prep(colorize(trunk, (c) => c.set('#5b3e27'))));
    for (const s of [-1, 1]) {
      const br = new THREE.CylinderGeometry(0.05, 0.11, 1.5, 5);
      br.translate(0, 0.75, 0);
      br.rotateZ(s * 0.75);
      br.translate(0, 2.3, 0);
      parts.push(prep(colorize(br, (c) => c.set('#5b3e27'))));
    }
    const n = 4 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const r = rr(1.0, 1.55);
      const g = blob(r, 2, 0.4, seed * 7 + i);
      const a = (i / n) * Math.PI * 2 + rr(-0.3, 0.3);
      const d = i === 0 ? 0 : rr(0.7, 1.3);
      g.translate(Math.cos(a) * d, 3.7 + rr(-0.2, 0.7) + (i === 0 ? 0.7 : 0), Math.sin(a) * d);
      parts.push(prep(colorize(g, shadeGreen(palette[0], palette[1], seed))));
    }
    return mergeGeometries(parts);
  }
  function tallTree(seed) {
    const parts = [];
    const h = rr(13, 16);
    const trunk = new THREE.CylinderGeometry(0.28, 0.55, h, 8, 6);
    const p = trunk.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / h + 0.5;
      p.setX(i, p.getX(i) + Math.sin(y * 3 + seed) * 0.25 * y);
    }
    trunk.computeVertexNormals();
    trunk.translate(0, h / 2, 0);
    parts.push(prep(colorize(trunk, (c, x, y) => c.set('#3f2c1e').multiplyScalar(0.8 + 0.35 * (y / h)))));
    const flare = new THREE.CylinderGeometry(0.55, 1.15, 1.3, 8);
    flare.translate(0, 0.65, 0);
    parts.push(prep(colorize(flare, (c) => c.set('#36261a'))));
    const n = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const r = rr(1.8, 2.8);
      const g = blob(r, 2, 0.45, seed * 11 + i, 0.8);
      const a = (i / n) * Math.PI * 2;
      const d = i === 0 ? 0 : rr(1.6, 2.8);
      g.translate(Math.cos(a) * d, h - 1.5 + rr(-1.5, 1.5), Math.sin(a) * d);
      parts.push(prep(colorize(g, shadeGreen(C('#24461d'), C('#6e9e3a'), seed))));
    }
    return mergeGeometries(parts);
  }
  function bush(seed, lo, hi) {
    const parts = [];
    const n = 3;
    for (let i = 0; i < n; i++) {
      const r = rr(0.5, 0.85);
      const g = blob(r, 2, 0.35, seed * 5 + i, 0.85);
      g.translate(rr(-0.5, 0.5), r * 0.55, rr(-0.4, 0.4));
      parts.push(prep(colorize(g, shadeGreen(lo, hi, seed))));
    }
    return mergeGeometries(parts);
  }

  const vcMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const dummy = new THREE.Object3D();
  function scatter(geo, mat, list, { cast = true, receive = false } = {}) {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
      dummy.scale.set(it.s || 1, (it.s || 1) * (it.sy || 1), it.s || 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      if (it.c !== undefined) m.setColorAt(i, tmpC.setScalar(it.c));
    });
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.computeBoundingSphere();
    scene.add(m);
    return m;
  }

  // ---------- sky dome ----------
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHor; varying vec3 vDir;
      void main(){ float h = vDir.y; vec3 c = mix(uHor, uTop, pow(smoothstep(-0.02, 0.55, h), 0.75));
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xd8ecff, 0x56703a, 1.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.castShadow = !low;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -38; sc.right = 38; sc.top = 38; sc.bottom = -38; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // ---------- ground ----------
  const GROUND_Z0 = 14, GROUND_Z1 = -134;
  function groundHeight(x, z) {
    const d = Math.abs(x - pathX(z));
    let h = (fbm2(x * 0.07, z * 0.07) - 0.5) * 1.1;
    const side = smoothstep(7, 48, d);
    const meadow = smoothstep(-70, -40, z);
    h += side * (3 + 7 * fbm2(x * 0.025 + 3, z * 0.025)) * (0.5 + 0.5 * meadow);
    h -= (1 - smoothstep(0, 3.5, d)) * 0.15;
    return h;
  }
  {
    const W = 230, L = GROUND_Z0 - GROUND_Z1;
    const g = new THREE.PlaneGeometry(W, L, low ? 115 : 200, low ? 74 : 148);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, (GROUND_Z0 + GROUND_Z1) / 2);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const gA = C('#4c8a2c'), gB = C('#86b83e'), fA = C('#24461b'), fB = C('#46702a'), dirt = C('#9b7550'), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, groundHeight(x, z));
      const forest = smoothstep(-48, -66, z);
      const n = fbm2(x * 0.12 + 9, z * 0.12);
      c.copy(gA).lerp(gB, n);
      const cf = fA.clone().lerp(fB, n);
      c.lerp(cf, forest);
      const d = Math.abs(x - pathX(z));
      const path = 1 - smoothstep(0.7, 1.5, d + (noise3(x * 0.6, 0, z * 0.6) - 0.5) * 0.6);
      c.lerp(dirt.clone().multiplyScalar(1 - forest * 0.45), path * (z < 1 ? 1 : 0));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ---------- grass ----------
  const grassUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uTime: { value: 0 }, uLight: { value: 1 }, uBottom: { value: C('#1f4514') }, uTop: { value: C('#9ccc4c') } },
  ]);
  const grassMat = new THREE.ShaderMaterial({
    uniforms: grassUniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      uniform float uTime;
      attribute vec3 aTint;
      varying float vH;
      varying vec3 vTint;
      void main(){
        vec3 p = position;
        vH = p.y;
        vTint = aTint;
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        float w = sin(uTime * 1.7 + wp.x * 0.35 + wp.z * 0.22) * 0.6 + sin(uTime * 2.9 + wp.x * 1.1 + wp.z * 0.7) * 0.25;
        wp.x += w * p.y * p.y * 0.22;
        wp.z += w * p.y * p.y * 0.1;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uBottom; uniform vec3 uTop; uniform float uLight;
      varying float vH; varying vec3 vTint;
      void main(){
        vec3 c = mix(uBottom, uTop * vTint, smoothstep(0.0, 1.0, vH));
        gl_FragColor = vec4(c * uLight, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  {
    const blade = new THREE.PlaneGeometry(0.1, 1, 1, 4);
    blade.translate(0, 0.5, 0);
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setX(i, bp.getX(i) * (1 - bp.getY(i) * 0.92));
    const N = low ? 16000 : 42000;
    const mesh = new THREE.InstancedMesh(blade, grassMat, N);
    const tint = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const z = rr(10, -131);
      const side = rand() < 0.5 ? -1 : 1;
      const off = Math.pow(rand(), 1.6) * 34 + 0.6;
      const x = pathX(z) + side * off;
      const forest = smoothstep(-48, -66, z);
      dummy.position.set(x, groundHeight(x, z) - 0.05, z);
      dummy.rotation.set(rr(-0.15, 0.15), rr(0, Math.PI), rr(-0.2, 0.2));
      const h = rr(0.35, 0.95) * (off < 1.3 ? 0.45 : 1) * (1 + forest * 0.2);
      dummy.scale.set(rr(0.8, 1.4), h, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const t = rr(0.82, 1.15) * (1 - forest * 0.35);
      tint[i * 3] = t * rr(0.9, 1.1); tint[i * 3 + 1] = t; tint[i * 3 + 2] = t * rr(0.85, 1.0);
    }
    blade.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // ---------- desk with paper and pencil ----------
  {
    const deskZ = [1.6, 2.5, 3.4];
    deskZ.forEach((z, i) => {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.22, 0.86), new THREE.MeshLambertMaterial({ color: ['#8d5c34', '#94633a', '#875731'][i] }));
      plank.position.set(0.4, 0.89, z);
      plank.castShadow = true; plank.receiveShadow = true;
      scene.add(plank);
    });
    const apron = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.5, 0.12), new THREE.MeshLambertMaterial({ color: '#5e3c22' }));
    apron.position.set(0.4, 0.55, 1.25);
    scene.add(apron);
    for (const [x, z] of [[-2.9, 1.35], [3.7, 1.35]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.18), new THREE.MeshLambertMaterial({ color: '#5e3c22' }));
      leg.position.set(x, 0.25, z);
      leg.castShadow = true;
      scene.add(leg);
    }
    const paperMat = new THREE.MeshLambertMaterial({ color: '#f5f2ea' });
    for (let i = 0; i < 6; i++) {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.014, 0.92), paperMat);
      sheet.position.set(-1.05 + rr(-0.03, 0.03), 1.008 + i * 0.016, 2.35 + rr(-0.03, 0.03));
      sheet.rotation.y = 0.08 + rr(-0.05, 0.05);
      sheet.castShadow = true; sheet.receiveShadow = true;
      scene.add(sheet);
    }
    const pencil = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 6), new THREE.MeshLambertMaterial({ color: '#e9b72a' }));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 6), new THREE.MeshLambertMaterial({ color: '#e8cfa6' }));
    tip.position.y = 0.535;
    const lead = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.04, 6), new THREE.MeshLambertMaterial({ color: '#2a2a2a' }));
    lead.position.y = 0.6;
    pencil.add(body, tip, lead);
    pencil.rotation.set(Math.PI / 2, 0, -0.95);
    pencil.position.set(0.35, 1.035, 2.95);
    pencil.traverse((o) => (o.castShadow = true));
    scene.add(pencil);
  }

  // ---------- paper plane ----------
  const planeGeo = new THREE.BufferGeometry();
  {
    // nose points to +Z so Object3D.lookAt aims it along the flight direction
    const N = [0, 0, 1.0], T = [0, 0, -0.62], K = [0, -0.2, -0.62], L = [-0.58, 0.07, -0.62], R = [0.58, 0.07, -0.62];
    const tris = [N, L, T, N, T, R, N, T, K, N, K, T].flat();
    planeGeo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    planeGeo.computeVertexNormals();
  }
  const planeMat = new THREE.MeshStandardMaterial({ color: '#f6eedc', roughness: 0.85, side: THREE.DoubleSide, flatShading: true, emissive: '#fff3dc', emissiveIntensity: 0 });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.scale.setScalar(0.62);
  plane.castShadow = true;
  scene.add(plane);
  const restPos = new THREE.Vector3(1.0, 1.0 + 0.2 * 0.62, 2.2);
  const restQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI + 0.35, 0));

  // ---------- meadow: trees, bushes, fences, rocks ----------
  const meadowPalettes = [[C('#2f6420'), C('#8cc04a')], [C('#356b22'), C('#a2c957')], [C('#2a5a1e'), C('#77b042')]];
  const roundVariants = [0, 1, 2, 3].map((i) => roundTree(i + 1, meadowPalettes[i % 3]));
  const meadowTrees = [[], [], [], []];
  for (let i = 0; i < (low ? 30 : 46); i++) {
    const z = rr(-6, -62);
    const side = rand() < 0.5 ? -1 : 1;
    const d = rr(9, 50);
    const x = pathX(z) + side * d;
    meadowTrees[i % 4].push({ x, y: groundHeight(x, z) - 0.1, z, ry: rr(0, 6.28), s: rr(0.9, 1.7), c: rr(0.85, 1.1) });
  }
  // a couple of hero trees framing the meadow
  meadowTrees[0].push({ x: -9.5, y: groundHeight(-9.5, -16) - 0.1, z: -16, ry: 1, s: 1.8, c: 1 });
  meadowTrees[1].push({ x: 11, y: groundHeight(11, -24) - 0.1, z: -24, ry: 2, s: 2.0, c: 1 });
  roundVariants.forEach((g, i) => scatter(g, vcMat, meadowTrees[i]));

  const bushVariants = [0, 1, 2].map((i) => bush(i + 3, C('#2d5e1d'), C('#8fc24c')));
  const forestBushVariants = [0, 1].map((i) => bush(i + 9, C('#1b3a14'), C('#5e8e33')));
  const bushes = [[], [], []], fbushes = [[], []];
  for (let i = 0; i < (low ? 120 : 220); i++) {
    const z = rr(4, -128);
    const side = rand() < 0.5 ? -1 : 1;
    const d = rr(2.4, 28);
    const x = pathX(z) + side * d;
    const it = { x, y: groundHeight(x, z) - 0.05, z, ry: rr(0, 6.28), s: rr(0.8, 1.8), c: rr(0.85, 1.1) };
    if (z > -56) bushes[i % 3].push(it); else fbushes[i % 2].push(it);
  }
  bushVariants.forEach((g, i) => scatter(g, vcMat, bushes[i]));
  forestBushVariants.forEach((g, i) => scatter(g, vcMat, fbushes[i]));

  {
    const woodMat = new THREE.MeshLambertMaterial({ color: '#6b4a2f' });
    const posts = [], rails = [];
    const fenceLine = (side, off, z0, z1) => {
      let prev = null;
      for (let z = z0; z > z1; z -= 2.3) {
        const x = pathX(z) + side * (off + Math.sin(z * 0.08) * 0.6);
        const y = groundHeight(x, z);
        const cur = new THREE.Vector3(x, y, z);
        posts.push({ x, y: y + 0.55, z, ry: rr(-0.1, 0.1) });
        if (prev) {
          for (const h of [0.45, 0.85]) {
            const mid = new THREE.Vector3().lerpVectors(prev, cur, 0.5);
            const dir = new THREE.Vector3().subVectors(cur, prev);
            rails.push({ x: mid.x, y: mid.y + h, z: mid.z, ry: Math.atan2(dir.x, dir.z), rx: -Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), s: 1, sy: 1, len: dir.length() });
          }
        }
        prev = cur;
      }
    };
    fenceLine(-1, 3.6, 0, -44);
    fenceLine(1, 4.6, -8, -54);
    const postGeo = new THREE.BoxGeometry(0.14, 1.1, 0.14);
    const railGeo = new THREE.BoxGeometry(0.07, 0.09, 2.3);
    scatter(postGeo, woodMat, posts);
    scatter(railGeo, woodMat, rails);
  }

  // ---------- forest: tall trees, light shafts, mushrooms ----------
  let shaftMat;
  const tallVariants = [0, 1, 2].map((i) => tallTree(i + 21));
  const tall = [[], [], []];
  for (let i = 0; i < (low ? 120 : 220); i++) {
    const z = rr(-54, -129);
    const side = rand() < 0.5 ? -1 : 1;
    const d = rr(3.6, 48) * (rand() < 0.4 ? 0.45 : 1) + 3.2;
    const x = pathX(z) + side * d;
    const density = smoothstep(-50, -70, z);
    if (rand() > density + 0.08) continue;
    tall[i % 3].push({ x, y: groundHeight(x, z) - 0.2, z, ry: rr(0, 6.28), s: rr(0.85, 1.25), c: rr(0.8, 1.1) });
  }
  for (let i = 0; i < 34; i++) {
    const x = (i % 2 ? 1 : -1) * rr(6.5, 60);
    const z = rr(-124.5, -128.5);
    tall[i % 3].push({ x, y: groundHeight(x, z) - 0.2, z, ry: rr(0, 6.28), s: rr(1.1, 1.4), c: rr(0.8, 1.05) });
  }
  tallVariants.forEach((g, i) => scatter(g, vcMat, tall[i]));

  {
    const cvs = document.createElement('canvas');
    cvs.width = 64; cvs.height = 256;
    const ctx = cvs.getContext('2d');
    const gx = ctx.createLinearGradient(0, 0, 64, 0);
    gx.addColorStop(0, 'rgba(255,255,255,0)');
    gx.addColorStop(0.5, 'rgba(255,255,255,1)');
    gx.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, 64, 256);
    ctx.globalCompositeOperation = 'destination-in';
    const gy = ctx.createLinearGradient(0, 0, 0, 256);
    gy.addColorStop(0, 'rgba(0,0,0,0.9)');
    gy.addColorStop(0.75, 'rgba(0,0,0,0.35)');
    gy.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, 64, 256);
    const tex = new THREE.CanvasTexture(cvs);
    shaftMat = new THREE.MeshBasicMaterial({ map: tex, color: '#fff3c8', transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (let i = 0; i < 12; i++) {
      const z = rr(-68, -124);
      const x = pathX(z) + rr(-10, 10);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rr(2, 4.5), 28), shaftMat);
      m.position.set(x, 11, z);
      m.rotation.set(0, rr(-0.3, 0.3), -0.38);
      scene.add(m);
    }
  }
  {
    const stem = new THREE.CylinderGeometry(0.06, 0.08, 0.3, 6);
    stem.translate(0, 0.15, 0);
    const cap = new THREE.SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.7, 1);
    cap.translate(0, 0.28, 0);
    const g = mergeGeometries([prep(colorize(stem, (c) => c.set('#efe6d4'))), prep(colorize(cap, (c, x, y) => c.set('#c8582c').multiplyScalar(0.8 + y)))]);
    const list = [];
    for (let i = 0; i < 70; i++) {
      const z = rr(-64, -127);
      const x = pathX(z) + (rand() < 0.5 ? -1 : 1) * rr(1.6, 9);
      list.push({ x, y: groundHeight(x, z) - 0.02, z, ry: rr(0, 6), s: rr(0.6, 1.8) });
    }
    scatter(g, vcMat, list);
  }

  // ---------- the tunnel ----------
  const CAVE_Z0 = -131, CAVE_Z1 = -174, CAVE_Y = 2.3;
  let caveMat;
  {
    const len = CAVE_Z0 - CAVE_Z1;
    const g = new THREE.CylinderGeometry(5.4, 5.4, len, 36, 48, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, (CAVE_Z0 + CAVE_Z1) / 2);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3), c = new THREE.Color();
    const dark = C('#0d0b09'), mid = C('#2a2119'), lit = C('#a99a84');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(y, x);
      const n = noise3(Math.cos(a) * 2, Math.sin(a) * 2, z * 0.25);
      const r = 1 + (n - 0.5) * 0.5 + (noise3(x * 0.9, y * 0.9, z * 0.9) - 0.5) * 0.12;
      p.setXYZ(i, x * r, y * r * 0.82 + CAVE_Y, z);
      const exit = smoothstep(CAVE_Z1 + 16, CAVE_Z1, z);
      const entry = smoothstep(CAVE_Z0 - 6, CAVE_Z0, z);
      c.copy(dark).lerp(mid, n * 0.8 + entry * 0.5).lerp(lit, Math.pow(exit, 1.6) * (0.6 + n * 0.4));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    caveMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: true });
    const cave = new THREE.Mesh(g, caveMat);
    scene.add(cave);

    // cliff face around the mouth
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const rockBlock = (cx, cy, w, h, depth, seed) => {
      const b = new THREE.BoxGeometry(w, h, depth, Math.ceil(w / 1.5), Math.ceil(h / 1.5), 3);
      const bp = b.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < bp.count; i++) {
        v.fromBufferAttribute(bp, i);
        const n = noise3(v.x * 0.35 + seed, v.y * 0.35, v.z * 0.35);
        v.z += (n - 0.5) * 3.2;
        v.x += (noise3(v.y * 0.3, seed, v.z * 0.3) - 0.5) * 1.2;
        bp.setXYZ(i, v.x, v.y, v.z);
      }
      b.computeVertexNormals();
      b.translate(cx, cy, CAVE_Z0 - depth / 2 + 1.2);
      colorize(b, (c, x, y, z, ny) => {
        const n = noise3(x * 0.4, y * 0.4, z * 0.4);
        c.set('#5d5648').lerp(C('#3a3a2c'), n);
        if (ny > 0.45) c.lerp(C('#3f6a26'), 0.8);
      });
      const m = new THREE.Mesh(b, rockMat);
      m.receiveShadow = true;
      scene.add(m);
    };
    rockBlock(-57, 8, 106, 22, 8, 1);
    rockBlock(57, 8, 106, 22, 8, 2);
    rockBlock(0, 7.4 + 6.3, 12, 12.6, 8, 3);
    // boulders roughen the opening outline
    const boulders = [];
    for (let i = 0; i < 14; i++) {
      const a = rr(-0.2, Math.PI + 0.2);
      boulders.push({ x: Math.cos(a) * rr(5.6, 7.2), y: CAVE_Y + Math.sin(a) * rr(5.0, 6.2) - 0.8, z: CAVE_Z0 + rr(-0.5, 1.2), ry: rr(0, 6), s: rr(0.7, 1.3), c: rr(0.9, 1.2) });
    }
    const bg = new THREE.DodecahedronGeometry(1, 1);
    scatter(prep(colorize(bg, (c, x, y, z, ny) => c.set(ny > 0.5 ? '#4d7a2c' : '#77705f'))), vcMat, boulders, { cast: false });
  }
  // light at the end of the tunnel
  function radialTexture(stops) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const cx = cv.getContext('2d');
    const gr = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    cx.fillStyle = gr;
    cx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  }
  const glowMat = new THREE.SpriteMaterial({ map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(240,248,255,0.55)'], [1, 'rgba(255,255,255,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, opacity: 0 });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(17, 13, 1);
  glow.position.set(0, CAVE_Y + 0.4, CAVE_Z1 - 1);
  scene.add(glow);

  // ---------- sky cliffs ----------
  // soft billboard cloud puffs (one instanced draw call)
  const puffTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const cx = cv.getContext('2d');
    const prand = mulberry32(99);
    for (let i = 0; i < 14; i++) {
      const x = 128 + (prand() - 0.5) * 120, y = 140 + (prand() - 0.5) * 50 - Math.abs(x - 128) * 0.25;
      const rad = 38 + prand() * 34;
      const g = cx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = g;
      cx.beginPath(); cx.arc(x, y, rad, 0, Math.PI * 2); cx.fill();
    }
    return new THREE.CanvasTexture(cv);
  })();
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uTop: { value: C('#ffffff') }, uBottom: { value: C('#b9c9da') } }]),
    transparent: true, depthWrite: false, fog: true,
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float sx = length(instanceMatrix[0].xyz);
        float sy = length(instanceMatrix[1].xyz);
        vec4 mvPosition = viewMatrix * vec4(center, 1.0);
        mvPosition.xy += position.xy * vec2(sx, sy);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D map; uniform vec3 uTop; uniform vec3 uBottom; varying vec2 vUv;
      void main(){
        float a = texture2D(map, vUv).a;
        vec3 c = mix(uBottom, uTop, smoothstep(0.25, 0.62, vUv.y));
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  cloudMat.uniforms.map.value = puffTex;
  const cloudGeo = new THREE.PlaneGeometry(2.6, 2.6);
  const rockColA = C('#d8c7a6'), rockColB = C('#9c8a6e');
  const islandRockMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const islandTrees = [[], [], [], []];
  const islandBushes = [[], [], []];
  const waterfalls = [];
  function island(x, top, z, r, opts2 = {}) {
    const h = opts2.h || 46;
    const g = new THREE.CylinderGeometry(r, r * 0.42, h, 22, 14, false);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const a = Math.atan2(vz, vx);
      const n = noise3(Math.cos(a) * 1.6 + x, vy * 0.08, Math.sin(a) * 1.6 + z);
      const s = 1 + (n - 0.5) * 0.45;
      p.setXYZ(i, vx * s, vy, vz * s);
    }
    g.computeVertexNormals();
    g.translate(x, top - h / 2, z);
    colorize(g, (c, px, py, pz, ny) => {
      const band = 0.5 + 0.5 * Math.sin(py * 1.3 + noise3(px * 0.2, py * 0.2, pz * 0.2) * 4);
      c.copy(rockColB).lerp(rockColA, band * 0.7 + 0.15);
      if (ny > 0.6) c.set('#5f9c34');
      const depth = smoothstep(top - 30, top, py);
      c.multiplyScalar(0.7 + 0.3 * depth);
    });
    const m = new THREE.Mesh(g, islandRockMat);
    m.receiveShadow = true;
    m.castShadow = true;
    scene.add(m);
    const capG = blob(1, 3, 0.12, x * 0.1, 0.12);
    capG.scale(r * 1.03, 1, r * 1.03);
    capG.translate(x, top + 0.1, z);
    colorize(capG, (c, px, py, pz) => c.set('#6aae36').multiplyScalar(0.85 + 0.3 * noise3(px * 0.3, 0, pz * 0.3)));
    const cap = new THREE.Mesh(capG, vcMat);
    cap.receiveShadow = true;
    scene.add(cap);
    const nt = Math.round(r * (opts2.trees ?? 1.1));
    for (let i = 0; i < nt; i++) {
      const a = rr(0, 6.28), d = Math.sqrt(rand()) * r * 0.82;
      islandTrees[i % 4].push({ x: x + Math.cos(a) * d, y: top, z: z + Math.sin(a) * d, ry: rr(0, 6), s: rr(0.8, 1.6), c: rr(0.9, 1.15) });
    }
    for (let i = 0; i < Math.round(r * 0.8); i++) {
      const a = rr(0, 6.28), d = rr(0.6, 0.95) * r;
      islandBushes[i % 3].push({ x: x + Math.cos(a) * d, y: top, z: z + Math.sin(a) * d, ry: rr(0, 6), s: rr(0.8, 1.5) });
    }
    if (opts2.fall) {
      const a = opts2.fall;
      waterfalls.push({ x: x + Math.cos(a) * r * 0.97, y: top, z: z + Math.sin(a) * r * 0.97, a });
    }
  }
  const ISLANDS = [
    [-17, 1.5, -200, 10, { fall: 0.4 }], [17, 0, -207, 9, { fall: 2.2 }], [-11, 3.5, -238, 8], [17, 5, -246, 11, { fall: 1.9 }],
    [-23, 2, -268, 12, { fall: 0.9 }], [12, 6, -287, 7], [3, -7, -224, 6.5], [-6, -5, -260, 6],
    [-50, 8, -228, 16, { fall: 0.6 }], [56, 2, -262, 18], [-62, -2, -318, 22, { fall: 0.3 }], [42, 10, -340, 15],
    [0, 0, -365, 20, { fall: 1.6 }], [-32, 12, -402, 14], [72, 6, -410, 20], [-95, 4, -360, 24], [100, 9, -300, 18],
  ];
  ISLANDS.forEach(([x, t, z, r, o]) => island(x, t, z, r, o || {}));
  roundVariants.forEach((g, i) => scatter(g, vcMat, islandTrees[i]));
  bushVariants.forEach((g, i) => scatter(g, vcMat, islandBushes[i]));

  const fallMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv;
      float h(float n){ return fract(sin(n) * 43758.5453); }
      void main(){
        float col = floor(vUv.x * 22.0);
        float r = h(col * 13.1);
        float s = fract(vUv.y * (2.0 + r * 2.0) + uTime * (0.7 + r * 0.6) + r);
        float streak = smoothstep(0.0, 0.5, s);
        float edge = smoothstep(0.0, 0.32, vUv.x) * smoothstep(1.0, 0.68, vUv.x);
        float fadeB = smoothstep(0.0, 0.55, vUv.y);
        vec3 c = mix(vec3(0.72, 0.86, 0.95), vec3(1.0), streak);
        gl_FragColor = vec4(c, edge * fadeB * (0.55 + 0.35 * streak));
        #include <colorspace_fragment>
      }`,
  });
  waterfalls.forEach((w) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 34), fallMat);
    m.position.set(w.x, w.y - 17, w.z);
    m.rotation.y = -w.a + Math.PI / 2;
    scene.add(m);
  });

  // cloud sea + cloud clusters
  {
    const sea = [];
    for (let i = 0; i < (low ? 160 : 300); i++) {
      sea.push({ x: rr(-200, 200), y: rr(-18, -12), z: rr(-176, -520), s: rr(8, 16), sy: rr(0.55, 0.8) });
    }
    const clusters = [];
    const cluster = (cx, cy, cz, n, size) => {
      for (let i = 0; i < n; i++) clusters.push({ x: cx + rr(-1, 1) * size * 1.6, y: cy + rr(-0.4, 0.6) * size, z: cz + rr(-1, 1) * size, ry: rr(0, 6), s: rr(0.6, 1.1) * size, sy: 0.75 });
    };
    // between islands, kept off the flight line
    [[-30, 4, -215], [26, 8, -228], [-8, -2, -246], [30, 2, -275], [-40, 10, -290], [0, 18, -330], [-70, 14, -260], [70, 16, -300]].forEach(([x, y, z]) => cluster(x, y, z, 7, 5));
    // meadow sky
    [[-60, 34, -60], [40, 40, -90], [-20, 46, -150], [80, 30, -130], [-90, 38, -110]].forEach(([x, y, z]) => cluster(x, y, z, 6, 6));
    // the final cloud bank the camera flies into
    for (let i = 0; i < 46; i++) clusters.push({ x: rr(-26, 26), y: rr(6, 22), z: rr(-290, -330), ry: rr(0, 6), s: rr(5, 10), sy: 0.8 });
    const seaMesh = scatter(cloudGeo, cloudMat, sea, { cast: false });
    const clusterMesh = scatter(cloudGeo, cloudMat, clusters, { cast: false });
    seaMesh.frustumCulled = false;
    clusterMesh.frustumCulled = false;
  }
  // distant mountains
  {
    const list = [];
    for (let i = 0; i < 11; i++) list.push({ x: rr(-340, 340), y: -24, z: rr(-480, -580), ry: rr(0, 6), s: rr(40, 75), sy: rr(0.7, 1.15) });
    const g = new THREE.ConeGeometry(1, 1.6, 9, 8);
    g.translate(0, 0.8, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const s = 1 + (noise3(p.getX(i) * 2, p.getY(i) * 3, p.getZ(i) * 2) - 0.5) * 0.6;
      p.setXYZ(i, p.getX(i) * s, p.getY(i), p.getZ(i) * s);
    }
    g.computeVertexNormals();
    scatter(g, new THREE.MeshLambertMaterial({ color: '#c3d2e0' }), list, { cast: false });
  }

  // ---------- floating dust / fireflies ----------
  const DUST = low ? 300 : 650;
  const dustBase = new Float32Array(DUST * 3), dustPhase = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    const z = rr(6, -172);
    let dx = rr(-11, 11), y = rr(0.4, 6.5);
    if (Math.abs(dx) < 1.8 && Math.abs(y - 2.2) < 1.6) y = y < 2.2 ? 0.4 + rand() * 0.2 : 4.2 + rand() * 2;
    dustBase[i * 3] = pathX(z) + dx;
    dustBase[i * 3 + 1] = y;
    dustBase[i * 3 + 2] = z;
    dustPhase[i] = rr(0, 6.28);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustBase.slice(), 3));
  const dustMat = new THREE.PointsMaterial({ size: 0.12, map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,250,220,0.6)'], [1, 'rgba(255,255,255,0)']]), color: '#fff2c2', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4 });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);

  // ---------- per-frame state ----------
  const env = { top: new THREE.Color(), hor: new THREE.Color(), fog: new THREE.Color() };
  function envAt(z) {
    let a = ENV[0], b = ENV[0], t = 0;
    if (z <= ENV[ENV.length - 1].z) { a = b = ENV[ENV.length - 1]; }
    else for (let i = 1; i < ENV.length; i++) {
      if (z >= ENV[i].z) { a = ENV[i - 1]; b = ENV[i]; t = (z - a.z) / (b.z - a.z); break; }
    }
    t = t * t * (3 - 2 * t);
    const L = (k) => a[k] + (b[k] - a[k]) * t;
    env.top.lerpColors(a.top, b.top, t);
    env.hor.lerpColors(a.hor, b.hor, t);
    env.fog.lerpColors(a.fog, b.fog, t);
    env.near = L('near'); env.far = L('far'); env.hemi = L('hemi'); env.sun = L('sun');
    env.grass = L('grass'); env.dust = L('dust'); env.glow = L('glow');
    return env;
  }

  const startLook = new THREE.Vector3(0.2, 1.05, -7);
  const camPos = new THREE.Vector3(), look = new THREE.Vector3(), tmp = new THREE.Vector3(), flightPos = new THREE.Vector3();
  const flightQuat = new THREE.Quaternion(), mtx = new THREE.Matrix4(), bankQ = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
  const pointer = { x: 0, y: 0 };
  let time = 0;
  let camZ = CAMERA_PATH[0][2];

  function update(s, dt, ptr) {
    time += dt;
    s = clamp(s, 0, 1);
    if (ptr) {
      pointer.x += (ptr.x - pointer.x) * Math.min(1, dt * 3);
      pointer.y += (ptr.y - pointer.y) * Math.min(1, dt * 3);
    }
    // camera
    curve.getPointAt(s, camPos);
    camZ = camPos.z;
    camPos.x += pointer.x * 0.35;
    camPos.y += pointer.y * 0.18;
    curve.getPointAt(Math.min(s + 0.02, 1), look);
    look.y -= 0.3;
    const k0 = smoothstep(0, 0.035, s);
    look.lerpVectors(startLook, look, k0);
    camera.position.copy(camPos);
    camera.lookAt(look);

    // plane
    const pu = Math.min(s + 0.011, 1);
    curve.getPointAt(pu, flightPos);
    flightPos.y -= 0.42;
    flightPos.x += Math.sin(time * 0.9) * 0.22;
    flightPos.y += Math.sin(time * 1.3) * 0.1;
    curve.getTangentAt(pu, tmp);
    const ahead = curve.getTangentAt(Math.min(pu + 0.02, 1));
    const bank = clamp((ahead.x - tmp.x) * -14, -0.7, 0.7) + Math.sin(time * 0.9 + 1.2) * 0.12;
    // Matrix4.lookAt aims -Z at the target; the plane's nose is +Z, so look from the target side
    mtx.lookAt(tmp.clone().add(flightPos), flightPos, THREE.Object3D.DEFAULT_UP);
    flightQuat.setFromRotationMatrix(mtx);
    bankQ.setFromAxisAngle(zAxis, bank);
    flightQuat.multiply(bankQ);
    const k = smoothstep(0.002, 0.017, s);
    plane.position.lerpVectors(restPos, flightPos, k);
    plane.position.y += Math.sin(k * Math.PI) * 0.45;
    if (k === 0) plane.position.y += Math.max(0, Math.sin(time * 1.6)) * 0.006;
    plane.quaternion.slerpQuaternions(restQuat, flightQuat, smoothstep(0, 0.6, k));

    // environment
    const e = envAt(camZ);
    scene.fog.color.copy(e.fog);
    scene.fog.near = e.near;
    scene.fog.far = e.far;
    skyMat.uniforms.uTop.value.copy(e.top);
    skyMat.uniforms.uHor.value.copy(e.hor);
    sky.position.copy(camera.position);
    hemi.intensity = e.hemi;
    sun.intensity = e.sun;
    sun.position.set(camPos.x + 30, camPos.y + 48, camPos.z + 22);
    sun.target.position.set(camPos.x, camPos.y - 2, camPos.z - 18);
    grassUniforms.uTime.value = time;
    grassUniforms.uLight.value = e.grass;
    fallMat.uniforms.uTime.value = time;
    glowMat.opacity = e.glow * 0.75;
    // outside the tunnel its walls take the forest fog; inside they stay unfogged and dark
    const caveFog = camZ > CAVE_Z0 + 0.5;
    if (caveMat.fog !== caveFog) { caveMat.fog = caveFog; caveMat.needsUpdate = true; }
    shaftMat.opacity = 0.16 * smoothstep(-40, -64, camZ) * (1 - smoothstep(-122, -130, camZ));
    planeMat.emissiveIntensity = clamp(1 - e.hemi, 0, 0.6) * 0.8 + e.glow * 0.15;

    dustMat.opacity = e.dust * 0.75;
    if (e.dust > 0.01) {
      const p = dustGeo.attributes.position.array;
      for (let i = 0; i < DUST; i++) {
        const ph = dustPhase[i];
        p[i * 3] = dustBase[i * 3] + Math.sin(time * 0.4 + ph) * 0.6;
        p[i * 3 + 1] = dustBase[i * 3 + 1] + Math.sin(time * 0.7 + ph * 2) * 0.35;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }
  }

  function render() {
    renderer.render(scene, camera);
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 68 : 52;
    camera.updateProjectionMatrix();
  }
  resize();

  // drop render resolution on slow GPUs (called by main.js after measuring frame times)
  let degraded = 0;
  function degrade() {
    if (degraded >= 2) return false;
    degraded++;
    renderer.setPixelRatio(Math.max(0.7, renderer.getPixelRatio() * 0.72));
    resize();
    return true;
  }

  return {
    update, render, resize, degrade,
    get camZ() { return camZ; },
    renderer,
  };
}
