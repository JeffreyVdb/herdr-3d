/**
 * #124: the keyboard shortcuts of the game, in one table. `Game.onKey` dispatches from it, the `?` reference dialog
 * (ui/shortcutsDialog.ts) and docs/shortcuts.md are drawn from it, and the hint lines and the top bar's titles take
 * their key names from it, so none of them can drift from what a key does. Pure logic: no DOM, no game.
 *
 * Rules the table encodes (the unit test pins them):
 * - A binding is a chord (`code`: the physical key, as WASD is, or `key`: the character, for `?` `,` `/`, which sit
 *   elsewhere on every layout), an exact set of modifiers, and the scopes it is live in.
 * - Modifiers match exactly: `Shift+N` is not `N`. Alt is never part of one (Option+letter types a character on a
 *   Mac, and terminals own Alt+letter). A `key` chord leaves Shift to the character (`?` is Shift+/ on a US layout).
 * - Single keys pause while a field has focus (WCAG 2.1.4, `typingIn`). Only a chord marked `typing` (a modifier
 *   chord the browser and the field leave alone) fires from inside one.
 * - Two bindings may not have the same chord in overlapping scopes (`SCOPE_PARENT`: a scope overlaps itself and its
 *   ancestors). Scopes of one level (`aim:worker`, `aim:desk`) may reuse a key: E means what you aim at.
 * - Seated at a laptop every key but a few chords belongs to the terminal; those are listed (`readonly`, scope
 *   `seated`, kept in step with laptop/keys.ts by a test) and no seated key is a help key.
 */

export type Scope =
  | 'any'
  | 'floor'
  | 'city'
  | 'city:focus'
  | 'plan'
  | 'sitting'
  | 'selected'
  | 'changes'
  | 'aim:worker'
  | 'aim:desk'
  | 'aim:own-desk'
  | 'aim:board'
  | 'aim:elevator'
  | 'aim:reception'
  | 'aim:whiteboard'
  | 'aim:radio'
  | 'aim:overview'
  | 'dialog'
  | 'seated';

/** The scope a scope sits in; roots (`any`, `dialog`, `seated`) have none. */
export const SCOPE_PARENT: Readonly<Record<Scope, Scope | null>> = {
  any: null,
  floor: 'any',
  city: 'any',
  'city:focus': 'city',
  plan: 'floor',
  sitting: 'floor',
  selected: 'floor',
  changes: 'floor',
  'aim:worker': 'floor',
  'aim:desk': 'floor',
  'aim:own-desk': 'floor',
  'aim:board': 'floor',
  'aim:elevator': 'floor',
  'aim:reception': 'floor',
  'aim:whiteboard': 'floor',
  'aim:radio': 'floor',
  'aim:overview': 'floor',
  dialog: null,
  seated: null,
};

/** Two scopes can be live at once when one is the other or its ancestor. */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  const up = (s: Scope, to: Scope): boolean => {
    for (let c: Scope | null = s; c; c = SCOPE_PARENT[c]) if (c === to) return true;
    return false;
  };
  return up(a, b) || up(b, a);
}

export type Group = 'floor' | 'city' | 'aimed' | 'dialogs' | 'laptop';

export const GROUPS: ReadonlyArray<{ id: Group; title: string; note: string }> = [
  { id: 'floor', title: 'On a floor', note: 'Walking around an office, its lobby or the street.' },
  { id: 'city', title: 'In the city', note: 'The view from above, before you go inside.' },
  { id: 'aimed', title: 'Aimed at something', note: 'Look at it with the crosshair, or pick it without the mouse: T and Shift+T cycle the workers, desks and props.' },
  { id: 'dialogs', title: 'Dialogs and fields', note: 'Open dialogs and their fields own the keyboard.' },
  { id: 'laptop', title: 'At a laptop', note: 'Every key goes to the terminal or the conversation, except these. Esc stands you up; then ? opens this list.' },
];

export interface Chord {
  /** The physical key (`KeyboardEvent.code`), as WASD is read: the same place on every layout. */
  code?: string;
  /** The character (`KeyboardEvent.key`): for the keys that sit elsewhere per layout. Shift is the character's, not asked. */
  key?: string;
  /** Needs Shift (code chords only). */
  shift?: boolean;
  /** Ctrl on Windows and Linux, ⌘ on a Mac. */
  mod?: boolean;
  /** Ctrl itself, on every platform. */
  ctrl?: boolean;
  /** Fires from inside a text field too (a modifier chord only). */
  typing?: boolean;
}

export interface Binding {
  id: string;
  group: Group | readonly Group[];
  scope: Scope | readonly Scope[];
  keys: readonly Chord[];
  /** What it does, for the reference. */
  label: string;
  /** The keycaps shown when they are not simply the chords' (alternatives, each a list of caps). */
  show?: readonly (readonly string[])[];
  /** Fires on auto-repeat too (a held key). Toggles and openers do not. */
  repeat?: boolean;
  /** The browser's own action stays (Esc releasing the mouse, a held B): the game does not `preventDefault`. */
  quiet?: boolean;
  /** Documented here, handled elsewhere (the walker, a dialog, the seated terminal): never dispatched. */
  readonly?: boolean;
}

const code = (c: string, o: Omit<Chord, 'code'> = {}): Chord => ({ code: c, ...o });
const DIGITS: Chord[] = [...'0123456789'].flatMap((d) => [code(`Digit${d}`), code(`Numpad${d}`)]);

export const BINDINGS = [
  // ---- on a floor or in the city ------------------------------------------------------------------
  { id: 'help', group: ['floor', 'city'], scope: 'any', keys: [{ key: '?' }], label: 'This shortcut list (over any dialog; not at a laptop or the whiteboard)' },
  { id: 'help.field', group: 'dialogs', scope: 'any', keys: [{ key: '/', mod: true, typing: true }], label: 'The shortcut list, from inside a text field' },
  { id: 'next-need', group: ['floor', 'city'], scope: 'any', keys: [code('KeyN')], label: 'Next worker who needs you' },
  { id: 'inbox', group: ['floor', 'city'], scope: 'any', keys: [code('KeyN', { shift: true })], label: 'Inbox list: who needs you or is done' },
  { id: 'limits', group: ['floor', 'city'], scope: 'any', keys: [code('KeyL', { shift: true })], label: 'Plan limits' },
  { id: 'battery', group: ['floor', 'city'], scope: 'any', keys: [code('KeyB')], label: 'Battery saver', quiet: true },
  { id: 'settings', group: ['floor', 'city'], scope: 'any', keys: [{ key: ',' }], label: 'Settings' },
  { id: 'overview', group: ['floor', 'city'], scope: 'any', keys: [code('KeyO')], label: 'Floor overview: everyone on this floor and what they are doing' },
  // ---- on a floor ----------------------------------------------------------------------------------
  { id: 'walk', group: 'floor', scope: 'floor', keys: [code('KeyW'), code('KeyA'), code('KeyS'), code('KeyD')], show: [['W A S D'], ['↑ ← ↓ →']], label: 'Walk (the arrows turn left and right)', repeat: true, readonly: true },
  { id: 'look', group: 'floor', scope: 'floor', keys: [code('PageUp'), code('PageDown')], show: [['Page Up'], ['Page Down']], label: 'Look up and down', repeat: true, readonly: true },
  { id: 'look.level', group: 'floor', scope: 'floor', keys: [code('Home')], label: 'Level the view' },
  { id: 'hire', group: 'floor', scope: 'floor', keys: [code('KeyH')], label: 'Hire a worker at the first free desk' },
  { id: 'issues', group: 'floor', scope: 'floor', keys: [code('KeyI')], label: 'Issues board' },
  { id: 'prs', group: 'floor', scope: 'floor', keys: [code('KeyG')], label: 'Pull requests board' },
  { id: 'run', group: 'floor', scope: 'floor', keys: [code('KeyR', { shift: true })], label: 'Start a run at the first free desk' },
  { id: 'elevator', group: 'floor', scope: 'floor', keys: [code('KeyL')], label: 'Elevator' },
  { id: 'plan', group: 'floor', scope: 'floor', keys: [code('Tab')], label: 'Floor plan' },
  { id: 'topbar', group: 'floor', scope: 'floor', keys: [code('Tab', { shift: true })], label: 'Into the top bar (then Tab and Enter)' },
  { id: 'leave', group: 'floor', scope: 'floor', keys: [code('Backspace')], label: 'Back to the city' },
  { id: 'select.clear', group: 'aimed', scope: 'selected', keys: [code('Escape')], label: 'Let go of what you picked (moving or turning does too)', quiet: true },
  { id: 'stand', group: 'floor', scope: 'sitting', keys: [code('Escape')], label: 'Get up from your desk', quiet: true },
  { id: 'plan.close', group: 'floor', scope: 'plan', keys: [code('Escape')], label: 'Close the floor plan', quiet: true },
  // ---- in the city ---------------------------------------------------------------------------------
  { id: 'buildings', group: 'city', scope: 'city', keys: [code('KeyM')], label: 'Buildings' },
  { id: 'city.tab', group: 'city', scope: 'city', keys: [code('Tab')], show: [['Tab'], ['Enter']], label: 'Tab reaches the floors, then the buildings; Enter goes inside', readonly: true },
  { id: 'city.unfocus', group: 'city', scope: 'city:focus', keys: [code('Escape')], label: 'Let go of the focused building', quiet: true },
  // ---- aimed at something (or picked with T) ------------------------------------------------------
  { id: 'select.next', group: 'aimed', scope: 'floor', keys: [code('KeyT')], label: 'Pick the next worker, desk or prop, and turn to it' },
  { id: 'select.prev', group: 'aimed', scope: 'floor', keys: [code('KeyT', { shift: true })], label: 'Pick the previous one' },
  { id: 'worker.sit', group: 'aimed', scope: 'aim:worker', keys: [code('KeyE')], label: 'Worker: sit at their laptop' },
  { id: 'worker.prompt', group: 'aimed', scope: 'aim:worker', keys: [code('KeyP')], label: 'Worker: send a prompt' },
  { id: 'worker.changes', group: 'aimed', scope: ['aim:worker', 'changes'], keys: [code('KeyC')], label: 'Worker: their Changes (again closes it)' },
  { id: 'worker.home', group: 'aimed', scope: 'aim:worker', keys: [code('KeyX')], label: 'Worker: send them home' },
  { id: 'worker.answer', group: 'aimed', scope: 'aim:worker', keys: DIGITS, show: [['1–9'], ['0']], label: 'Worker: answer their question with that choice; 0 denies' },
  { id: 'desk.hire', group: 'aimed', scope: 'aim:desk', keys: [code('KeyE')], label: 'Empty desk: hire here' },
  { id: 'own-desk.sit', group: 'aimed', scope: 'aim:own-desk', keys: [code('KeyE')], label: 'Your desk: sit down' },
  { id: 'board.open', group: 'aimed', scope: 'aim:board', keys: [code('KeyE')], label: 'Issues or pull requests board: open it' },
  { id: 'elevator.open', group: 'aimed', scope: 'aim:elevator', keys: [code('KeyE')], label: 'Elevator: ride' },
  { id: 'reception.open', group: 'aimed', scope: 'aim:reception', keys: [code('KeyE')], label: 'Reception: the floor directory' },
  { id: 'whiteboard.open', group: 'aimed', scope: 'aim:whiteboard', keys: [code('KeyE')], label: 'Whiteboard: draw' },
  { id: 'overview.open', group: 'aimed', scope: 'aim:overview', keys: [code('KeyE')], label: 'Lounge screen: the floor overview, growing out of it' },
  { id: 'radio.genre', group: 'aimed', scope: 'aim:radio', keys: [code('KeyE')], label: 'Radio: next genre' },
  { id: 'radio.track', group: 'aimed', scope: 'aim:radio', keys: [code('KeyR')], label: 'Radio: next track' },
  // ---- dialogs and fields (their own keys; listed so they are findable) ---------------------------
  { id: 'dialog.close', group: 'dialogs', scope: 'dialog', keys: [code('Escape')], label: 'Close the dialog', readonly: true },
  { id: 'dialog.submit', group: 'dialogs', scope: 'dialog', keys: [code('Enter', { mod: true })], label: 'Submit: hire, Start Run, open a pull request, a board comment', readonly: true },
  { id: 'dialog.send', group: 'dialogs', scope: 'dialog', keys: [code('Enter')], label: 'Send, in the conversation’s prompt box', readonly: true },
  { id: 'dialog.newline', group: 'dialogs', scope: 'dialog', keys: [code('Enter', { shift: true })], label: 'A new line, in the hire task and the prompt boxes', readonly: true },
  // #139: the composer's own keys while its suggestion list is open (ui/composer/completion.ts); Enter picks there too.
  { id: 'dialog.complete', group: 'dialogs', scope: 'dialog', keys: [code('ArrowUp'), code('ArrowDown'), code('Tab')], show: [['↑ ↓'], ['Tab']], label: 'In a prompt box’s suggestion list (after / or @): ↑ ↓ choose, Tab or Enter picks, Esc closes only the list', readonly: true },
  // ---- at a laptop (laptop/keys.ts; no help key here) ---------------------------------------------
  { id: 'seat.stand', group: 'laptop', scope: 'seated', keys: [code('Escape')], label: 'Stand up', readonly: true },
  { id: 'seat.view', group: 'laptop', scope: 'seated', keys: [code('Escape', { ctrl: true })], label: 'Terminal or conversation', readonly: true },
  { id: 'seat.overview', group: 'laptop', scope: 'seated', keys: [code('KeyO')], label: 'The floor overview, over the conversation (Esc comes back)', readonly: true },
  { id: 'seat.look', group: 'laptop', scope: 'seated', keys: [{ key: ',', ctrl: true }], label: 'The terminal’s preset and zoom controls', readonly: true },
  { id: 'seat.zoom', group: 'laptop', scope: 'seated', keys: [{ key: '=', ctrl: true }, { key: '-', ctrl: true }, { key: '0', ctrl: true }], show: [['Ctrl', '+'], ['Ctrl', '−'], ['Ctrl', '0']], label: 'Zoom in, out and back to 100%', readonly: true },
] as const satisfies readonly Binding[];

export type ActionId = (typeof BINDINGS)[number]['id'];
/** The ids the game dispatches (the `readonly` ones are only listed): `Game` has a handler for each, and the compiler checks it. */
export type DispatchedId = Exclude<(typeof BINDINGS)[number], { readonly: true }>['id'];

const asList = <T>(v: T | readonly T[]): readonly T[] => (Array.isArray(v) ? (v as readonly T[]) : [v as T]);
export const scopesOf = (b: Binding): readonly Scope[] => asList(b.scope);
export const groupsOf = (b: Binding): readonly Group[] => asList(b.group);

export function binding(id: ActionId): Binding {
  const b = BINDINGS.find((x) => x.id === id);
  if (!b) throw new Error(`no binding ${id}`);
  return b;
}

// ---- matching -----------------------------------------------------------------------------------------

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function isMac(): boolean {
  const n = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const p = n?.userAgentData?.platform ?? n?.platform ?? '';
  return /mac|iphone|ipad/i.test(p);
}

/** Does this keydown press exactly this chord? Modifiers are exact; Alt is never asked for. */
export function chordMatches(e: KeyEventLike, c: Chord, mac = isMac()): boolean {
  const wantMeta = !!c.mod && mac;
  const wantCtrl = !!c.ctrl || (!!c.mod && !mac);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey) return false;
  if (c.key !== undefined) return e.key === c.key; // the character carries its own Shift
  return e.code === c.code && e.shiftKey === !!c.shift;
}

export interface Match {
  binding: Binding;
  chord: Chord;
  /** The physical key pressed (a binding of several keys, such as the digits, says which). */
  code: string;
}

/**
 * The binding a keydown fires, or null. `active` is the set of scopes live right now (the game computes it from the
 * view, the target and what is open); `typing` says a text field has focus, when only a `typing` chord fires. The
 * first binding in table order wins among the live ones; the unit test keeps overlapping scopes from sharing a chord.
 */
export function findBinding(e: KeyEventLike, active: ReadonlySet<Scope>, typing: boolean, mac = isMac()): Match | null {
  if (composing(e)) return null;
  for (const b of BINDINGS as readonly Binding[]) {
    if (b.readonly || !scopesOf(b).some((s) => active.has(s))) continue;
    for (const c of b.keys) {
      if (typing && !c.typing) continue;
      if (chordMatches(e, c, mac)) return { binding: b, chord: c, code: e.code };
    }
  }
  return null;
}

/** A keydown that is part of an IME composition or a dead key: no shortcut (the same everywhere a binding is read). */
const composing = (e: KeyEventLike): boolean => !!e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified';

/** Does this keydown press the binding's key, whatever is live (for the few handlers that sit outside the dispatch)? Never during a composition. */
export function pressesBinding(e: KeyEventLike, id: ActionId, mac = isMac()): boolean {
  if (composing(e)) return false;
  return binding(id).keys.some((c) => chordMatches(e, c, mac));
}

// ---- names --------------------------------------------------------------------------------------------

/** `navigator.keyboard.getLayoutMap()` once it has answered: the key each physical code types on this layout. */
let layout: ReadonlyMap<string, string> | null = null;
const layoutListeners = new Set<() => void>();

/** Asks the browser for the layout map (Chromium, secure contexts; elsewhere the code names stand). Calls `then` when it answers. */
export function loadLayout(then?: () => void): void {
  if (then) layoutListeners.add(then);
  const kb = (globalThis.navigator as (Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }) | undefined)?.keyboard;
  if (!kb?.getLayoutMap) return;
  kb.getLayoutMap().then(
    (m) => {
      layout = m;
      for (const fn of layoutListeners) fn();
    },
    () => undefined,
  );
}

export function setLayoutForTest(m: ReadonlyMap<string, string> | null): void {
  layout = m;
}

const NAMES: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Enter',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** The name of a physical key as this keyboard labels it (the layout map), else from its code (`KeyH` → H). */
export function codeLabel(c: string): string {
  const typed = layout?.get(c);
  if (typed) return typed.length === 1 ? typed.toUpperCase() : typed;
  if (NAMES[c]) return NAMES[c];
  const k = /^Key(.)$/.exec(c) ?? /^Digit(\d)$/.exec(c);
  if (k?.[1]) return k[1];
  const n = /^Numpad(\d)$/.exec(c);
  return n ? `Num ${n[1]}` : c;
}

/** The keycaps of one chord: `['⌘', '/']`, `['Shift', 'R']`. `mac: 'both'` writes `Ctrl/⌘` (the docs, not tied to a platform). */
export function chordCaps(c: Chord, mac: boolean | 'both' = isMac()): string[] {
  const caps: string[] = [];
  if (c.ctrl) caps.push('Ctrl');
  if (c.mod) caps.push(mac === 'both' ? 'Ctrl/⌘' : mac ? '⌘' : 'Ctrl');
  if (c.shift) caps.push('Shift');
  caps.push(c.key !== undefined ? c.key : codeLabel(c.code ?? ''));
  return caps;
}

/** What the reference shows for a binding: its `show` override, else one list of caps per chord that is not a repeat of another. */
export function bindingCaps(b: Binding, mac: boolean | 'both' = isMac()): string[][] {
  if (b.show) return b.show.map((l) => [...l].map((cap) => (mac === 'both' ? cap : cap === 'Ctrl/⌘' ? (mac ? '⌘' : 'Ctrl') : cap)));
  return b.keys.map((c) => chordCaps(c, mac));
}

/** `Shift+R`: the first (non-field) chord of a binding as one string, for a title, a hint line or an aria-label. */
export function keyName(id: ActionId, mac: boolean | 'both' = isMac()): string {
  const b = binding(id);
  const first = b.keys.find((c) => !c.typing) ?? b.keys[0];
  return first ? chordCaps(first, mac).join('+') : '';
}

/** `Hire … (H)`. */
export const withKey = (text: string, id: ActionId): string => `${text} (${keyName(id)})`;

// ---- the reference, as data and as Markdown -----------------------------------------------------------

export interface ReferenceGroup {
  id: Group;
  title: string;
  note: string;
  entries: Array<{ id: string; label: string; caps: string[][]; readonly: boolean }>;
}

/** The groups of the reference, in order, each with its bindings: what the dialog and the docs both draw. */
export function reference(mac: boolean | 'both' = isMac()): ReferenceGroup[] {
  return GROUPS.map((g) => ({
    ...g,
    entries: (BINDINGS as readonly Binding[]).filter((b) => groupsOf(b).includes(g.id)).map((b) => ({ id: b.id, label: b.label, caps: bindingCaps(b, mac), readonly: !!b.readonly })),
  }));
}

/** docs/shortcuts.md: the same table, as Markdown (a test keeps the file in step; `H3D_WRITE_SHORTCUTS_DOC=1` rewrites it). */
export function shortcutsMarkdown(): string {
  const out: string[] = [
    '# Keyboard shortcuts',
    '',
    '<!-- Generated from game/src/input/shortcuts.ts by `game/src/input/shortcuts.test.ts`: edit the table there, then run `H3D_WRITE_SHORTCUTS_DOC=1 make game-test`. -->',
    '',
    'Press **?** in the game for the same list, with the keys named as your keyboard labels them (⌘ on a Mac, where this page says Ctrl/⌘).',
    '',
    'Single keys work only when the scene has the keyboard: they pause while a text field, a list or a dialog has it (WCAG 2.1.4). **Ctrl/⌘+/** opens the list from inside a field. Seated at a laptop every key goes to the terminal except the few below, and there is no help key there: **Esc**, then **?**.',
    '',
  ];
  for (const g of reference('both')) {
    out.push(`## ${g.title}`, '', g.note, '', '| Keys | Does |', '| --- | --- |');
    for (const e of g.entries) out.push(`| ${e.caps.map((l) => l.map((c) => `\`${c}\``).join(' + ')).join(' or ')} | ${e.label} |`);
    out.push('');
  }
  return out.join('\n');
}
