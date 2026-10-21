import * as THREE from 'three/webgpu';

/** The objects, materials, geometries and textures disposed while `holdDisposals` runs (null: none running). */
let held: Set<THREE.EventDispatcher<object>> | null = null;

/**
 * #141: runs `work` (a `renderer.compileAsync`), then fires each `dispose` event that fired meanwhile once more.
 * compileAsync picks its objects (each with its material) at once, then builds them one at a time, yielding between
 * them; world events still run in those yields and may dispose what it picked (a floor resized: the kits it outgrew, the
 * outside, a swapped texture or material). three listens for an object's `dispose` only once it has built it, so what it
 * builds after the dispose would be kept for good (its render object, state, pipeline, buffers, textures). Fired again,
 * the event reaches only those late listeners (three removes its own when one fires): it releases exactly that.
 * A hold inside a hold fires them when the outer one ends. Nothing in the game listens for `dispose` itself.
 */
export async function holdDisposals<T>(work: () => Promise<T>): Promise<T> {
  if (held) return work();
  const proto = THREE.EventDispatcher.prototype;
  const dispatch = proto.dispatchEvent;
  const disposed = new Set<THREE.EventDispatcher<object>>();
  held = disposed;
  proto.dispatchEvent = function (this: THREE.EventDispatcher<object>, event) {
    if (event.type === 'dispose') disposed.add(this);
    dispatch.call(this, event);
  };
  try {
    return await work();
  } finally {
    proto.dispatchEvent = dispatch;
    held = null;
    for (const d of disposed) d.dispatchEvent({ type: 'dispose' } as never);
  }
}
