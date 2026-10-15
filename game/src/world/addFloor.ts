/**
 * #58 Add floor: the kinds of floor the dialog offers, and the name rule of a new herdr session, as the bridge checks it
 * (`herdr.CheckNewSessionName`, docs/protocol.md "New herdr sessions"). The bridge also caps the length by its host's
 * socket path and checks what herdr knows (a session asleep, a leftover folder): those refusals come back from it. Pure.
 */

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

/** A kind of floor the Add floor dialog can make. */
export interface FloorKind {
  id: 'session';
  label: string;
  hint: string;
}

/** The kinds, in the order the dialog lists them (#58 stage 4 adds a virtual floor on an existing session). */
export const FLOOR_KINDS: readonly FloorKind[] = [{ id: 'session', label: 'New herdr session', hint: 'Starts a herdr server under the name below.' }];
