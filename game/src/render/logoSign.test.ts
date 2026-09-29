import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LogoSign } from './logoSign';
import type { LogoEntry } from './logos';

const entry = (w: number, h: number, hash = 'aa11bb22'): LogoEntry => ({ hash, texture: new THREE.Texture(), width: w, height: h });

function sign(width = 3.6, height = 0.9) {
  const parent = new THREE.Group();
  const name = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicNodeMaterial());
  name.position.set(1, 2, 3);
  parent.add(name);
  const s = new LogoSign(name, width, height, { plate: 0xfff6dd, bezel: 0x24406e, pad: 0.1, rim: 0.05 });
  return { parent, name, s };
}

describe('LogoSign', () => {
  it('shows the name until a logo comes, and goes back to it when the logo goes', () => {
    const { name, s } = sign();
    expect(s.showing).toBe('name');
    expect(name.visible).toBe(true);
    expect(s.group.visible).toBe(false);
    s.set(entry(400, 100));
    expect(s.showing).toBe('logo');
    expect(name.visible).toBe(false);
    expect(s.hash).toBe('aa11bb22');
    s.set(null);
    expect(s.showing).toBe('name');
    expect(name.visible).toBe(true);
    expect(s.hash).toBeNull();
  });

  it('sits where the name board sat, in the same parent', () => {
    const { parent, name, s } = sign();
    expect(s.group.parent).toBe(parent);
    expect(s.group.position.toArray()).toEqual(name.position.toArray());
  });

  it('letterboxes the logo on the plate: aspect kept, inside the padding, centred', () => {
    const { s } = sign(3.6, 0.9);
    const logo = s.group.getObjectByName('logo.image') as THREE.Mesh;
    s.set(entry(100, 100)); // square on a 4:1 plate: limited by the height
    expect(logo.scale.x / logo.scale.y).toBeCloseTo(1, 9);
    expect(logo.scale.y).toBeCloseTo(0.9 * 0.8, 9);
    expect(logo.position.x).toBeCloseTo(0, 9);
    expect(logo.position.y).toBeCloseTo(0, 9);
    s.set(entry(1024, 64)); // very wide: limited by the width
    expect(logo.scale.x).toBeCloseTo(3.6 * 0.8, 9);
    expect(logo.scale.x / logo.scale.y).toBeCloseTo(16, 9);
    s.set(entry(30, 300)); // very tall
    expect(logo.scale.y).toBeCloseTo(0.72, 9);
    expect(logo.scale.x / logo.scale.y).toBeCloseTo(0.1, 9);
  });

  it('falls back to the name for a logo with no usable size', () => {
    const { name, s } = sign();
    s.set(entry(0, 0));
    expect(s.showing).toBe('name');
    expect(name.visible).toBe(true);
    s.set(entry(Number.NaN, 5));
    expect(s.showing).toBe('name');
  });

  it('takes a new logo without rebuilding the plate, and removes itself on dispose', () => {
    const { parent, name, s } = sign();
    const meshes = () => s.group.children.length;
    s.set(entry(10, 10, 'aa11bb22'));
    const n = meshes();
    const m1 = (s.group.getObjectByName('logo.image') as THREE.Mesh).material;
    s.set(entry(20, 10, 'cc33dd44'));
    expect(meshes()).toBe(n);
    expect((s.group.getObjectByName('logo.image') as THREE.Mesh).material).not.toBe(m1);
    expect(s.hash).toBe('cc33dd44');
    s.dispose();
    expect(parent.children).toEqual([name]);
  });
});
