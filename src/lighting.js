import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Lighting presets. Each one sets the environment map, key light, fill light,
 * exposure and the default backdrop colours.
 * az / el are degrees: azimuth around the model (0 = +x, 90 = +z), elevation above the ground.
 */
export const PRESETS = {
  studio: {
    label: 'Studio',
    env: { type: 'room' },
    envIntensity: 1,
    key: { color: '#ffffff', intensity: 2, az: 45, el: 55 },
    fill: { sky: '#ffffff', ground: '#444444', intensity: 0.4 },
    exposure: 1,
    backdrop: { top: '#3b404b', bottom: '#14161a', solid: '#22252c' }
  },
  sunset: {
    label: 'Sunset',
    env: { type: 'sky', top: '#27345c', horizon: '#ff9457', bottom: '#2d2222', sun: 6 },
    envIntensity: 1,
    key: { color: '#ffb070', intensity: 2.8, az: 220, el: 16 },
    fill: { sky: '#7d8fd1', ground: '#5a3524', intensity: 0.35 },
    exposure: 1.05,
    backdrop: { top: '#e78559', bottom: '#2a1f35', solid: '#3a2a34' }
  },
  night: {
    label: 'Night',
    env: { type: 'sky', top: '#050a1c', horizon: '#22355e', bottom: '#050506', sun: 3 },
    envIntensity: 0.6,
    key: { color: '#9cb9ff', intensity: 1.4, az: 120, el: 40 },
    fill: { sky: '#3a4c80', ground: '#0a0a10', intensity: 0.25 },
    exposure: 0.95,
    backdrop: { top: '#1c2745', bottom: '#05070d', solid: '#0d1220' }
  },
  neutral: {
    label: 'Neutral',
    env: { type: 'room' },
    envIntensity: 0.6,
    key: { color: '#ffffff', intensity: 1.2, az: 30, el: 70 },
    fill: { sky: '#ffffff', ground: '#808080', intensity: 0.6 },
    exposure: 1,
    backdrop: { top: '#8d9096', bottom: '#5b5e64', solid: '#74777d' }
  }
};

/** Unit direction for azimuth / elevation in degrees. */
export function lightDirection(az, el, target = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(az);
  const e = THREE.MathUtils.degToRad(el);
  return target.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 bottom;
varying vec3 vDir;
void main() {
  float y = vDir.y;
  vec3 c = y > 0.0
    ? mix(horizon, top, pow(y, 0.6))
    : mix(horizon, bottom, pow(-y, 0.4));
  gl_FragColor = vec4(c, 1.0);
}`;

/** Builds a temporary scene for a sky-gradient environment, with a bright disc in the sun direction. */
function buildSkyScene(env, key) {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        top: { value: new THREE.Color(env.top) },
        horizon: { value: new THREE.Color(env.horizon) },
        bottom: { value: new THREE.Color(env.bottom) }
      }
    })
  );
  scene.add(sky);

  // HDR "sun" so glossy surfaces pick up a highlight that matches the key light.
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 16, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(key.color).multiplyScalar(env.sun) })
  );
  lightDirection(key.az, key.el, sun.position).multiplyScalar(8);
  scene.add(sun);
  return scene;
}

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/**
 * Environment textures are generated once per preset and kept for the app's lifetime
 * (only four exist). The temporary source scenes are disposed straight away.
 */
export function createEnvironmentCache(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const preset = PRESETS[name];
    let texture;
    if (preset.env.type === 'room') {
      const room = new RoomEnvironment();
      texture = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
    } else {
      const sky = buildSkyScene(preset.env, preset.key);
      texture = pmrem.fromScene(sky, 0.02).texture;
      disposeScene(sky);
    }
    cache.set(name, texture);
    return texture;
  };
}
