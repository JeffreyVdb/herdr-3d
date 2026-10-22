import * as THREE from 'three/webgpu';

/** The objects, materials, geometries and textures disposed while any `holdDisposals` runs (null: none running). */
let held: Set<THREE.EventDispatcher<object>> | null = null;
/** How many holds run (their works not done yet). */
let holds = 0;
/** `dispatchEvent` as it was before the first of them. */
let dispatch = THREE.EventDispatcher.prototype.dispatchEvent;

/**
 * #141: runs `work` (a `renderer.compileAsync`), then fires each `dispose` event that fired meanwhile once more.
 * compileAsync picks its objects (each with its material) at once, then builds them one at a time, yielding between
 * them; world events still run in those yields and may dispose what it picked (a floor resized: the kits it outgrew, the
 * outside, a swapped texture or material). three listens for an object's `dispose` only once it has built it, so what it
 * builds after the dispose would be kept for good (its render object, state, pipeline, buffers, textures). Fired again,
 * the event reaches only those late listeners (three removes its own when one fires): it releases exactly that.
 * #146: holds overlap (the start-up city's compile and a floor ride's, each ending on its own): recording goes on until
 * the last running one's work is done, thrown or not, and only then is everything recorded since the first fired again,
 * once; a compile still running might yet build what another's disposals released. Nothing in the game listens for
 * `dispose` itself.
 */
export async function holdDisposals<T>(work: () => Promise<T>): Promise<T> {
  if (holds++ === 0) {
    const proto = THREE.EventDispatcher.prototype;
    const disposed = new Set<THREE.EventDispatcher<object>>();
    const original = (dispatch = proto.dispatchEvent);
    held = disposed;
    proto.dispatchEvent = function (this: THREE.EventDispatcher<object>, event) {
      if (event.type === 'dispose') disposed.add(this);
      original.call(this, event);
    };
  }
  try {
    return await work();
  } finally {
    if (--holds === 0) {
      // Put back first, or firing them again records them again.
      THREE.EventDispatcher.prototype.dispatchEvent = dispatch;
      const disposed = held;
      held = null;
      for (const d of disposed ?? []) d.dispatchEvent({ type: 'dispose' } as never);
    }
  }
}
