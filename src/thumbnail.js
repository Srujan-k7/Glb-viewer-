// Admin-only: renders a .glb to a still image for the model cards on the home page.
// Same look as the viewer: Studio preset, ACES tone mapping, backdrop gradient, ground shadow.
// The recipe is fixed: measure the bounding sphere, stand the model on the ground, view it
// from a 3/4 angle at a distance that makes it fill the frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PRESETS, lightDirection, createEnvironmentCache } from './lighting.js';

export const THUMB_WIDTH = 800;
export const THUMB_HEIGHT = 600;
const PRESET = PRESETS.studio;
const VIEW_AZ = 45; // degrees around the model (same side as the viewer's opening camera)
const VIEW_EL = 22; // degrees above the ground
const FOV = 35;
const FILL = 1.1; // > 1 leaves a little margin around the model

// One hidden renderer, created on first use and kept for the page's lifetime (like the
// viewer's), so repeated thumbnails don't churn WebGL contexts. Models are disposed per call.
let ctx = null;

function setup() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(THUMB_WIDTH, THUMB_HEIGHT, false);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = PRESET.exposure;

  const scene = new THREE.Scene();
  scene.environment = createEnvironmentCache(renderer)('studio');
  scene.environmentIntensity = PRESET.envIntensity;

  const hemi = new THREE.HemisphereLight(PRESET.fill.sky, PRESET.fill.ground, PRESET.fill.intensity);
  const key = new THREE.DirectionalLight(PRESET.key.color, PRESET.key.intensity);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  scene.add(hemi, key, key.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(FOV, THUMB_WIDTH / THUMB_HEIGHT, 0.01, 1000);

  const loader = new GLTFLoader()
    .setDRACOLoader(new DRACOLoader())
    .setKTX2Loader(new KTX2Loader().detectSupport(renderer))
    .setMeshoptDecoder(MeshoptDecoder);

  return { renderer, scene, key, ground, camera, loader };
}

function disposeObject(root) {
  const materials = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    if (o.isSkinnedMesh) o.skeleton.dispose();
    [o.material].flat().forEach((m) => m && materials.add(m));
  });
  materials.forEach((m) => {
    for (const k in m) if (m[k]?.isTexture) m[k].dispose();
    m.dispose();
  });
}

/** Paints the viewer's CSS backdrop, radial-gradient(120% 90% at 50% 0%, top, bottom). */
function paintBackdrop(g, w, h) {
  g.save();
  g.translate(w / 2, 0);
  g.scale(w * 1.2, h * 0.9);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, PRESET.backdrop.top);
  grad.addColorStop(1, PRESET.backdrop.bottom);
  g.fillStyle = grad;
  g.fillRect(-1, 0, 2, h / (h * 0.9));
  g.restore();
}

/**
 * Renders the model at `url` (object URL or public URL) and resolves a WebP Blob.
 * Throws if the model can't be loaded or has no geometry.
 */
export async function renderThumbnail(url) {
  ctx ??= setup();
  const { renderer, scene, key, ground, camera, loader } = ctx;

  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  try {
    // First animation frame, so rigged models aren't caught in a bind pose.
    if (gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
      mixer.update(0);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    }
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });

    // 1. Measure, 2. stand on the ground, centred on x/z.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) throw new Error('Model has no visible geometry');
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    model.updateMatrixWorld(true);
    box.setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = sphere.radius || 1;
    scene.add(model);

    // 3. Camera: fixed 3/4 angle, distance so the bounding sphere fits the narrower (vertical) FOV.
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * FILL;
    lightDirection(VIEW_AZ, VIEW_EL, camera.position).multiplyScalar(dist).add(sphere.center);
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();

    // 4. Light and ground scale with the model, as in the viewer.
    const g = r * 8;
    ground.scale.set(g, g, 1);
    lightDirection(PRESET.key.az, PRESET.key.el, key.position).multiplyScalar(r * 10);
    key.target.position.set(0, 0, 0);
    key.shadow.normalBias = r * 0.006;
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -r * 2;
    sc.right = sc.top = r * 2;
    sc.near = 0.01;
    sc.far = r * 24;
    sc.updateProjectionMatrix();
    key.shadow.needsUpdate = true;

    // 5. Render, then composite over the backdrop gradient.
    renderer.render(scene, camera);
    const out = document.createElement('canvas');
    out.width = THUMB_WIDTH;
    out.height = THUMB_HEIGHT;
    const g2d = out.getContext('2d');
    paintBackdrop(g2d, THUMB_WIDTH, THUMB_HEIGHT);
    g2d.drawImage(renderer.domElement, 0, 0);

    const blob = await new Promise((res) => out.toBlob(res, 'image/webp', 0.85));
    if (!blob || blob.type !== 'image/webp') {
      // Browsers without WebP encoding fall back to PNG.
      return await new Promise((res) => out.toBlob(res, 'image/png'));
    }
    return blob;
  } finally {
    scene.remove(model);
    disposeObject(model);
  }
}
