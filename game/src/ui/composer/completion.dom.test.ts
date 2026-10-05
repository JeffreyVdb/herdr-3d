// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../net/client';
import type { Source } from './complete';
import { mountComposer, type Composer, type ComposerOptions } from './composer';
import { Draft } from './draft';
import { caret, IMG } from './model';
import { offsetToPoint } from './tree';

// #139: the completion popup, driven like the composer's own tests: text typed into the DOM and an `input` event,
// keys dispatched on the editor, the caret moved and `selectionchange` sent (jsdom sends none of its own).

const COMMANDS = ['help', 'hello', 'clear', 'compact'];

/** A sync `/` source: the commands that start with the query. */
const slash = (): Source<string> & { asked: string[] } => {
  const asked: string[] = [];
  return {
    trigger: '/',
    label: 'Commands',
    asked,
    items: (q) => {
      asked.push(q);
      return COMMANDS.filter((c) => c.startsWith(q));
    },
    render: (c) => `/${c}`,
    insert: (c) => ({ text: `/${c} ` }),
  };
};

interface Pending {
  query: string;
  signal: AbortSignal;
  resolve(items: string[]): void;
  reject(e: unknown): void;
}

/** An async `@` source answered by the test. */
const at = (): Source<string> & { pending: Pending[] } => {
  const pending: Pending[] = [];
  return {
    trigger: '@',
    label: 'Files',
    pending,
    items: (query, signal) => new Promise<readonly string[]>((resolve, reject) => pending.push({ query, signal, resolve, reject })),
    render: (f) => f,
    insert: (f) => ({ text: `@${f} ` }),
  };
};

interface Env {
  c: Composer;
  draft: Draft;
  editor: HTMLElement;
  submits: number;
}

const mounted: Composer[] = [];

function setup(o: Partial<ComposerOptions> = {}): Env {
  const env = { submits: 0 } as Env;
  const c = mountComposer({
    upload: () => new Promise<CommandResult>(() => {}),
    onSubmit: () => env.submits++,
    ariaLabel: 'Prompt',
    ...o,
  });
  document.body.append(c.element);
  mounted.push(c);
  c.editor.focus();
  Object.assign(env, { c, draft: c.getDraft(), editor: c.editor });
  return env;
}

/** The browser typing at the caret: the text goes into the DOM, the caret after it, then `input`. */
function type(env: Env, text: string): void {
  const at = env.draft.selection.focus;
  const p = offsetToPoint(env.editor, at);
  const node = p.node as Text;
  if (node.nodeType === Node.TEXT_NODE) {
    node.insertData(p.offset, text);
    document.getSelection()?.setBaseAndExtent(node, p.offset + text.length, node, p.offset + text.length);
  } else {
    const t = document.createTextNode(text);
    node.insertBefore(t, node.childNodes[p.offset] ?? null);
    document.getSelection()?.setBaseAndExtent(t, text.length, t, text.length);
  }
  env.editor.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The caret put somewhere else (a click, an arrow the browser handled), as the browser reports it. */
function moveTo(env: Env, offset: number): void {
  const p = offsetToPoint(env.editor, offset);
  document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
  document.dispatchEvent(new Event('selectionchange'));
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

const pop = (env: Env) => env.c.element.querySelector<HTMLElement>('.cmp-pop');
const open = (env: Env) => pop(env) !== null && !pop(env)!.hidden;
const rows = (env: Env) => [...env.c.element.querySelectorAll<HTMLElement>('[role="option"]')];
const labels = (env: Env) => rows(env).map((r) => r.textContent);
const active = (env: Env) => rows(env).find((r) => r.getAttribute('aria-selected') === 'true')?.textContent ?? null;
const status = (env: Env) => {
  const s = env.c.element.querySelector<HTMLElement>('.cmp-pop-status');
  return s && !s.hidden ? s.textContent : null;
};
const ARIA = ['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant'];
const aria = (env: Env) => Object.fromEntries(ARIA.map((a) => [a, env.editor.getAttribute(a)]));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});
afterEach(() => {
  for (const c of mounted.splice(0)) c.dispose();
});

describe('opt-in', () => {
  it('without `complete` nothing changes: no popup, no attributes, Enter sends', () => {
    const env = setup();
    type(env, '/he');
    expect(pop(env)).toBeNull();
    expect(env.c.element.className).toBe('cmp');
    expect(aria(env)).toEqual(Object.fromEntries(ARIA.map((a) => [a, null])));
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });

  it('with no sources (the transcript for now) no popup ever opens and the DOM stays as it was', () => {
    const env = setup({ complete: { sources: [] } });
    type(env, '/he @x');
    expect(pop(env)).toBeNull();
    expect(env.c.element.className).toBe('cmp');
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });

  it('a trigger without a source does not open', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '@x');
    expect(open(env)).toBe(false);
  });
});

describe('opening', () => {
  it('/ at the start opens an accessible listbox; the editor points at it', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/');
    expect(open(env)).toBe(true);
    const list = env.c.element.querySelector('[role="listbox"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Commands');
    expect(labels(env)).toEqual(['/help', '/hello', '/clear', '/compact']);
    expect(rows(env).every((r) => r.id && !r.hasAttribute('tabindex'))).toBe(true);
    expect(active(env)).toBe('/help');
    expect(aria(env)).toEqual({ 'aria-autocomplete': 'list', 'aria-controls': list.id, 'aria-expanded': 'true', 'aria-activedescendant': rows(env)[0]!.id });
    expect(env.editor.getAttribute('role')).toBe('textbox');
  });

  it('filters as the query grows, and says "No match" for nothing', () => {
    const src = slash();
    const env = setup({ complete: { sources: [src] } });
    type(env, '/he');
    expect(labels(env)).toEqual(['/help', '/hello']);
    type(env, 'z');
    expect(labels(env)).toEqual([]);
    expect(status(env)).toBe('No match');
    expect(open(env)).toBe(true);
    expect(src.asked).toEqual(['he', 'hez']);
  });

  it('opens after a space and after an image chip, never mid-word', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, 'a/');
    expect(open(env)).toBe(false);
    type(env, ' /');
    expect(open(env)).toBe(true);
  });

  it('opens right after an image chip', () => {
    const env = setup({ complete: { sources: [slash()] } });
    env.c.insertFiles([new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })]);
    expect(env.draft.doc.text).toBe(IMG);
    type(env, '/cl');
    expect(env.draft.doc.text).toBe(`${IMG}/cl`);
    expect(labels(env)).toEqual(['/clear']);
  });

  it('a caret moved back into a token does not reopen it; typing does', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/he');
    key(env.editor, 'Escape');
    expect(open(env)).toBe(false);
    moveTo(env, 2);
    expect(open(env)).toBe(false);
    type(env, 'l');
    expect(open(env)).toBe(true);
  });
});

describe('keys while open', () => {
  it('↑ and ↓ move the active row and wrap around', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/');
    expect(key(env.editor, 'ArrowDown').defaultPrevented).toBe(true);
    expect(active(env)).toBe('/hello');
    key(env.editor, 'ArrowDown');
    key(env.editor, 'ArrowDown');
    expect(active(env)).toBe('/compact');
    key(env.editor, 'ArrowDown');
    expect(active(env)).toBe('/help');
    key(env.editor, 'ArrowUp');
    expect(active(env)).toBe('/compact');
    expect(env.editor.getAttribute('aria-activedescendant')).toBe(rows(env)[3]!.id);
  });

  it('Enter picks the active row and does not send; the caret lands after the text', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, 'run /he');
    key(env.editor, 'ArrowDown');
    expect(key(env.editor, 'Enter').defaultPrevented).toBe(true);
    expect(env.submits).toBe(0);
    expect(env.draft.doc.text).toBe('run /hello ');
    expect(env.draft.selection).toEqual(caret(11));
    expect(open(env)).toBe(false);
    expect(aria(env)).toEqual(Object.fromEntries(ARIA.map((a) => [a, null])));
  });

  it('Tab picks too; the pick replaces the whole word the caret is in', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/hexx');
    moveTo(env, 3);
    type(env, 'l');
    expect(env.draft.doc.text).toBe('/helxx');
    expect(labels(env)).toEqual(['/help', '/hello']);
    expect(key(env.editor, 'Tab').defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('/help ');
  });

  it('one undo takes the pick back, redo puts it again', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, 'go /cl');
    key(env.editor, 'Enter');
    expect(env.draft.doc.text).toBe('go /clear ');
    key(env.editor, 'z', { ctrlKey: true });
    expect(env.draft.doc.text).toBe('go /cl');
    expect(open(env)).toBe(false);
    key(env.editor, 'z', { ctrlKey: true, shiftKey: true });
    expect(env.draft.doc.text).toBe('go /clear ');
  });

  it('Esc closes the popup only: nothing outside the editor sees it', () => {
    const env = setup({ complete: { sources: [slash()] } });
    const outside: string[] = [];
    document.body.addEventListener('keydown', (e) => outside.push(e.key));
    type(env, '/');
    const e = key(env.editor, 'Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(open(env)).toBe(false);
    expect(outside).toEqual([]);
    // Closed: Esc is the host's again, and Enter sends.
    key(env.editor, 'Escape');
    expect(outside).toEqual(['Escape']);
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });

  it('Enter with nothing to pick closes the popup and sends nothing', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/zz');
    expect(status(env)).toBe('No match');
    key(env.editor, 'Enter');
    expect(env.submits).toBe(0);
    expect(open(env)).toBe(false);
    expect(env.draft.doc.text).toBe('/zz');
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });

  it('Shift+Enter is untouched: a new line, and the popup closes', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/he');
    key(env.editor, 'Enter', { shiftKey: true });
    expect(env.draft.doc.text).toBe('/he\n');
    expect(env.submits).toBe(0);
    expect(open(env)).toBe(false);
  });

  it('closed, the keys are the editor’s: arrows and Tab are not taken, Enter sends', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, 'hi');
    expect(key(env.editor, 'ArrowDown').defaultPrevented).toBe(false);
    expect(key(env.editor, 'Tab').defaultPrevented).toBe(false);
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });
});

describe('mouse', () => {
  it('a press on the popup keeps the focus; a click picks', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/c');
    const row = rows(env)[1]!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(env.draft.doc.text).toBe('/compact ');
    expect(document.activeElement).toBe(env.editor);
  });
});

describe('closing', () => {
  it('when the caret leaves the token', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, 'x /he');
    expect(open(env)).toBe(true);
    // Back to just after the trigger: still in the token, the query is shorter.
    moveTo(env, 3);
    expect(open(env)).toBe(true);
    expect(labels(env)).toEqual(['/help', '/hello', '/clear', '/compact']);
    moveTo(env, 1);
    expect(open(env)).toBe(false);
  });

  it('on blur', () => {
    const env = setup({ complete: { sources: [slash()] } });
    const other = document.body.appendChild(document.createElement('button'));
    type(env, '/');
    other.focus();
    expect(open(env)).toBe(false);
  });

  it('when the editor turns busy or disabled', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/');
    env.c.setBusy(true);
    expect(open(env)).toBe(false);
    env.c.setBusy(false);
    env.editor.focus();
    type(env, 'h');
    expect(open(env)).toBe(true);
    env.c.setDisabled(true);
    expect(open(env)).toBe(false);
  });

  it('on another draft and on dispose', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/');
    env.c.setDraft(new Draft({ upload: () => new Promise(() => {}) }));
    expect(open(env)).toBe(false);
    type(env, '/');
    expect(open(env)).toBe(true);
    const el = env.c.element;
    env.c.dispose();
    expect(el.querySelector('.cmp-pop')).toBeNull();
  });

  it('survives a redraw of the draft that keeps the caret in the token', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/he');
    env.draft.replace(3, 3, 'l');
    expect(env.editor.textContent).toBe('/hel');
    expect(open(env)).toBe(true);
    expect(labels(env)).toEqual(['/help', '/hello']);
    key(env.editor, 'Enter');
    expect(env.draft.doc.text).toBe('/help ');
  });
});

describe('an async source', () => {
  it('shows loading, then the rows', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@sr');
    expect(open(env)).toBe(true);
    expect(status(env)).toBe('Loading…');
    expect(env.c.element.querySelector('[role="listbox"]')!.getAttribute('aria-busy')).toBe('true');
    src.pending[0]!.resolve(['src/a.ts', 'src/My Doc.md']);
    await flush();
    expect(labels(env)).toEqual(['src/a.ts', 'src/My Doc.md']);
    expect(status(env)).toBeNull();
    key(env.editor, 'ArrowDown');
    key(env.editor, 'Tab');
    expect(env.draft.doc.text).toBe('@src/My Doc.md ');
  });

  it('a query with spaces stays in the token', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@my f');
    expect(src.pending.map((p) => p.query)).toEqual(['my f']);
  });

  it('a late reply is dropped and its signal aborted; the latest wins', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@a');
    type(env, 'b');
    const [first, second] = src.pending as [Pending, Pending];
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    second.resolve(['ab.ts']);
    await flush();
    first.resolve(['a-late.ts']);
    await flush();
    expect(labels(env)).toEqual(['ab.ts']);
  });

  it('keeps the rows it has, dimmed, while the next query loads', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@a');
    src.pending[0]!.resolve(['a.ts']);
    await flush();
    type(env, 'b');
    expect(labels(env)).toEqual(['a.ts']);
    expect(env.c.element.querySelector('[role="listbox"]')!.hasAttribute('data-loading')).toBe(true);
    expect(status(env)).toBeNull();
  });

  it('a rejected reply says so and is not stuck loading; Enter then sends nothing', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@x');
    src.pending[0]!.reject(new Error('down'));
    await flush();
    expect(status(env)).toBe('Could not load matches.');
    expect(env.c.element.querySelector('[role="listbox"]')!.getAttribute('aria-busy')).toBe('false');
    key(env.editor, 'Enter');
    expect(env.submits).toBe(0);
    expect(open(env)).toBe(false);
  });

  it('a reply after the popup closed is dropped', async () => {
    const src = at();
    const env = setup({ complete: { sources: [src] } });
    type(env, '@x');
    key(env.editor, 'Escape');
    expect(src.pending[0]!.signal.aborted).toBe(true);
    src.pending[0]!.resolve(['x.ts']);
    await flush();
    expect(open(env)).toBe(false);
    expect(rows(env)).toEqual([]);
  });

  it('a source that throws shows the failure', () => {
    const env = setup({
      complete: {
        sources: [{ trigger: '/', items: () => { throw new Error('bad'); }, render: String, insert: () => ({ text: '' }) }],
      },
    });
    type(env, '/');
    expect(status(env)).toBe('Could not load matches.');
  });
});

describe('IME', () => {
  it('no popup while composing; it opens when the composition commits', () => {
    const env = setup({ complete: { sources: [slash()] } });
    env.editor.dispatchEvent(new Event('compositionstart'));
    type(env, '/');
    expect(open(env)).toBe(false);
    // Enter and the arrows commit or pick the candidate: never the popup's, nothing sent.
    key(env.editor, 'Enter', { isComposing: true });
    key(env.editor, 'ArrowDown', { keyCode: 229 } as KeyboardEventInit);
    expect(env.submits).toBe(0);
    env.editor.dispatchEvent(new Event('compositionend'));
    expect(open(env)).toBe(true);
    expect(env.draft.doc.text).toBe('/');
  });

  it('a composition that starts in an open token closes the popup and does not disturb the text', () => {
    const env = setup({ complete: { sources: [slash()] } });
    type(env, '/he');
    env.editor.dispatchEvent(new Event('compositionstart'));
    expect(open(env)).toBe(false);
    type(env, 'l');
    document.dispatchEvent(new Event('selectionchange'));
    expect(open(env)).toBe(false);
    expect(key(env.editor, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
    env.editor.dispatchEvent(new Event('compositionend'));
    expect(env.draft.doc.text).toBe('/hel');
    expect(labels(env)).toEqual(['/help', '/hello']);
  });
});

describe('the same draft in a composer without completion (the hire dialog, the P overlay)', () => {
  it('opens nothing there and leaves nothing behind', () => {
    const draft = new Draft({ upload: () => new Promise(() => {}) });
    const withIt = setup({ draft, complete: { sources: [slash()] } });
    type(withIt, '/');
    expect(open(withIt)).toBe(true);
    withIt.c.dispose();
    const plain = setup({ draft });
    plain.editor.focus();
    moveTo(plain, 1);
    type(plain, 'h');
    expect(draft.doc.text).toBe('/h');
    expect(document.querySelector('.cmp-pop')).toBeNull();
    expect(plain.editor.hasAttribute('aria-expanded')).toBe(false);
    key(plain.editor, 'Enter');
    expect(plain.submits).toBe(1);
  });
});
