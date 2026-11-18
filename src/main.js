import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MAX_FILE_MB = 200;

// ---------- Renderer / scene / camera ----------
const container = document.getElementById('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e24);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 1000);
camera.position.set(3, 2, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---------- Lights ----------
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(5, 10, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.bias = -0.0005; // normalBias is scaled per model in frameModel()
scene.add(dirLight);

// ---------- Grid & ground ----------
const grid = new THREE.GridHelper(10, 20, 0x888888, 0x44444c);
grid.position.y = 0.001;
scene.add(grid);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 1 })
);
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
const originalMaterials = new Map(); // mesh -> original material (or array)
const overrideCache = new Map(); // original material -> { wireframe, clay, normals }
const modelStats = { meshes: 0, vertices: 0, triangles: 0, materials: 0, fileSize: 0 };
const loadingEl = document.getElementById('loading');
const dropEl = document.getElementById('drop');

// ---------- Loading ----------
/** Validate a local File, then hand it to loadModel(). */
function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.glb')) {
    alert('Please choose a .glb file');
    return;
  }
  if (file.size > MAX_FILE_MB * 1048576) {
    alert(`File is larger than ${MAX_FILE_MB} MB`);
    return;
  }
  const url = URL.createObjectURL(file);
  loadModel(url, file.size).finally(() => URL.revokeObjectURL(url));
}

/** Single entry point for loading any model URL (local blob now, cloud URL in Phase 2). */
async function loadModel(url, fileSize = 0) {
  const id = ++loadId;
  loadingEl.style.display = 'block';
  try {
    const gltf = await loader.loadAsync(url);
    if (id !== loadId) {
      disposeObject(gltf.scene); // a newer load superseded this one
      return;
    }
    setModel(gltf, fileSize);
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    alert('Could not load this model. Check the console for details.');
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

  dirLight.position.set(maxDim * 2, maxDim * 4, maxDim * 2);
  dirLight.shadow.normalBias = maxDim * 0.003; // ~1.5 shadow-map texels
  const sc = dirLight.shadow.camera;
  sc.left = -g / 2;
  sc.right = g / 2;
  sc.top = g / 2;
  sc.bottom = -g / 2;
  sc.near = 0.01;
  sc.far = maxDim * 12;
  sc.updateProjectionMatrix();
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
      b.classList.toggle('active', m === 'wireframe' ? showWire : m === surfaceMode);
    });
    applyViewMode();
  });
});

const perfEl = document.getElementById('perf');
document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const on = btn.classList.toggle('active');
    if (btn.dataset.toggle === 'grid') grid.visible = on;
    if (btn.dataset.toggle === 'ground') ground.visible = on;
    if (btn.dataset.toggle === 'perf') {
      perfEl.classList.toggle('show', on);
      if (on) updatePerf();
    }
  });
});

const fileInput = document.getElementById('fileInput');
document.getElementById('uploadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  fileInput.value = ''; // allow re-uploading the same file
});

// Drag & drop — depth counter prevents flicker when crossing child elements.
let dragDepth = 0;
container.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  container.classList.add('dragging');
});
container.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) container.classList.remove('dragging');
});
container.addEventListener('dragover', (e) => e.preventDefault());
container.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  container.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});
// Stop the browser opening files dropped outside the viewer.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

new ResizeObserver(() => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
    ['— Model —', ''],
    ['Meshes', fmt(modelStats.meshes)],
    ['Vertices', fmt(modelStats.vertices)],
    ['Triangles', fmt(modelStats.triangles)],
    ['Materials', modelStats.materials],
    ['File size', modelStats.fileSize ? (modelStats.fileSize / 1048576).toFixed(2) + ' MB' : '-']
  ];
  perfEl.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><span class="val">${v}</span></div>`)
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

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  if (mixer) mixer.update(dt);
  controls.update();
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
