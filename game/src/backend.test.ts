import { describe, expect, it } from 'vitest';
import { backendName, forceWebGLFromSearch } from './backend';

describe('forceWebGLFromSearch', () => {
  it.each([
    ['', false],
    ['?backend=webgpu', false],
    ['?backend=webgl2', true],
    ['?foo=1&backend=webgl2', true],
    ['?backend=WEBGL2', false],
  ])('%j -> %s', (search, want) => {
    expect(forceWebGLFromSearch(search)).toBe(want);
  });
});

describe('backendName', () => {
  it('detects the WebGPU backend', () => {
    expect(backendName({ isWebGPUBackend: true })).toBe('webgpu');
  });
  it('treats anything else as WebGL2', () => {
    expect(backendName({ isWebGLBackend: true })).toBe('webgl2');
    expect(backendName({})).toBe('webgl2');
  });
});
