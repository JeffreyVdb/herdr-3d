import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { daylightAt, zonedInstant } from '../world/daylight';
import { DaylightEase, EASE_S, lookOf, NOON, sceneDir } from './daylook';
import { WalkView } from './walk';

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('the eased light (M17)', () => {
  it('snaps on first load, then eases over a few seconds without a jump', () => {
    const e = new DaylightEase();
    const night = daylightAt(zonedInstant(2026, 9, 30, 23, 0, 'UTC'), 'UTC');
    e.set(night, true);
    expect(e.state.day).toBe(0);
    e.set(daylightAt(zonedInstant(2026, 9, 30, 12, 0, 'UTC'), 'UTC'), false);
    let prev = e.state.day;
    let t = 0;
    while (e.step(1 / 60)) {
      expect(e.state.day - prev).toBeLessThan(0.02);
      prev = e.state.day;
      t += 1 / 60;
      if (t > 10) break;
    }
    expect(e.state.day).toBe(1);
    expect(t).toBeGreaterThan(EASE_S * 0.8);
    expect(t).toBeLessThan(EASE_S * 2.5);
    // Settled: nothing to do any more.
    expect(e.step(1 / 60)).toBe(false);
  });

  it('turns the sun the short way round', () => {
    const e = new DaylightEase();
    e.set({ daylight: 1, warmth: 0, azimuth: 350, elevation: 30 }, true);
    e.set({ daylight: 1, warmth: 0, azimuth: 10, elevation: 30 }, false);
    e.step(0.5);
    expect(e.state.azimuth > 350 || e.state.azimuth < 10).toBe(true);
  });
});

describe('the look', () => {
  it('noon is today\'s daylight: an untinted street, the glass as it was; night is dark with the lamps on', () => {
    const noon = lookOf(NOON);
    expect(noon.outside.getHex()).toBe(0xffffff);
    expect(noon.glass.getHexString()).toBe('9fd3f0');
    expect(noon.lamps).toBe(0);
    const night = lookOf({ day: 0, warmth: 0, azimuth: 0, elevation: -40 });
    expect(lum(night.sky)).toBeLessThan(0.02);
    expect(lum(night.outside)).toBeLessThan(0.15);
    expect(night.lamps).toBe(1);
  });

  it('the sky gets darker monotonically from day to night', () => {
    let prev = Infinity;
    for (let d = 1; d >= 0; d -= 0.05) {
      const l = lum(lookOf({ day: d, warmth: 0, azimuth: 180, elevation: 30 }).sky);
      expect(l).toBeLessThanOrEqual(prev + 1e-9);
      prev = l;
    }
  });

  it('the noon sun keeps each scene\'s old direction', () => {
    const d = sceneDir(lookOf(NOON).sunDir, 69);
    const heading = (Math.atan2(d.x, -d.z) * 180) / Math.PI;
    expect(heading).toBeCloseTo(69, 5);
    expect((Math.asin(d.y) * 180) / Math.PI).toBeCloseTo(57, 5);
  });
});

describe('the room light with an asleep floor', () => {
  it('an asleep floor is darker than a running one at every hour, and neither setter overwrites the other', () => {
    const w = new WalkView(false);
    const lights = () => {
      let hemi = 0;
      let sun = 0;
      w.scene.traverse((o) => {
        if (o instanceof THREE.HemisphereLight) hemi = o.intensity;
        if (o instanceof THREE.DirectionalLight) sun = o.intensity;
      });
      return hemi + sun;
    };
    for (let h = 0; h < 24; h++) {
      const s = daylightAt(zonedInstant(2026, 9, 30, h, 0, 'UTC'), 'UTC');
      const look = lookOf({ day: s.daylight, warmth: s.warmth, azimuth: s.azimuth, elevation: s.elevation });
      w.setDim(false);
      w.setDaylight(look);
      const awake = lights();
      w.setDim(true);
      const asleep = lights();
      // The other order: the light first, then the dim.
      w.setDaylight(look);
      expect(lights()).toBe(asleep);
      expect(asleep, `${h}:00`).toBeLessThan(awake * 0.35);
    }
  });

  it('noon is brighter than before M17 (hemisphere 1.5, sun 1.9)', () => {
    const w = new WalkView(false);
    w.setDaylight(lookOf(NOON));
    let hemi = 0;
    let sun = 0;
    w.scene.traverse((o) => {
      if (o instanceof THREE.HemisphereLight) hemi = o.intensity;
      if (o instanceof THREE.DirectionalLight) sun = o.intensity;
    });
    expect(hemi).toBeGreaterThanOrEqual(1.5);
    expect(sun).toBeGreaterThanOrEqual(1.9);
  });
});
