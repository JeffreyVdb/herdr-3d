/**
 * M13 whiteboard: a board's unsaved changes, kept when its editor closes without saving them (the bridge could not be
 * reached and the user chose to close anyway). In memory for as long as the page lives, and in localStorage as well
 * when it fits, so the next open of that board brings them back (reconciled with what the bridge has since) and saves
 * them. One draft per bridge and floor; a save that lands with all of it drops it. No React, no Excalidraw:
 * unit-tested on its own.
 */

import { bridgeKey } from '../net/bridgeScope';

/** A file a draft's images use: Excalidraw's BinaryFileData. */
export interface DraftFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface Draft {
  v: 1;
  /** When it was kept (unix ms). */
  at: number;
  /** Every element of the scene, tombstones included. */
  elements: unknown[];
  /** The files of its live images (the bridge may not have them). */
  files: DraftFile[];
  /** The board's appState (cleanAppState) when the user changed it, else null: the bridge's stays. */
  appState: Record<string, unknown> | null;
}

const PREFIX = 'h3d.wb.draft.';
/** A draft larger than this (UTF-16 units) stays in memory only: localStorage holds about 5 MB per origin. */
export const MAX_STORED_DRAFT = 4_000_000;

const memory = new Map<string, Draft>();

/** The draft's key: the bridge (host and path of its WebSocket URL, never the token) and the floor. */
export function draftKey(wsUrl: string, floor: string): string {
  const u = new URL(wsUrl);
  return `${u.host}${u.pathname}|${floor}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked (a sandboxed frame, a privacy setting)
  }
}

const isDraft = (d: unknown): d is Draft => {
  const o = d as Draft | null;
  return !!o && o.v === 1 && typeof o.at === 'number' && Array.isArray(o.elements) && Array.isArray(o.files) && (o.appState === null || typeof o.appState === 'object');
};

/** Keeps a draft. Returns where: 'stored' (memory and localStorage) or 'memory' (too large, or storage refused). */
export function keepDraft(key: string, d: Draft, store: Storage | null = storage()): 'stored' | 'memory' {
  memory.set(key, d);
  try {
    const s = JSON.stringify(d);
    if (store && s.length <= MAX_STORED_DRAFT) {
      store.setItem(bridgeKey(PREFIX) + key, s);
      return 'stored';
    }
    store?.removeItem(bridgeKey(PREFIX) + key); // an older, smaller draft must not come back instead
  } catch {
    try {
      store?.removeItem(bridgeKey(PREFIX) + key);
    } catch {
      // nothing more to do: the memory copy stays
    }
  }
  return 'memory';
}

/** The draft kept for key, if any (memory first, else localStorage). */
export function readDraft(key: string, store: Storage | null = storage()): Draft | null {
  const m = memory.get(key);
  if (m) return m;
  try {
    const raw = store?.getItem(bridgeKey(PREFIX) + key);
    if (!raw) return null;
    const d: unknown = JSON.parse(raw);
    return isDraft(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Drops the copies of the draft kept for key (memory, localStorage) that `covered` says a save has all of; a copy with
 * more (kept later, by a close after that save was taken) stays. True when no draft is left for key.
 */
export function dropDraftIf(key: string, covered: (d: Draft) => boolean, store: Storage | null = storage()): boolean {
  let left = false;
  const m = memory.get(key);
  if (m) {
    if (covered(m)) memory.delete(key);
    else left = true;
  }
  try {
    const raw = store?.getItem(bridgeKey(PREFIX) + key);
    if (raw) {
      const d: unknown = JSON.parse(raw);
      if (!isDraft(d) || covered(d)) store?.removeItem(bridgeKey(PREFIX) + key);
      else left = true;
    }
  } catch {
    // blocked or unreadable storage: nothing there to drop
  }
  return !left;
}

/** Drops the draft kept for key, whatever it holds (the user discarded the changes). */
export function dropDraft(key: string, store: Storage | null = storage()): void {
  memory.delete(key);
  try {
    store?.removeItem(bridgeKey(PREFIX) + key);
  } catch {
    // blocked storage has nothing to drop
  }
}
