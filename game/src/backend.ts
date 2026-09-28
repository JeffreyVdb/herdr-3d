export type BackendName = 'webgpu' | 'webgl2';

/**
 * `?backend=webgl2` forces three's WebGL2 fallback. Used by the headless
 * screenshot test: the server has no GPU and WebGPU canvases screenshot blank.
 */
export function forceWebGLFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('backend') === 'webgl2';
}

/** Name of the backend an initialised WebGPURenderer ended up on. */
export function backendName(backend: object): BackendName {
  return 'isWebGPUBackend' in backend && backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}
