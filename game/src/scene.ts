import * as THREE from 'three/webgpu';

export const SKY_COLOR = 0x9fd6ff;

/** Placeholder scene: ground, one low-poly building, sun with shadows. */
export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_COLOR);

  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x6b8f4e, 1.2));

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.5);
  sun.position.set(12, 20, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = -20;
  s.right = 20;
  s.top = 20;
  s.bottom = -20;
  s.near = 1;
  s.far = 60;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x7fbf5a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const building = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(4, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0xf2b880, roughness: 0.8, flatShading: true }),
  );
  body.position.y = 3;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(3.4, 2, 4),
    new THREE.MeshStandardMaterial({ color: 0xc8553d, roughness: 0.7, flatShading: true }),
  );
  roof.position.y = 7;
  roof.rotation.y = Math.PI / 4;
  for (const mesh of [body, roof]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    building.add(mesh);
  }
  scene.add(building);

  return scene;
}
