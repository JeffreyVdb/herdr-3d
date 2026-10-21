import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Display } from '../world/derive';
import type { CrewRole } from '../world/crew';
import { SEAT_LIFT } from '../world/arrival';
import { Crowd } from './crowd';
import { deskGeometries } from './desks';
import { WORN, type CrewLook } from './crewLook';

describe('a seated worker fits its chair', () => {
  for (const low of [false, true]) {
    for (const role of [null, ...Object.keys(WORN)] as (CrewRole | null)[]) {
      it(`keeps the ${role ?? 'plain'} worker and accessories clear of the backrest (${low ? 'city' : 'office'})`, () => {
        const crowd = new Crowd(1, false, low);
        const geometry = deskGeometries();
        const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        const chair = new THREE.Mesh(geometry.chair, material);
        const ray = new THREE.Raycaster();
        const direction = new THREE.Vector3(0, 0, 1);
        const matrix = new THREE.Matrix4();
        const parts = ['body', 'pants', ...(role ? [WORN[role]] : [])].map((key) => crowd.group.getObjectByName(`crowd.${key}`) as THREE.InstancedMesh);
        const crew: CrewLook | undefined = role ? { role, life: null, run: null, stamp: null, overCap: false, pass: null, phaseColor: 0, turn: 0 } : undefined;
        try {
          for (const display of ['working', 'done', 'idle', 'waiting', 'needs_you', 'asleep'] satisfies Display[]) {
            crowd.set(0, { x: 0, y: SEAT_LIFT, z: 0, yaw: 0, scale: 1, tint: 0xffdd77, cue: { family: 'opus', hat: 'beanie', color: 0xff8800 }, display, phase: 0, ...(crew ? { crew } : {}) });
            for (const t of [0, 0.7, 2.4]) {
              crowd.update(t);
              let samples = 0;
              for (const part of parts) {
                part.getMatrixAt(0, matrix);
                const worker = new THREE.Mesh(part.geometry, material);
                worker.applyMatrix4(matrix);
                worker.updateMatrixWorld();
                for (const x of [-0.2, -0.1, 0, 0.1, 0.2]) {
                  for (const y of [0.52, 0.56, 0.6, 0.64, 0.68, 0.72, 0.76, 0.8, 0.84, 0.88, 0.9]) {
                    ray.set(new THREE.Vector3(x, y, -2), direction);
                    const back = ray.intersectObject(chair);
                    const body = ray.intersectObject(worker);
                    if (back.length && body.length) {
                      samples++;
                      const gap = part.name === 'crowd.backpack'
                        ? back[0]!.point.z - body.at(-1)!.point.z
                        : body[0]!.point.z - back.at(-1)!.point.z;
                      expect(gap, `${display} ${part.name} t=${t} x=${x} y=${y}`).toBeGreaterThan(0);
                    }
                  }
                }
              }
              expect(samples, `${display} t=${t}: rays cross both meshes`).toBeGreaterThan(0);
            }
          }
        } finally {
          crowd.dispose();
          for (const geo of Object.values(geometry)) geo.dispose();
          material.dispose();
        }
      });
    }
  }

  it('leaves the seated backpack on the chair through leaning and turning, and wears it while walking', () => {
    const crowd = new Crowd(1, false);
    const pack = crowd.group.getObjectByName('crowd.backpack') as THREE.InstancedMesh;
    const body = crowd.group.getObjectByName('crowd.body') as THREE.InstancedMesh;
    const crew: CrewLook = { role: 'ground', life: null, run: null, stamp: null, overCap: false, pass: null, phaseColor: 0, turn: 0 };
    const member = { x: 2, y: SEAT_LIFT, z: 3, yaw: 0.8, scale: 1, tint: 0xffdd77, cue: { family: 'opus', hat: 'beanie', color: 0xff8800 } as const, display: 'idle' as const, phase: 0, crew };
    const seated = new THREE.Matrix4();
    const actual = new THREE.Matrix4();
    const worn = new THREE.Matrix4();
    try {
      crowd.set(0, member);
      crowd.update(0);
      pack.getMatrixAt(0, seated);
      crowd.set(0, { ...member, crew: { ...crew, life: 'reporting', turn: Math.PI / 3 } });
      crowd.update(2.4);
      pack.getMatrixAt(0, actual);
      expect(actual.elements).toEqual(seated.elements);

      crowd.set(0, { ...member, stride: 1.2 });
      crowd.update(2.4);
      pack.getMatrixAt(0, actual);
      body.getMatrixAt(0, worn);
      expect(actual.elements).toEqual(worn.elements);
      expect(actual.elements).not.toEqual(seated.elements);

      crowd.set(0, member);
      crowd.update(3);
      pack.getMatrixAt(0, actual);
      expect(actual.elements).toEqual(seated.elements);
    } finally {
      crowd.dispose();
    }
  });
});
