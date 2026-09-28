import type * as THREE from 'three/webgpu';
import type { Display } from '../../world/derive';

export interface CardData {
  name: string;
  display: Display;
  task: string;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * A speech-bubble card per worker. Two implementations are kept for the
 * benchmark (`?cards=css|atlas`); see docs in the game section of CONTRIBUTING.
 */
export interface CardLayer {
  readonly kind: 'css' | 'atlas';
  /** Scene object to add (atlas), or null (css draws in the DOM). */
  readonly object: THREE.Object3D | null;
  setCard(slot: number, card: CardData | null): void;
  /**
   * Places the cards for this frame. `force` redoes the layout even when the
   * camera did not move (data or viewport changed).
   */
  update(camera: THREE.PerspectiveCamera, anchors: ReadonlyArray<THREE.Vector3 | null>, vp: Viewport, force: boolean): void;
  setVisible(v: boolean): void;
  /** Slots currently showing a card (for tests). */
  shown(): number[];
  dispose(): void;
}

export const sameCard = (a: CardData | null, b: CardData | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.display === b.display && a.task === b.task);
