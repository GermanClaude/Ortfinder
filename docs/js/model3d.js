// The photo as a 3D model: terrain and OSM buildings around the standpoint, with the photo projected onto
// them from the camera – where the camera saw the surface (depth test), it carries the photo; everywhere
// else the aerial image. The model can be turned freely: seen from the camera it looks like the photo,
// from above it is the photo laid flat onto the map, and a flight from one to the other shows how the side
// view turns into the top view. Where the model is wrong (standpoint, direction, terrain), the photo
// visibly slides off roads, fields and roofs. Geometry is plain functions (tested in Node); the viewer
// loads three.js (vendored) only when it is opened.

import { castRays, drawImageryBox, mercatorBox } from "./groundview.js";
import { worldPixel } from "./mapview.js";
import { groundModel, loadScene, makeCamera } from "./scene3d.js";

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Ring radii from r0 to r1, spaced geometrically: fine near the camera, coarse far away. */
export function polarRadii(r0, r1, rings) {
  const k = Math.log(r1 / r0) / (rings - 1);
  return Float64Array.from({ length: rings }, (_, i) => r0 * Math.exp(k * i));
}

/**
 * Terrain mesh around the camera (three.js axes: x = east, y = up relative to the eye, z = −north).
 * groundZ(e, n, d) gives the height relative to the eye (curvature included, see scene3d.groundModel).
 * Returns positions, indices and each vertex's east/north metres (for the aerial texture).
 */
export function terrainGeometry({ groundZ, radius, rings = 150, segments = 360, r0 = 2 }) {
  const radii = polarRadii(r0, radius, rings);
  const count = 1 + rings * segments;
  const positions = new Float32Array(count * 3);
  const en = new Float32Array(count * 2);
  positions[1] = groundZ(0, 0, 1);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * 2 * Math.PI;
      const e = radii[i] * Math.sin(a);
      const n = radii[i] * Math.cos(a);
      const k = 1 + i * segments + j;
      const z = groundZ(e, n, radii[i]);
      positions[3 * k] = e;
      positions[3 * k + 1] = Number.isFinite(z) ? z : positions[1];
      positions[3 * k + 2] = -n;
      en[2 * k] = e;
      en[2 * k + 1] = n;
    }
  }
  const indices = new Uint32Array(3 * segments + 6 * segments * (rings - 1));
  let t = 0;
  // Counter-clockwise seen from above (three.js front faces), so the terrain faces up.
  for (let j = 0; j < segments; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % segments);
    indices[t++] = 0; indices[t++] = b; indices[t++] = a;
  }
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = 1 + i * segments + j;
      const b = 1 + i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
      indices[t++] = b; indices[t++] = d; indices[t++] = c;
    }
  }
  return { positions, indices, en, radii };
}

/** Fan triangulation (convex rings); the viewer passes three.js' ear clipping for real footprints. */
export const fanTriangles = (n) => Array.from({ length: Math.max(0, n - 2) }, (_, i) => [0, i + 1, i + 2]);

/**
 * OSM buildings as closed bodies: walls from the ground to the top, flat roofs. Walls get no aerial
 * coordinates (en = NaN → shown grey unless the photo covers them); roofs keep east/north for the aerial
 * image. triangulate(points [[x, y]…]) → [[i, j, k]…].
 */
export function buildingGeometry(buildings, g, { maxDistM = 800, triangulate = (pts) => fanTriangles(pts.length) } = {}) {
  const pos = [];
  const en = [];
  const idx = [];
  const vertex = (e, n, y, aerial) => {
    pos.push(e, y, -n);
    en.push(aerial ? e : NaN, aerial ? n : NaN);
    return pos.length / 3 - 1;
  };
  let count = 0;
  for (const b of buildings || []) {
    if (b.hidden || !b.ring?.length) continue;
    const ring = b.ring.map(([la, lo]) => g.proj.toXY(la, lo));
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const dist = Math.hypot(cx, cy);
    if (dist > maxDistM || dist < 3) continue;
    const base = g.groundZ(cx, cy, Math.max(dist, 1));
    const zb = base + (b.minHeight || 0);
    const zt = base + b.height;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const a = vertex(x1, y1, zb, false);
      const c = vertex(x2, y2, zb, false);
      const d = vertex(x2, y2, zt, false);
      const f = vertex(x1, y1, zt, false);
      // Both windings: footprints come in either orientation, and walls are seen from both sides.
      idx.push(a, c, d, a, d, f, a, d, c, a, f, d);
    }
    const first = pos.length / 3;
    for (const [x, y] of ring) vertex(x, y, zt, true);
    for (const [i, j, k] of triangulate(ring)) idx.push(first + i, first + j, first + k, first + i, first + k, first + j);
    count++;
  }
  return { positions: Float32Array.from(pos), en: Float32Array.from(en), indices: Uint32Array.from(idx), count };
}

/** The photo camera in three.js axes: forward and up vectors (roll included). */
export function cameraBasis({ bearingDeg, pitchDeg = 0, rollDeg = 0, fovDeg }) {
  const cam = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width: 2, height: 2 });
  const toThree = ([e, n, up]) => [e, up, -n];
  return { forward: toThree(cam.f), up: toThree(cam.u) };
}

/** Vertical field of view (degrees) for a horizontal one and an aspect ratio width/height. */
export const verticalFov = (hfovDeg, aspect) => (2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect)) / DEG;

/**
 * Where the photo shows ground, from a coarse ray cast: the model radius (just beyond the farthest ground
 * in the photo – the skyline –, 400 m – 20 km), the centre of the nearer 60 % of the visible ground (where
 * the views look at) and the size of that area (for the top view).
 */
export function viewExtent(rays) {
  const hits = [];
  for (let i = 0; i < rays.dist.length; i++) if (Number.isFinite(rays.dist[i])) hits.push(i);
  if (!hits.length) return { radius: 1500, center: [0, 0], span: 600, farthest: null };
  const d = hits.map((i) => rays.dist[i]).sort((a, b) => a - b);
  const far = d[d.length - 1];
  // The nearer 60 % of the ground: where the photo shows most detail (far slopes would shrink it in the top view).
  const p60 = d[Math.floor(d.length * 0.6)];
  const near = hits.filter((i) => rays.dist[i] <= p60);
  const ce = near.reduce((s, i) => s + rays.hx[i], 0) / near.length;
  const cn = near.reduce((s, i) => s + rays.hy[i], 0) / near.length;
  let span = 0;
  for (const i of near) span = Math.max(span, Math.abs(rays.hx[i] - ce), Math.abs(rays.hy[i] - cn));
  return { radius: clamp(far * 1.05, 400, 20000), center: [ce, cn], span: Math.max(2 * span, 150), farthest: far };
}

/** Aerial texture coordinates of vertices (east/north metres) inside a Mercator box; NaN stays NaN. */
export function aerialUv(en, g, box) {
  const uv = new Float32Array(en.length);
  for (let k = 0; k < en.length; k += 2) {
    if (!Number.isFinite(en[k])) {
      uv[k] = -1;
      uv[k + 1] = -1;
      continue;
    }
    const [la, lo] = g.proj.toLatLon(en[k], en[k + 1]);
    const p = worldPixel(la, lo, box.zoom);
    uv[k] = (p.x - box.x0) / box.width;
    uv[k + 1] = 1 - (p.y - box.y0) / box.height; // textures are flipped vertically on upload
  }
  return uv;
}

// ---------- browser ----------

function photoCanvas(bitmap, maxSide = 4096) {
  const bw = bitmap.naturalWidth || bitmap.width;
  const bh = bitmap.naturalHeight || bitmap.height;
  const s = Math.min(1, maxSide / Math.max(bw, bh));
  const c = document.createElement("canvas");
  c.width = Math.round(bw * s);
  c.height = Math.round(bh * s);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

async function aerialCanvas(g, halfM, maxSide) {
  const corners = [[-halfM, -halfM], [halfM, halfM], [-halfM, halfM], [halfM, -halfM]].map(([e, n]) => g.proj.toLatLon(e, n));
  const box = mercatorBox(corners, maxSide);
  const c = document.createElement("canvas");
  c.width = box.width;
  c.height = box.height;
  const ctx = c.getContext("2d");
  // Left transparent where a tile is missing: the viewer then falls back to the coarser image.
  const tiles = await drawImageryBox(ctx, box, undefined, 64).catch(() => 0);
  return { canvas: c, box, tiles };
}

/**
 * Browser: everything the viewer needs – terrain and building meshes, aerial textures (near and far),
 * the photo and the pose. pose: { lat, lon, bearingDeg, fovDeg, pitchDeg, rollDeg, eyeHeight }.
 */
export async function buildPhotoModel({ bitmap, terrain, osm, pose, onStatus = () => {} }) {
  const { lat, lon, bearingDeg, fovDeg, pitchDeg = 0, rollDeg = 0, eyeHeight = 1.6 } = pose;
  onStatus("Gelände laden …");
  await terrain.prefetchView(lat, lon, bearingDeg, Math.min(fovDeg + 30, 360), 30000).catch(() => {});
  const bw = bitmap.naturalWidth || bitmap.width;
  const bh = bitmap.naturalHeight || bitmap.height;
  const aspect = bw / bh;
  let g = groundModel({ lat, lon, eyeHeight, terrain });
  const small = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width: 160, height: Math.round(160 / aspect) });
  const extent = viewExtent(castRays({ cam: small, g, maxDistM: 30000 }));
  const R = extent.radius;
  // All round (for turning the model), fine near the camera.
  const deg = (m) => m / 111195;
  const box = (m) => [lat - deg(m), lon - deg(m) / Math.cos(lat * DEG), lat + deg(m), lon + deg(m) / Math.cos(lat * DEG)];
  await Promise.all([terrain.prefetchBox(...box(Math.min(R, 1500)), 14), terrain.prefetchBox(...box(Math.min(R, 12000)), 12)]).catch(() => {});
  g = groundModel({ lat, lon, eyeHeight, terrain });
  onStatus("Gebäude und Luftbild laden …");
  const [scene, outer, inner] = await Promise.all([
    loadScene(osm, lat, lon, Math.min(R, 700)).catch(() => null),
    aerialCanvas(g, R, 2048),
    aerialCanvas(g, Math.min(R, 600), 2048),
  ]);
  onStatus("3D-Modell aufbauen …");
  const ground = terrainGeometry({ groundZ: g.groundZ, radius: R, rings: R > 3000 ? 190 : 140, segments: 360 });
  return {
    pose: { lat, lon, bearingDeg, fovDeg, pitchDeg, rollDeg, eyeHeight }, aspect, radius: R, center: extent.center, span: extent.span, g,
    ground, scene, outer, inner, photo: photoCanvas(bitmap), groundAt: (e, n) => g.groundZ(e, n, Math.max(1, Math.hypot(e, n))),
  };
}

const VERT = `
attribute vec2 uvOuter;
attribute vec2 uvInner;
varying vec3 vWorld;
varying vec2 vOuter;
varying vec2 vInner;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vOuter = uvOuter;
  vInner = uvInner;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = `
uniform sampler2D photo;
uniform sampler2D photoDepth;
uniform sampler2D aerialOuter;
uniform sampler2D aerialInner;
uniform mat4 photoView;
uniform mat4 photoProj;
uniform float photoNear;
uniform float photoFar;
uniform float photoOpacity;
uniform float aerialOn;
varying vec3 vWorld;
varying vec2 vOuter;
varying vec2 vInner;
float viewDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * photoNear * photoFar / (photoFar + photoNear - z * (photoFar - photoNear));
}
void main() {
  vec3 base = vec3(0.72, 0.72, 0.70);
  if (vOuter.x >= 0.0) {
    vec4 outer = texture2D(aerialOuter, vOuter);
    base = aerialOn > 0.5 && outer.a > 0.5 ? outer.rgb : vec3(0.55, 0.6, 0.5);
    if (aerialOn > 0.5 && vInner.x >= 0.0 && vInner.x <= 1.0 && vInner.y >= 0.0 && vInner.y <= 1.0) {
      vec4 inner = texture2D(aerialInner, vInner);
      if (inner.a > 0.5) base = inner.rgb;
    }
  }
  vec4 pv = photoView * vec4(vWorld, 1.0);
  vec4 clip = photoProj * pv;
  float seen = 0.0;
  vec2 uv = vec2(0.0);
  if (clip.w > 0.0) {
    uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
      float front = viewDepth(texture2D(photoDepth, uv).x);
      // Visible from the camera: not behind what the camera saw at that pixel. The tolerance grows with
      // distance – at grazing angles one depth pixel covers a long stretch of ground.
      if (-pv.z <= front * 1.025 + 3.0) seen = 1.0;
    }
  }
  vec3 color = mix(base, texture2D(photo, uv).rgb, seen * photoOpacity);
  gl_FragColor = vec4(color, 1.0);
}`;

/**
 * Browser: the interactive viewer in `container`. Buttons: as the photo, oblique, top view, the flight
 * from side view to top view; photo overlay strength, buildings, aerial image. Returns { dispose, show(view) }.
 */
export async function openModelViewer(container, model, { labels = {} } = {}) {
  const THREE = await import("../vendor/three.bundle.mjs");
  const { pose, aspect, radius: R } = model;
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "model3d-canvas";
  canvasWrap.style.aspectRatio = `${aspect}`;
  canvasWrap.style.width = `min(100%, ${Math.round(75 * aspect)}vh)`; // tall photos: at most 3/4 of the screen high
  container.append(canvasWrap);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvasWrap.append(renderer.domElement);
  const size = () => {
    const w = canvasWrap.clientWidth || 600;
    const h = Math.round(w / aspect);
    renderer.setSize(w, h, true);
    return [w, h];
  };
  let [cw, ch] = size();

  const texture = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.minFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfd4ea);

  // The photo camera: at the eye (origin), looking and rolled as fitted.
  const vfov = verticalFov(pose.fovDeg, aspect);
  const { forward, up } = cameraBasis(pose);
  const photoCam = new THREE.PerspectiveCamera(vfov, aspect, 0.5, R * 3);
  photoCam.position.set(0, 0, 0);
  photoCam.up.set(...up);
  photoCam.lookAt(...forward);
  photoCam.updateMatrixWorld(true);

  const geometry = (positions, indices, uvOuter, uvInner) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uvOuter", new THREE.BufferAttribute(uvOuter, 2));
    geo.setAttribute("uvInner", new THREE.BufferAttribute(uvInner, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
  };
  const g = model.g;
  const groundGeo = geometry(model.ground.positions, model.ground.indices, aerialUv(model.ground.en, g, model.outer.box), aerialUv(model.ground.en, g, model.inner.box));
  const triangulate = (pts) => THREE.ShapeUtils.triangulateShape(pts.map(([x, y]) => new THREE.Vector2(x, y)), []);
  const bld = buildingGeometry(model.scene?.buildings, g, { triangulate });
  const bldGeo = bld.count ? geometry(bld.positions, bld.indices, aerialUv(bld.en, g, model.outer.box), aerialUv(bld.en, g, model.inner.box)) : null;

  // Depth of what the camera saw, per photo pixel: decides where the photo may be painted.
  const dh = Math.min(2048, Math.round(2048 / Math.max(aspect, 1)));
  const dw = Math.round(dh * aspect);
  const depthTarget = new THREE.WebGLRenderTarget(dw, dh);
  depthTarget.depthTexture = new THREE.DepthTexture(dw, dh, THREE.UnsignedIntType);
  const uniforms = {
    photo: { value: texture(model.photo) },
    photoDepth: { value: depthTarget.depthTexture },
    aerialOuter: { value: texture(model.outer.canvas) },
    aerialInner: { value: texture(model.inner.canvas) },
    photoView: { value: photoCam.matrixWorldInverse.clone() },
    photoProj: { value: photoCam.projectionMatrix.clone() },
    photoNear: { value: photoCam.near },
    photoFar: { value: photoCam.far },
    photoOpacity: { value: 1 },
    aerialOn: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: 2 });
  const groundMesh = new THREE.Mesh(groundGeo, material);
  scene.add(groundMesh);
  const bldMesh = bldGeo ? new THREE.Mesh(bldGeo, material) : null;
  if (bldMesh) scene.add(bldMesh);

  const depthScene = new THREE.Scene();
  const plain = new THREE.MeshBasicMaterial({ side: 2 });
  depthScene.add(new THREE.Mesh(groundGeo, plain));
  if (bldGeo) depthScene.add(new THREE.Mesh(bldGeo, plain));
  const renderDepth = () => {
    renderer.setRenderTarget(depthTarget);
    renderer.render(depthScene, photoCam);
    renderer.setRenderTarget(null);
  };
  renderDepth();

  // The camera as a small pyramid, so it can be found in the top view.
  const size3 = Math.max(4, R * 0.015);
  const hh = Math.tan((vfov * DEG) / 2);
  const hw = hh * aspect;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x * size3, y * size3, -size3).applyMatrix4(photoCam.matrixWorld));
  const o = new THREE.Vector3(0, 0, 0);
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(o, corners[i], corners[i], corners[(i + 1) % 4]);
  const frustum = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lines), new THREE.LineBasicMaterial({ color: 0xff1744 }));
  scene.add(frustum);

  const view = new THREE.PerspectiveCamera(vfov, aspect, 0.5, R * 6);
  const { OrbitControls } = THREE;
  const controls = new OrbitControls(view, renderer.domElement);
  controls.enableDamping = false;
  const [ce, cn] = model.center;
  const target = new THREE.Vector3(ce, model.groundAt(ce, cn), -cn);
  const render = () => renderer.render(scene, view);
  controls.addEventListener("change", render);

  const poses = {
    photo: () => ({ pos: new THREE.Vector3(0, 0, 0), look: new THREE.Vector3(...forward), up: new THREE.Vector3(...up), fov: vfov }),
    oblique: () => {
      const f = new THREE.Vector3(forward[0], 0, forward[2]).normalize();
      const dist = Math.max(target.length(), 150);
      return { pos: target.clone().addScaledVector(f, -dist * 0.9).add(new THREE.Vector3(0, dist * 0.8, 0)), look: target.clone(), up: new THREE.Vector3(0, 1, 0), fov: 50 };
    },
    top: () => {
      // The photographed ground (and the camera) in the frame; a hair south of straight above, so north is up.
      const span = clamp(Math.max(model.span * 1.15, target.length() * 2.2), 200, R * 1.2);
      const height = span / (2 * Math.tan(25 * DEG));
      return { pos: new THREE.Vector3(target.x, target.y + height, target.z + height * 0.0005), look: target.clone(), up: new THREE.Vector3(0, 1, 0), fov: 50 };
    },
  };
  const apply = (p) => {
    view.position.copy(p.pos);
    view.up.copy(p.up);
    view.fov = p.fov;
    view.lookAt(p.look);
    view.updateProjectionMatrix();
  };
  let anim = 0;
  let flight = 0; // a running flight is stopped by any other view or by the user grabbing the model
  const stopFlight = () => {
    flight++;
    cancelAnimationFrame(anim);
  };
  controls.addEventListener("start", stopFlight);
  const show = (name) => {
    stopFlight();
    apply(poses[name]());
    // Orbiting turns around the visible ground; from the camera view around the point looked at.
    controls.target.copy(name === "photo" ? new THREE.Vector3(...forward).multiplyScalar(Math.max(target.length(), 50)) : target);
    if (name === "photo") view.lookAt(...forward);
    view.up.set(0, 1, 0);
    if (name !== "photo") controls.update();
    render();
  };
  /** The flight from side view (photo) to top view: position along an arc, orientation slerped. */
  const fly = (from = "photo", to = "top", ms = 3200) => {
    stopFlight();
    const mine = flight;
    const a = poses[from]();
    const b = poses[to]();
    apply(a);
    const qa = view.quaternion.clone();
    apply(b);
    const qb = view.quaternion.clone();
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        if (mine !== flight) return resolve();
        const t = clamp((now - t0) / ms, 0, 1);
        const s = t * t * (3 - 2 * t);
        view.position.lerpVectors(a.pos, b.pos, s);
        view.position.y += Math.sin(Math.PI * s) * (b.pos.y - a.pos.y) * 0.15;
        view.quaternion.slerpQuaternions(qa, qb, s);
        view.fov = a.fov + (b.fov - a.fov) * s;
        view.updateProjectionMatrix();
        render();
        if (t < 1) {
          anim = requestAnimationFrame(step);
        } else {
          view.up.set(0, 1, 0);
          controls.target.copy(target);
          controls.update();
          render();
          resolve();
        }
      };
      anim = requestAnimationFrame(step);
    });
  };
  const onResize = () => {
    [cw, ch] = size();
    view.aspect = cw / ch;
    view.updateProjectionMatrix();
    render();
  };
  window.addEventListener("resize", onResize);
  show("photo");
  return {
    show, fly, render,
    set photoOpacity(v) { uniforms.photoOpacity.value = v; render(); },
    set buildings(on) { if (bldMesh) bldMesh.visible = on; render(); },
    set aerial(on) { uniforms.aerialOn.value = on ? 1 : 0; render(); },
    stats: { radius_m: Math.round(R), buildings: bld.count, vertices: model.ground.positions.length / 3, aerial_tiles: model.outer.tiles + model.inner.tiles },
    canvas: renderer.domElement,
    dispose() {
      cancelAnimationFrame(anim);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      depthTarget.dispose();
    },
    labels,
  };
}
