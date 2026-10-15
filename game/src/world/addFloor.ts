/**
 * #58 Add floor: the kinds of floor the dialog offers, the name rule of a new herdr session, as the bridge checks it
 * (`herdr.CheckNewSessionName`, docs/protocol.md "New herdr sessions"), and a virtual floor's (`store.CleanFloorName`,
 * docs/protocol.md "Virtual floors"). The bridge also caps a session name by its host's socket path and checks what
 * herdr knows (a session asleep, a leftover folder): those refusals come back from it. Pure.
 */

import { floorName } from './floorName';
import type { StoredFloor } from './store';

/** herdr's own cap on a session name; the bridge's host may allow fewer (its sun_path cap). */
export const MAX_SESSION_NAME = 64;

const NAME_RE = /^[a-z0-9_-]+$/;

/** Why `name` can't be a new herdr session's name ('' when it can). `floors`: the sessions the game shows. */
export function newSessionNameError(name: string, floors: Iterable<string>): string {
  if (!name) return 'Give the floor a name.';
  if (name === 'default') return '“default” is herdr’s own session: pick another name.';
  if (!NAME_RE.test(name)) return 'Use only lowercase letters, digits, “_” and “-”.';
  if (name.startsWith('-')) return 'The name cannot start with “-”.';
  if (name.length > MAX_SESSION_NAME) return `Keep the name to at most ${MAX_SESSION_NAME} characters.`;
  for (const f of floors) if (f === name) return `“${name}” is already a floor.`;
  return '';
}

/** A virtual floor's name, in UTF-8 bytes (the bridge's `store.MaxFloorNameLen`). */
export const MAX_FLOOR_NAME = 64;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Why `name` can't be a virtual floor's name ('' when it can): free text, trimmed, 1–64 bytes, no control characters. */
export function floorNameError(name: string): string {
  const n = name.trim();
  if (!n) return 'Give the floor a name.';
  // Go's unicode.IsControl: C0, DEL and C1.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) return 'A floor name cannot have a line break or a control character in it.';
  if (bytes(n) > MAX_FLOOR_NAME) return `Keep the name shorter: at most ${MAX_FLOOR_NAME} bytes (accented letters and emoji count as more than one).`;
  return '';
}

/** A herdr session a virtual floor can stand on: a real floor's, in the world now. */
export interface BaseSession {
  session: string;
  /** Its floor's name (a real floor's is the session's). */
  name: string;
  asleep: boolean;
}

/** The sessions a virtual floor can be added to: every real floor's (hidden or asleep ones too), by name. */
export function baseSessions(floors: Iterable<StoredFloor>): BaseSession[] {
  const out: BaseSession[] = [];
  for (const f of floors) if (!f.virtual) out.push({ session: f.base_session, name: floorName(f), asleep: f.state === 'asleep' });
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.session < b.session ? -1 : 1));
}

/** A kind of floor the Add floor dialog can make. */
export interface FloorKind {
  id: 'session' | 'virtual';
  label: string;
  hint: string;
}

/** The kinds, in the order the dialog lists them. */
export const FLOOR_KINDS: readonly FloorKind[] = [
  { id: 'session', label: 'New herdr session', hint: 'Starts a herdr server under the name below.' },
  { id: 'virtual', label: 'Virtual floor on an existing session', hint: 'A floor of its own inside a session that is already here: its own desks, repository, board and whiteboard.' },
];
