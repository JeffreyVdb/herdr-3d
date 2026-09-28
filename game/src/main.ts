import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { backendName, forceWebGLFromSearch, type BackendName } from './backend';
import { createScene } from './scene';

/** Debug/test hook, read by the Playwright screenshot test. */
export interface H3DDebug {
  backend: BackendName | null;
  frames: number;
  error: string | null;
}

declare global {
  interface Window {
    __h3d: H3DDebug;
  }
}

const h3d: H3DDebug = { backend: null, frames: 0, error: null };
window.__h3d = h3d;

async function start(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    forceWebGL: forceWebGLFromSearch(window.location.search),
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  h3d.backend = backendName(renderer.backend);
  const overlay = document.getElementById('debug');
  if (overlay) overlay.textContent = `backend: ${h3d.backend}`;

  const scene = createScene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(14, 10, 16);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 3, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.update();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  await renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
    h3d.frames++;
  });
}

start().catch((err: unknown) => {
  h3d.error = String(err);
  console.error('h3d: renderer failed to start', err);
  const overlay = document.getElementById('debug');
  if (overlay) overlay.textContent = `renderer error: ${String(err)}`;
});
