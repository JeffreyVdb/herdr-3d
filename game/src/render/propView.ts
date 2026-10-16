import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';

/**
 * Is a prop of the floor in view of the camera, and how big? The test the wall screens and the server rack share (#118,
 * #74): the prop's box, in the floor's frame, is moved to the world, tested against the camera's frustum, and its
 * share of the view's height is the vertical span of its middle line on screen. Reuses its vectors: nothing is allocated
 * per call.
 */
export class PropViewer {
  private readonly box = new THREE.Box3();
  private readonly frustum = new THREE.Frustum();
  private readonly mat = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();

  /**
   * The share of the view's height `box` spans (0 to 1 and more when close), or 0 when any part of it is out of the
   * frustum entirely. `root` is the floor's root, whose world matrix places the box.
   */
  share(box: Box3, root: THREE.Object3D, camera: THREE.Camera): number {
    this.box.min.fromArray(box.min);
    this.box.max.fromArray(box.max);
    this.box.applyMatrix4(root.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (!this.frustum.intersectsBox(this.box)) return 0;
    const c = this.box.getCenter(this.v.set(0, 0, 0));
    const h = (this.box.max.y - this.box.min.y) / 2;
    const top = this.v2.set(c.x, c.y + h, c.z).project(camera).y;
    const bottom = this.v.set(c.x, c.y - h, c.z).project(camera).y;
    return Math.abs(top - bottom) / 2;
  }
}
