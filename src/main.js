import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PRESETS, lightDirection, createEnvironmentCache } from './lighting.js';
import { loadReel, openReel } from './reel.js';
import { supabase, isConfigured, publicUrl, MODELS_BUCKET, REELS_BUCKET } from './supabase.js';

const MOBILE_QUERY = window.matchMedia('(max-width: 760px)');

// ---------- Renderer / scene / camera ----------
const container = document.getElementById('viewer');
// alpha: the "Gradient" background is the CSS backdrop of #viewer showing through the canvas.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const getEnvironment = createEnvironmentCache(renderer);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 1000);
camera.position.set(3, 2, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---------- Lights ----------
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.bias = -0.0005; // normalBias is scaled per model in frameModel()
scene.add(dirLight);

// ---------- Grid & ground ----------
const grid = new THREE.GridHelper(10, 20, 0xffffff, 0xffffff);
grid.material.transparent = true;
grid.material.opacity = 0.12;
grid.material.depthWrite = false;
grid.position.y = 0.001;
scene.add(grid);

// Shadow catcher: shows only the shadow, so it sits naturally on any background.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
ground.rotation.x = -Math.PI / 2;
ground.scale.set(10, 10, 1);
ground.receiveShadow = true;
scene.add(ground);

// ---------- Loaders ----------
// three r187+ resolves Draco/Basis decoders via import.meta.url, so Vite bundles them
// into dist/ automatically — no decoder path or CDN needed.
const draco = new DRACOLoader();
const ktx2 = new KTX2Loader().detectSupport(renderer);
const loader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder);

// ---------- State ----------
let model = null;
let mixer = null;
let surfaceMode = 'textured'; // 'textured' | 'clay' | 'normals' | null (wireframe only)
let showWire = false; // wireframe on its own, or as an overlay on the surface mode
let loadId = 0;
let sceneScale = 1; // largest model dimension; lights, grid and shadows scale with it
const originalMaterials = new Map(); // mesh -> original material (or array)
const overrideCache = new Map(); // original material -> { wireframe, clay, normals }
const modelStats = { meshes: 0, vertices: 0, triangles: 0, materials: 0, fileSize: 0 };
const loadingEl = document.getElementById('loading');
const dropEl = document.getElementById('drop');
const modelNameEl = document.getElementById('modelName');

const look = {
  preset: 'studio',
  az: 45,
  el: 55,
  background: 'gradient', // 'gradient' | 'solid' | 'environment'
  bgTop: '#3b404b',
  bgBottom: '#14161a',
  bgSolid: '#22252c',
  bgBlur: 0.5
};

// ---------- Loading ----------
/** Full-screen message, shown only while no model is on screen. */
function showEmpty(title, hint = '') {
  document.getElementById('dropTitle').textContent = title;
  document.getElementById('dropHint').textContent = hint;
  dropEl.classList.remove('hidden');
}

/** Single entry point for loading any model URL. Resolves true when the model is shown. */
async function loadModel(url, fileSize = 0, name = '') {
  const id = ++loadId;
  loadingEl.style.display = 'block';
  try {
    const gltf = await loader.loadAsync(url);
    if (id !== loadId) {
      disposeObject(gltf.scene); // a newer load superseded this one
      return false;
    }
    setModel(gltf, fileSize);
    modelNameEl.textContent = name.replace(/\.glb$/i, '');
    return true;
  } catch (err) {
    if (id !== loadId) return false;
    console.error(err);
    showEmpty('This model couldn’t be loaded', 'Refresh the page, or go back to all models.');
    return false;
  } finally {
    if (id === loadId) loadingEl.style.display = 'none';
  }
}

// ---------- Disposal ----------
function disposeObject(root) {
  const materials = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    if (o.isSkinnedMesh) o.skeleton.dispose();
    [o.material].flat().forEach((m) => m && materials.add(m));
  });
  materials.forEach((m) => {
    for (const key in m) if (m[key]?.isTexture) m[key].dispose();
    m.dispose();
  });
}

function clearModel() {
  if (!model) return;
  if (mixer) {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    mixer = null;
  }
  scene.remove(model);
  model.traverse((o) => {
    if (o.isMesh) o.material = originalMaterials.get(o);
  });
  disposeObject(model);
  // Override materials share textures with the originals (already disposed) — dispose materials only.
  overrideCache.forEach((set) => Object.values(set).forEach((m) => m.dispose()));
  overrideCache.clear();
  originalMaterials.clear();
  model = null;
}

// ---------- Model setup ----------
function setModel(gltf, fileSize) {
  clearModel();
  model = gltf.scene;

  const materialSet = new Set();
  Object.assign(modelStats, { meshes: 0, vertices: 0, triangles: 0, materials: 0, fileSize });

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    originalMaterials.set(o, o.material);
    [o.material].flat().forEach((m) => materialSet.add(m));

    const instances = o.isInstancedMesh ? o.count : 1;
    const pos = o.geometry.attributes.position;
    const indexCount = o.geometry.index ? o.geometry.index.count : pos.count;
    modelStats.meshes++;
    modelStats.vertices += pos.count * instances;
    modelStats.triangles += (indexCount / 3) * instances;
  });
  modelStats.materials = materialSet.size;

  scene.add(model);
  frameModel(model);
  applyViewMode();

  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(gltf.animations[0]).play();
  }
  dropEl.classList.add('hidden');
}

function frameModel(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  sceneScale = maxDim;
  const dist = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.5;
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  camera.position.set(dist * 0.7, size.y * 0.5 + dist * 0.4, dist * 0.7);
  controls.target.set(0, size.y / 2, 0);
  controls.update();

  const g = maxDim * 4;
  grid.scale.setScalar(g / 10);
  grid.position.y = maxDim * 0.002; // scale offset with the model to avoid z-fighting
  ground.scale.set(g, g, 1);

  dirLight.shadow.normalBias = maxDim * 0.003; // ~1.5 shadow-map texels
  const sc = dirLight.shadow.camera;
  sc.left = -g / 2;
  sc.right = g / 2;
  sc.top = g / 2;
  sc.bottom = -g / 2;
  sc.near = 0.01;
  sc.far = maxDim * 12;
  sc.updateProjectionMatrix();
  placeKeyLight();
}

/** Positions the key light from the dial's direction/height, at a distance that scales with the model. */
function placeKeyLight() {
  lightDirection(look.az, look.el, dirLight.position).multiplyScalar(sceneScale * 5);
}

// ---------- View modes ----------
// Replaces the base-colour map chunk so Clay samples only the texture's alpha (keeps cut-outs).
const ALPHA_ONLY_MAP = /* glsl */ `
#ifdef USE_MAP
  diffuseColor.a *= texture2D( map, vMapUv ).a;
#endif`;

function makeOverrides(orig) {
  const side = orig.side;
  const clay = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.8, side });

  const alphaTest = orig.alphaTest || (orig.transparent && orig.map ? 0.5 : 0);
  if (orig.map && alphaTest > 0) {
    clay.map = orig.map;
    clay.alphaTest = alphaTest;
    clay.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', ALPHA_ONLY_MAP);
    };
    clay.customProgramCacheKey = () => 'clay-alpha-only';
  }

  return {
    wireframe: new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true, side, toneMapped: false }),
    clay,
    normals: new THREE.MeshNormalMaterial({ side })
  };
}

function overridesFor(m) {
  let set = overrideCache.get(m);
  if (!set) {
    set = makeOverrides(m);
    overrideCache.set(m, set);
  }
  return set;
}

/** Puts the surface material on every mesh (or the wireframe material when no surface is selected). */
function applyViewMode() {
  if (!model) return;
  const mode = surfaceMode ?? 'wireframe';
  model.traverse((o) => {
    if (!o.isMesh) return;
    const orig = originalMaterials.get(o);
    if (mode === 'textured') {
      o.material = orig;
      return;
    }
    o.material = Array.isArray(orig) ? orig.map((m) => overridesFor(m)[mode]) : overridesFor(orig)[mode];
  });
}

// Wireframe drawn over a surface mode in a second render pass (see render()).
// Lines are pulled slightly towards the camera so they win the depth test against
// the triangles they sit on.
const wireOverlay = new THREE.MeshBasicMaterial({
  color: 0x4fc3f7,
  wireframe: true,
  side: THREE.DoubleSide,
  toneMapped: false
});
wireOverlay.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n  gl_Position.z -= 0.0005 * gl_Position.w;'
  );
};
wireOverlay.customProgramCacheKey = () => 'wire-overlay';

// ---------- Lighting & background ----------
const $ = (id) => document.getElementById(id);
const ui = {
  keyColor: $('keyColor'),
  keyIntensity: $('keyIntensity'),
  shadows: $('shadows'),
  exposure: $('exposure'),
  envIntensity: $('envIntensity'),
  bgTop: $('bgTop'),
  bgBottom: $('bgBottom'),
  bgSolid: $('bgSolid'),
  bgBlur: $('bgBlur'),
  autoRotate: $('autoRotate'),
  rotateSpeed: $('rotateSpeed')
};
const outputs = {
  keyIntensity: [$('keyIntensityOut'), 1],
  exposure: [$('exposureOut'), 2],
  envIntensity: [$('envIntensityOut'), 2],
  bgBlur: [$('bgBlurOut'), 2],
  rotateSpeed: [$('rotateSpeedOut'), 1]
};
function showValue(name) {
  const [el, digits] = outputs[name];
  el.value = Number(ui[name].value).toFixed(digits);
}

function applyBackground() {
  const mode = look.background;
  if (mode === 'gradient') {
    scene.background = null;
    container.style.setProperty('--bg-top', look.bgTop);
    container.style.setProperty('--bg-bottom', look.bgBottom);
  } else if (mode === 'solid') {
    scene.background = new THREE.Color(look.bgSolid);
  } else {
    scene.background = scene.environment;
    scene.backgroundBlurriness = look.bgBlur;
  }
  document.querySelectorAll('[data-bg]').forEach((b) => b.classList.toggle('active', b.dataset.bg === mode));
  document.querySelectorAll('.bg-options').forEach((el) => (el.hidden = el.dataset.for !== mode));
}

function applyPreset(name) {
  const p = PRESETS[name];
  look.preset = name;
  look.az = p.key.az;
  look.el = p.key.el;
  look.bgTop = p.backdrop.top;
  look.bgBottom = p.backdrop.bottom;
  look.bgSolid = p.backdrop.solid;

  scene.environment = getEnvironment(name);
  scene.environmentIntensity = p.envIntensity;
  renderer.toneMappingExposure = p.exposure;
  dirLight.color.set(p.key.color);
  dirLight.intensity = p.key.intensity;
  hemiLight.color.set(p.fill.sky);
  hemiLight.groundColor.set(p.fill.ground);
  hemiLight.intensity = p.fill.intensity;
  placeKeyLight();

  // Sync the panel to the preset's values.
  ui.keyColor.value = p.key.color;
  ui.keyIntensity.value = p.key.intensity;
  ui.exposure.value = p.exposure;
  ui.envIntensity.value = p.envIntensity;
  ui.bgTop.value = look.bgTop;
  ui.bgBottom.value = look.bgBottom;
  ui.bgSolid.value = look.bgSolid;
  ['keyIntensity', 'exposure', 'envIntensity'].forEach(showValue);
  updateDial();
  applyBackground();
  markPreset(name);
}

/** Highlights the active preset; any manual lighting change clears the highlight. */
function markPreset(name) {
  look.preset = name;
  document.querySelectorAll('.preset').forEach((b) => {
    const on = b.dataset.preset === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}

const presetsEl = $('presets');
Object.entries(PRESETS).forEach(([name, p]) => {
  const btn = document.createElement('button');
  btn.className = 'preset';
  btn.dataset.preset = name;
  btn.innerHTML = `<span class="preset-swatch"></span><span>${p.label}</span>`;
  btn.firstElementChild.style.background = `radial-gradient(circle at 35% 30%, ${p.key.color}, ${p.backdrop.top} 55%, ${p.backdrop.bottom})`;
  btn.addEventListener('click', () => applyPreset(name));
  presetsEl.append(btn);
});

ui.keyColor.addEventListener('input', () => {
  dirLight.color.set(ui.keyColor.value);
  markPreset(null);
});
ui.keyIntensity.addEventListener('input', () => {
  dirLight.intensity = Number(ui.keyIntensity.value);
  showValue('keyIntensity');
  markPreset(null);
});
ui.exposure.addEventListener('input', () => {
  renderer.toneMappingExposure = Number(ui.exposure.value);
  showValue('exposure');
  markPreset(null);
});
ui.envIntensity.addEventListener('input', () => {
  scene.environmentIntensity = Number(ui.envIntensity.value);
  showValue('envIntensity');
  markPreset(null);
});
ui.shadows.addEventListener('change', () => (dirLight.castShadow = ui.shadows.checked));

document.querySelectorAll('[data-bg]').forEach((b) =>
  b.addEventListener('click', () => {
    look.background = b.dataset.bg;
    applyBackground();
  })
);
['bgTop', 'bgBottom', 'bgSolid'].forEach((key) =>
  ui[key].addEventListener('input', () => {
    look[key] = ui[key].value;
    applyBackground();
  })
);
ui.bgBlur.addEventListener('input', () => {
  look.bgBlur = Number(ui.bgBlur.value);
  showValue('bgBlur');
  applyBackground();
});

// ---------- Light dial ----------
// Top-down view of the scene: angle = direction around the model, distance from centre = height
// (centre = straight overhead, edge = on the horizon).
const MIN_EL = 5;
const dial = $('dial');
const dialKnob = $('dialKnob');

function updateDial() {
  const r = ((90 - look.el) / (90 - MIN_EL)) * 0.42; // fraction of dial size
  const a = THREE.MathUtils.degToRad(look.az);
  dialKnob.style.transform = `translate(${Math.cos(a) * r * dial.offsetWidth}px, ${Math.sin(a) * r * dial.offsetWidth}px)`;
  const az = Math.round(look.az);
  const el = Math.round(look.el);
  $('azOut').textContent = `${az}°`;
  $('elOut').textContent = `${el}°`;
  dial.setAttribute('aria-valuetext', `Direction ${az} degrees, height ${el} degrees`);
}

function setLightAngles(az, el) {
  look.az = ((az % 360) + 360) % 360;
  look.el = THREE.MathUtils.clamp(el, MIN_EL, 90);
  placeKeyLight();
  updateDial();
  markPreset(null);
}

function dialFromPointer(e) {
  const rect = dial.getBoundingClientRect();
  const x = e.clientX - (rect.left + rect.width / 2);
  const y = e.clientY - (rect.top + rect.height / 2);
  const r = Math.min(Math.hypot(x, y) / (rect.width * 0.42), 1);
  setLightAngles(THREE.MathUtils.radToDeg(Math.atan2(y, x)), 90 - r * (90 - MIN_EL));
}
dial.addEventListener('pointerdown', (e) => {
  dial.setPointerCapture(e.pointerId);
  dialFromPointer(e);
});
dial.addEventListener('pointermove', (e) => {
  if (dial.hasPointerCapture(e.pointerId)) dialFromPointer(e);
});
dial.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 15 : 5;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const m = moves[e.key];
  if (!m) return;
  e.preventDefault();
  setLightAngles(look.az + m[0], look.el + m[1]);
});

// ---------- Turntable ----------
ui.autoRotate.addEventListener('change', () => {
  controls.autoRotate = ui.autoRotate.checked;
  $('rotateSpeedRow').hidden = !ui.autoRotate.checked;
});
ui.rotateSpeed.addEventListener('input', () => {
  controls.autoRotateSpeed = Number(ui.rotateSpeed.value);
  showValue('rotateSpeed');
});
controls.autoRotateSpeed = Number(ui.rotateSpeed.value);

// ---------- UI wiring ----------
// Textured / Clay / Normals pick the surface (only one at a time). Wireframe toggles on its
// own and overlays the surface. At least one of the two is always on.
const modeButtons = document.querySelectorAll('[data-mode]');
modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === 'wireframe') {
      if (showWire && !surfaceMode) return;
      showWire = !showWire;
    } else if (surfaceMode === mode) {
      if (!showWire) return;
      surfaceMode = null;
    } else {
      surfaceMode = mode;
    }
    modeButtons.forEach((b) => {
      const m = b.dataset.mode;
      const on = m === 'wireframe' ? showWire : m === surfaceMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    applyViewMode();
  });
});
modeButtons.forEach((b) => b.setAttribute('aria-pressed', b.classList.contains('active')));

const perfEl = $('perf');
document.querySelectorAll('[data-toggle]').forEach((input) => {
  input.addEventListener('change', () => {
    const on = input.checked;
    if (input.dataset.toggle === 'grid') grid.visible = on;
    if (input.dataset.toggle === 'ground') ground.visible = on;
    if (input.dataset.toggle === 'perf') {
      perfEl.classList.toggle('show', on);
      if (on) updatePerf();
    }
  });
});

// Side panel: open by default on desktop, closed on phones.
const panel = $('panel');
const panelBtn = $('panelBtn');
function setPanel(open) {
  panel.classList.toggle('closed', !open);
  panel.inert = !open;
  panelBtn.setAttribute('aria-expanded', open);
  updateViewOffset();
}
panelBtn.addEventListener('click', () => setPanel(panel.classList.contains('closed')));

$('reelBtn').addEventListener('click', openReel);

// The public site is view-only: stop the browser opening files dropped on the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/** On desktop, shift the rendered view left so the model is centred in the area beside the open panel. */
function updateViewOffset() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  const shift = !MOBILE_QUERY.matches && !panel.classList.contains('closed') ? (panel.offsetWidth + 14) / 2 : 0;
  if (shift) camera.setViewOffset(w, h, shift, 0, w, h);
  else camera.clearViewOffset();
}

new ResizeObserver(() => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  updateViewOffset(); // also updates the projection matrix
  renderer.setSize(w, h);
}).observe(container);

// ---------- Performance panel ----------
let frames = 0;
let lastTime = performance.now();
let fps = 0;
const fmt = (n) => Math.round(n).toLocaleString();

function updatePerf() {
  const info = renderer.info;
  const rows = [
    ['FPS', fps],
    ['Draw calls', fmt(info.render.calls)],
    ['Rendered triangles', fmt(info.render.triangles)],
    ['Geometries (GPU)', info.memory.geometries],
    ['Textures (GPU)', info.memory.textures],
    null,
    ['Meshes', fmt(modelStats.meshes)],
    ['Vertices', fmt(modelStats.vertices)],
    ['Triangles', fmt(modelStats.triangles)],
    ['Materials', modelStats.materials],
    ['File size', modelStats.fileSize ? (modelStats.fileSize / 1048576).toFixed(2) + ' MB' : '-']
  ];
  perfEl.innerHTML = rows
    .map((r) => (r ? `<div class="row"><span>${r[0]}</span><span class="val">${r[1]}</span></div>` : '<div class="sep"></div>'))
    .join('');
}

// ---------- Render loop ----------
renderer.info.autoReset = false; // reset once per frame so perf stats include both passes

function render() {
  renderer.info.reset();
  renderer.render(scene, camera);
  if (!model || !showWire || !surfaceMode) return;

  // Overlay pass: draw only the model with the wireframe material, keeping pass 1's colour
  // and depth. Hide helpers, skip the background, and don't redraw the shadow map.
  const gridVisible = grid.visible;
  const groundVisible = ground.visible;
  const background = scene.background;
  grid.visible = false;
  ground.visible = false;
  scene.background = null;
  scene.overrideMaterial = wireOverlay;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;

  renderer.render(scene, camera);

  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = true;
  scene.overrideMaterial = null;
  scene.background = background;
  grid.visible = gridVisible;
  ground.visible = groundVisible;
}

// ---------- Content from Supabase ----------
/** The viewer shows the model named in ?model=<id>; the list lives on the home page. */
async function loadContent() {
  if (!isConfigured) {
    showEmpty('Viewer not configured', 'Supabase URL and key are missing.');
    return;
  }
  const id = new URLSearchParams(location.search).get('model');
  if (!id) {
    location.replace('/');
    return;
  }

  loadingEl.style.display = 'block';
  const [modelRes, reelRes] = await Promise.all([
    supabase.from('models').select('name, path, size_bytes').eq('id', id).maybeSingle(),
    supabase.from('reels').select('name, path').order('created_at', { ascending: false }).limit(1),
  ]);
  loadingEl.style.display = 'none';

  if (reelRes.error) console.error(reelRes.error);
  const reel = reelRes.data?.[0];
  if (reel) {
    loadReel(publicUrl(REELS_BUCKET, reel.path), reel.name);
    $('reelBtn').hidden = false;
  }

  const entry = modelRes.data;
  if (!entry) {
    if (modelRes.error) console.error(modelRes.error); // e.g. a malformed id
    showEmpty('Model not found', 'It may have been removed. Go back to see all models.');
    return;
  }
  document.title = `${entry.name} · GLB Viewer`;
  loadModel(publicUrl(MODELS_BUCKET, entry.path), entry.size_bytes, entry.name);
}

// ---------- Start ----------
applyPreset('studio');
showValue('bgBlur');
showValue('rotateSpeed');
setPanel(!MOBILE_QUERY.matches);
loadContent();

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  if (mixer) mixer.update(dt);
  controls.update(dt); // dt keeps turntable speed independent of frame rate
  render();

  frames++;
  const now = performance.now();
  if (now - lastTime >= 500) {
    fps = Math.round((frames * 1000) / (now - lastTime));
    frames = 0;
    lastTime = now;
    if (perfEl.classList.contains('show')) updatePerf();
  }
});
