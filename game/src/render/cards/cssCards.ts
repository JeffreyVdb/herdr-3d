import * as THREE from 'three/webgpu';
import { CHIP_TEXT } from '../../world/derive';
import { CARD_RANGE, selectCards, type CardRange } from './select';
import { sameCard, type CardData, type CardLayer, type Viewport } from './types';

interface PoolEntry {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  chip: HTMLSpanElement;
  task: HTMLDivElement;
  slot: number;
  shown: CardData | null;
  last: string;
}

/**
 * Cards as DOM elements over the canvas: a fixed pool of `cap` elements that
 * get reassigned to the nearest workers, so the DOM never grows with the
 * worker count. Positions are written only when the camera moved or a card
 * changed.
 */
export class CssCards implements CardLayer {
  readonly kind = 'css' as const;
  readonly object = null;
  private readonly root: HTMLDivElement;
  private readonly pool: PoolEntry[] = [];
  private readonly cards = new Map<number, CardData>();
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private dirty = true;

  constructor(
    parent: HTMLElement,
    private readonly range: CardRange = CARD_RANGE,
    private readonly weight: (slot: number) => number = () => 1,
    private readonly occluded: (slot: number, dist: number) => boolean = () => false,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'cards';
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
    for (let i = 0; i < range.cap; i++) {
      const el = document.createElement('div');
      el.className = 'card';
      el.hidden = true;
      const head = document.createElement('div');
      head.className = 'card-head';
      const name = document.createElement('span');
      name.className = 'card-name';
      const chip = document.createElement('span');
      chip.className = 'tape';
      head.append(name, chip);
      const task = document.createElement('div');
      task.className = 'card-task';
      el.append(head, task);
      this.root.appendChild(el);
      this.pool.push({ el, name, chip, task, slot: -1, shown: null, last: '' });
    }
  }

  setCard(slot: number, card: CardData | null): void {
    const prev = this.cards.get(slot) ?? null;
    if (sameCard(prev, card)) return;
    if (card) this.cards.set(slot, card);
    else this.cards.delete(slot);
    this.dirty = true;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
    this.dirty = true;
  }

  shown(): number[] {
    return this.pool.filter((p) => p.slot >= 0).map((p) => p.slot);
  }

  update(camera: THREE.PerspectiveCamera, anchors: ReadonlyArray<THREE.Vector3 | null>, vp: Viewport, force: boolean): void {
    if (this.root.hidden || (!force && !this.dirty)) return;
    this.dirty = false;
    camera.getWorldDirection(this.fwd);
    const eff = anchors.map((a, i) => (a && this.cards.has(i) ? a : null));
    const chosen = selectCards(camera.position, this.fwd, eff, this.range, this.weight, this.occluded);
    // Keep elements on the same slot where possible (no content rewrite).
    const want = new Set(chosen.map((c) => c.index));
    const free: PoolEntry[] = [];
    const bySlot = new Map<number, PoolEntry>();
    for (const p of this.pool) {
      if (p.slot >= 0 && want.has(p.slot)) bySlot.set(p.slot, p);
      else free.push(p);
    }
    for (const c of chosen) {
      let p = bySlot.get(c.index);
      if (!p) {
        p = free.pop();
        if (!p) break;
        p.slot = c.index;
        p.shown = null;
      }
      const card = this.cards.get(c.index);
      const a = anchors[c.index];
      if (!card || !a) continue;
      if (!sameCard(p.shown, card)) {
        p.name.textContent = card.name;
        p.chip.textContent = CHIP_TEXT[card.display];
        p.chip.className = `tape tape--${card.display}`;
        p.task.textContent = card.task;
        p.el.dataset.display = card.display;
        p.shown = card;
      }
      this.v.copy(a).project(camera);
      const x = ((this.v.x + 1) / 2) * vp.width;
      const y = ((1 - this.v.y) / 2) * vp.height;
      const k = Math.max(0.62, Math.min(1, 4.2 / Math.max(0.1, c.dist)));
      const style = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%) scale(${k.toFixed(3)})`;
      const op = c.alpha.toFixed(2);
      const key = `${style}|${op}`;
      if (p.last !== key) {
        p.el.style.transform = style;
        p.el.style.opacity = op;
        // Nearer cards on top.
        p.el.style.zIndex = String(1000 - Math.round(c.dist * 10));
        p.last = key;
      }
      p.el.hidden = false;
    }
    for (const p of free) {
      if (p.slot < 0) continue;
      p.slot = -1;
      p.el.hidden = true;
      p.last = '';
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
