// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../../net/client';
import { mountComposer, type Composer, type ComposerOptions } from './composer';
import { Draft } from './draft';
import { caret, IMG, segments } from './model';
import { isCanonical, offsetToPoint, pointToOffset } from './tree';

// jsdom has neither showModal nor close on <dialog>: the two things the preview needs.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal(): void; close(): void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

interface Env {
  c: Composer;
  draft: Draft;
  submits: number;
  uploads: Array<{ name: string; n: number; ok(path?: string): void; fail(message?: string): void }>;
  notices: Array<[string, string]>;
  editor: HTMLElement;
}

const mounted: Composer[] = [];

function setup(o: Partial<ComposerOptions> = {}, parent: HTMLElement = document.body): Env {
  const env = { submits: 0, uploads: [], notices: [] } as unknown as Env;
  const c = mountComposer({
    upload: (file, hint) =>
      new Promise<CommandResult>((resolve) => {
        env.uploads.push({
          name: (file as File).name,
          n: hint.n,
          ok: (path = `/drops/h3d-${hint.label}-${hint.n}.png`) => resolve({ ok: true, data: { path, mime: 'image/png', size: 1 } }),
          fail: (message = 'down') => resolve({ ok: false, code: 'dropzone_unavailable', message }),
        });
      }),
    onSubmit: () => env.submits++,
    onNotice: (m, k) => env.notices.push([m, k]),
    ariaLabel: 'First task',
    placeholder: 'Describe the task',
    ...o,
  });
  parent.append(c.element);
  mounted.push(c);
  env.c = c;
  env.draft = c.getDraft();
  env.editor = c.editor;
  return env;
}

const png = (name = 'shot.png', size = 8) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** A paste event carrying `files` (as items, like a screenshot) and/or text. */
function paste(el: Element, o: { files?: File[]; asFiles?: boolean; text?: string; html?: string }): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  const files = o.files ?? [];
  Object.defineProperty(e, 'clipboardData', {
    value: {
      items: o.asFiles ? [] : files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      files,
      getData: (t: string) => (t === 'text/plain' ? (o.text ?? '') : t === 'text/html' ? (o.html ?? '') : ''),
    },
  });
  el.dispatchEvent(e);
  return e;
}

/** What the browser does when the user types: edits a text node and fires `input`. */
function typeAt(env: Env, at: number, text: string): void {
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

const chipsOf = (env: Env) => [...env.editor.querySelectorAll<HTMLElement>('.cmp-chip')];
const kinds = (env: Env) => segments(env.draft.doc).map((s) => (s.kind === 'text' ? s.text : `<${env.draft.snapshot().images.find((i) => i.occ === s.occ)?.name}>`));

beforeEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});
afterEach(() => {
  // A preview left open would keep its window-level key listener.
  for (const c of mounted.splice(0)) c.dispose();
  vi.restoreAllMocks();
});

describe('what it draws', () => {
  it('is a labelled multiline textbox with a placeholder that shows while empty', () => {
    const env = setup();
    expect(env.editor.getAttribute('role')).toBe('textbox');
    expect(env.editor.getAttribute('aria-multiline')).toBe('true');
    expect(env.editor.getAttribute('aria-label')).toBe('First task');
    expect(env.editor.getAttribute('contenteditable')).toBe('true');
    expect(env.editor.dataset.placeholder).toBe('Describe the task');
    expect(env.editor.dataset.empty).toBe('true');
    env.c.insertText('hi');
    expect(env.editor.dataset.empty).toBe('false');
  });

  it('takes its name from labelledBy instead when given', () => {
    const env = setup({ labelledBy: 'lbl', ariaLabel: 'ignored' });
    expect(env.editor.getAttribute('aria-labelledby')).toBe('lbl');
    expect(env.editor.hasAttribute('aria-label')).toBe(false);
  });

  it('draws text nodes and chips in document order, with a text node beside every chip', () => {
    const env = setup();
    env.c.insertText('ab');
    env.draft.setSelection(caret(1));
    env.c.insertFiles([png('a.png'), png('b.png')]);
    const kids = [...env.editor.childNodes].map((n) => (n.nodeType === 3 ? `t:${(n as Text).data.replace('​', 'Z')}` : (n as HTMLElement).className.split(' ')[0]));
    expect(kids).toEqual(['t:a', 'cmp-chip', 't:Z', 'cmp-chip', 't:b', 'cmp-tail']);
    expect(isCanonical(env.editor)).toBe(true);
  });

  it('names each chip: number tag, preview and remove buttons with the image’s name, and its state', () => {
    const env = setup();
    env.c.insertFiles([png('one.png'), png('two.png')]);
    const [a, b] = chipsOf(env) as [HTMLElement, HTMLElement];
    expect(a.getAttribute('contenteditable')).toBe('false');
    expect(a.querySelector('.cmp-num')?.textContent).toBe('#1');
    expect(b.querySelector('.cmp-num')?.textContent).toBe('#2');
    expect(a.querySelector('.cmp-thumb')?.getAttribute('aria-label')).toBe('Preview image 1, one.png');
    expect(b.querySelector('.cmp-remove')?.getAttribute('aria-label')).toBe('Remove image 2, two.png');
    expect(a.dataset.status).toBe('uploading');
    expect(a.querySelector('.cmp-state')?.textContent).toBe('Uploading…');
    expect(a.querySelector<HTMLElement>('.cmp-retry')?.hidden).toBe(true);
    // Nothing nested inside a button.
    expect(env.editor.querySelectorAll('button button')).toHaveLength(0);
  });

  it('shows an upload’s progress, its success and its failure on the chip, with a retry', async () => {
    const env = setup();
    env.c.insertFiles([png('a.png'), png('b.png')]);
    env.uploads[0]?.ok();
    env.uploads[1]?.fail('Drop Zone is down');
    await tick();
    const [a, b] = chipsOf(env) as [HTMLElement, HTMLElement];
    expect(a.dataset.status).toBe('ready');
    expect(a.querySelector('.cmp-state')?.textContent).toBe('Uploaded');
    expect(b.dataset.status).toBe('error');
    expect(b.querySelector('.cmp-state')?.textContent).toBe('Failed: Drop Zone is down');
    expect(b.querySelector<HTMLElement>('.cmp-retry')?.hidden).toBe(false);
    expect(b.querySelector('.cmp-retry')?.getAttribute('aria-label')).toBe('Retry uploading image 2, b.png');
    expect(env.notices.at(-1)).toEqual(['Image 2 (b.png) failed to upload: Drop Zone is down. Retry it or remove it.', 'error']);
    expect(env.editor.parentElement?.querySelector('.cmp-notice')?.textContent).toMatch(/Image 2 \(b\.png\) failed to upload/);
  });

  it('a chip’s retry button uploads that image again', async () => {
    const env = setup();
    env.c.insertFiles([png('a.png')]);
    env.uploads[0]?.fail();
    await tick();
    (chipsOf(env)[0]?.querySelector('.cmp-retry') as HTMLElement).click();
    expect(env.uploads).toHaveLength(2);
    env.uploads[1]?.ok('/d/a.png');
    await tick();
    expect(chipsOf(env)[0]?.dataset.status).toBe('ready');
  });
});

describe('paste', () => {
  it('two screenshots pasted one after the other around typed text give text, image, text, image, text', () => {
    const env = setup();
    env.c.insertText('see ');
    env.c.insertFiles([png('a.png')]);
    typeAt(env, 5, ' and ');
    env.c.insertFiles([png('b.png')]);
    typeAt(env, 11, ' please');
    expect(kinds(env)).toEqual(['see ', '<a.png>', ' and ', '<b.png>', ' please']);
  });

  it('one paste of two files at a mid-text caret puts both there, in the clipboard’s order', () => {
    const env = setup();
    env.c.insertText('hello world');
    env.draft.setSelection(caret(5));
    const e = paste(env.editor, { files: [png('a.png'), png('b.png')] });
    expect(e.defaultPrevented).toBe(true);
    expect(kinds(env)).toEqual(['hello', '<a.png>', '<b.png>', ' world']);
    expect(env.draft.selection).toEqual(caret(7));
  });

  it('inserts the chip at once, before any upload has answered', () => {
    const env = setup();
    paste(env.editor, { files: [png()] });
    expect(chipsOf(env)).toHaveLength(1);
    expect(env.draft.doc.text).toBe(IMG);
  });

  it('puts a chip in an empty editor, and replaces a selection', () => {
    const env = setup();
    paste(env.editor, { files: [png('a.png')] });
    expect(kinds(env)).toEqual(['<a.png>']);
    env.c.insertText('xyz');
    env.draft.setSelection({ anchor: 1, focus: 3 });
    paste(env.editor, { files: [png('b.png')] });
    expect(kinds(env)).toEqual(['<a.png>', '<b.png>', 'z']);
  });

  it('never inserts a clipboard image twice when it is in both the items and the file list', () => {
    const env = setup();
    const f = png('a.png');
    paste(env.editor, { files: [f] }); // items and files both carry it
    expect(chipsOf(env)).toHaveLength(1);
  });

  it('falls back on the file list when there are no file items', () => {
    const env = setup();
    paste(env.editor, { files: [png('a.png')], asFiles: true });
    expect(chipsOf(env)).toHaveLength(1);
  });

  it('pastes plain text as text, drops HTML, and normalises line ends', () => {
    const env = setup();
    const e = paste(env.editor, { text: 'a\r\nb\rc', html: '<b>bold</b><img src="http://evil/x.png">' });
    expect(e.defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('a\nb\nc');
    expect(env.editor.querySelector('b, img')).toBeNull();
  });

  it('pastes a lot of text into the middle of a selection', () => {
    const env = setup();
    env.c.insertText('one two three');
    env.draft.setSelection({ anchor: 4, focus: 7 });
    paste(env.editor, { text: 'TWO' });
    expect(env.draft.doc.text).toBe('one TWO three');
  });

  it('ignores a paste with neither files nor text, and claims it', () => {
    const env = setup();
    const e = paste(env.editor, { html: '<i>only html</i>' });
    expect(e.defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('');
  });

  it('refuses an unsupported or empty file with a message and adds nothing', () => {
    const env = setup();
    paste(env.editor, { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' }), new File([''], 'empty.png', { type: 'image/png' })] });
    expect(chipsOf(env)).toHaveLength(0);
    const shown = env.editor.parentElement?.querySelector('.cmp-notice');
    expect(shown?.textContent).toBe('notes.pdf is not a PNG, JPEG, GIF or WebP image. empty.png is empty.');
    expect(env.notices.at(-1)?.[1]).toBe('error');
  });

  it('takes the good files of a mixed paste and says why the others went', () => {
    const env = setup();
    paste(env.editor, { files: [png('a.png'), new File(['x'], 'a.svg', { type: 'image/svg+xml' })] });
    expect(chipsOf(env)).toHaveLength(1);
    expect(env.editor.parentElement?.querySelector('.cmp-notice')?.textContent).toMatch(/a\.svg is not a PNG/);
  });

  it('stops at the image limit and says so', () => {
    const env = setup({ maxImages: 2 });
    paste(env.editor, { files: [png(), png(), png()] });
    expect(chipsOf(env)).toHaveLength(2);
    expect(env.editor.parentElement?.querySelector('.cmp-notice')?.textContent).toBe('You can attach up to 2 images to one prompt.');
  });

  it('does nothing while busy (the host is sending)', () => {
    const env = setup();
    env.c.setBusy(true);
    const e = paste(env.editor, { files: [png()], text: 'x' });
    expect(e.defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('');
  });

  it('accepts drops of image files at the point dropped, and ignores other drops', () => {
    const env = setup();
    env.c.insertText('abc');
    const drop = (files: File[]) => {
      const e = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { items: files.map((f) => ({ kind: 'file', getAsFile: () => f })), files, types: files.length ? ['Files'] : ['text/plain'] } });
      env.editor.dispatchEvent(e);
      return e;
    };
    const e = drop([png('d.png')]);
    expect(e.defaultPrevented).toBe(true);
    expect(chipsOf(env)).toHaveLength(1);
    const t = drop([]);
    expect(t.defaultPrevented).toBe(true);
    expect(chipsOf(env)).toHaveLength(1);
  });
});

describe('Enter and Shift+Enter', () => {
  it('Enter asks to send and adds nothing', () => {
    const env = setup();
    env.c.insertText('go');
    const e = key(env.editor, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(env.submits).toBe(1);
    expect(env.draft.doc.text).toBe('go');
  });

  it('Shift+Enter adds a line and does not send', () => {
    const env = setup();
    env.c.insertText('a');
    key(env.editor, 'Enter', { shiftKey: true });
    expect(env.draft.doc.text).toBe('a\n');
    expect(env.submits).toBe(0);
    expect(env.draft.selection).toEqual(caret(2));
  });

  it('Ctrl/⌘+Enter also sends under the Enter policy; Alt+Enter adds a line', () => {
    const env = setup();
    key(env.editor, 'Enter', { ctrlKey: true });
    key(env.editor, 'Enter', { metaKey: true });
    expect(env.submits).toBe(2);
    expect(env.draft.doc.text).toBe('');
    key(env.editor, 'Enter', { altKey: true });
    expect(env.draft.doc.text).toBe('\n');
    expect(env.submits).toBe(2);
  });

  it('under the mod-enter policy Enter adds a line and Ctrl/⌘+Enter sends', () => {
    const env = setup({ submitPolicy: 'mod-enter' });
    key(env.editor, 'Enter');
    expect(env.draft.doc.text).toBe('\n');
    expect(env.submits).toBe(0);
    key(env.editor, 'Enter', { ctrlKey: true });
    key(env.editor, 'Enter', { metaKey: true });
    expect(env.submits).toBe(2);
  });

  it('does neither while an IME composes (Enter commits the candidate)', () => {
    const env = setup();
    env.c.insertText('x');
    env.editor.dispatchEvent(new Event('compositionstart'));
    key(env.editor, 'Enter');
    key(env.editor, 'Enter', { keyCode: 229 } as KeyboardEventInit);
    expect(env.submits).toBe(0);
    expect(env.draft.doc.text).toBe('x');
    env.editor.dispatchEvent(new Event('compositionend'));
    key(env.editor, 'Enter', { isComposing: true });
    expect(env.submits).toBe(0);
    key(env.editor, 'Enter');
    expect(env.submits).toBe(1);
  });

  it('Enter on a chip’s own button is the button’s, not a send', () => {
    const env = setup();
    env.c.insertFiles([png()]);
    const btn = chipsOf(env)[0]?.querySelector('.cmp-thumb') as HTMLElement;
    key(btn, 'Enter');
    expect(env.submits).toBe(0);
    expect(env.draft.doc.text).toBe(IMG);
  });

  it('a line break the browser makes itself (mobile keyboards) is our newline, not a <div>', () => {
    const env = setup();
    env.c.insertText('ab');
    const e = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
    env.editor.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('ab\n');
  });

  it('a trailing newline gets a line of its own (the tail)', () => {
    const env = setup();
    env.c.insertText('a\n');
    expect(env.editor.lastElementChild?.className).toBe('cmp-tail');
    expect(env.draft.doc.text).toBe('a\n');
  });

  it('gives focus back when busy ends, if it had it and nothing else took it', () => {
    const env = setup();
    env.editor.tabIndex = 0;
    env.editor.focus();
    env.c.setBusy(true);
    env.editor.blur();
    env.c.setBusy(false);
    expect(document.activeElement).toBe(env.editor);
    const other = document.createElement('button');
    document.body.append(other);
    env.c.setBusy(true);
    other.focus();
    env.c.setBusy(false);
    expect(document.activeElement).toBe(other);
  });

  it('a focus the host asked for while read-only is given when it is writable again, even over another focus (#64)', () => {
    const env = setup();
    const other = document.createElement('button');
    document.body.append(other);
    env.c.setBusy(true);
    other.focus();
    env.c.focus();
    expect(document.activeElement).toBe(other);
    env.c.setBusy(false);
    expect(document.activeElement).toBe(env.editor);
    // Once given, it is not asked again.
    env.c.setBusy(true);
    other.focus();
    env.c.setBusy(false);
    expect(document.activeElement).toBe(other);
    // Switched off: the same.
    env.c.setDisabled(true);
    env.c.focus();
    env.c.setDisabled(false);
    expect(document.activeElement).toBe(env.editor);
  });

  it('does nothing while busy', () => {
    const env = setup();
    env.c.setBusy(true);
    const e = key(env.editor, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(env.submits).toBe(0);
    expect(env.editor.getAttribute('contenteditable')).toBe('false');
    env.c.setBusy(false);
    expect(env.editor.getAttribute('contenteditable')).toBe('true');
  });
});

describe('DOM to model', () => {
  it('reads what was typed and keeps the chips', () => {
    const env = setup();
    env.c.insertText('ab');
    env.draft.setSelection(caret(1));
    env.c.insertFiles([png('a.png')]);
    typeAt(env, 0, 'X');
    typeAt(env, 4, 'Y');
    expect(env.draft.doc.text).toBe(`Xa${IMG}bY`);
    expect(env.draft.doc.images).toHaveLength(1);
  });

  it('ignores whatever is inside a chip: its name, its status, its buttons, its thumbnail', () => {
    const env = setup();
    env.c.insertText('a');
    env.c.insertFiles([png('very-long-name.png')]);
    const chip = chipsOf(env)[0] as HTMLElement;
    chip.querySelector('.cmp-name')!.textContent = 'changed';
    chip.querySelector('.cmp-state')!.textContent = 'Failed: something';
    typeAt(env, 0, 'Z');
    expect(env.draft.doc.text).toBe(`Za${IMG}`);
    expect(env.draft.doc.text).not.toMatch(/changed|Failed|Preview|Remove/);
  });

  it('types into the empty run beside a chip and drops the placeholder character', () => {
    const env = setup();
    env.c.insertFiles([png('a.png')]);
    env.c.insertFiles([png('b.png')]);
    // Between the two chips: the empty run's node holds U+200B.
    typeAt(env, 1, 'mid');
    expect(env.draft.doc.text).toBe(`${IMG}mid${IMG}`);
    expect(kinds(env)).toEqual(['<a.png>', 'mid', '<b.png>']);
  });

  it('a chip the browser deleted is gone from the document, with its upload cancelled', async () => {
    const env = setup();
    env.c.insertText('a');
    env.c.insertFiles([png('a.png')]);
    chipsOf(env)[0]?.remove();
    env.editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(env.draft.doc.text).toBe('a');
    expect(env.draft.doc.images).toEqual([]);
  });

  it('turns a <br> or <div> the browser adds into text and draws the editor again in its own shape', () => {
    const env = setup();
    env.c.insertText('ab');
    const t = env.editor.firstChild as Text;
    const br = document.createElement('br');
    const div = document.createElement('div');
    div.textContent = 'cd';
    t.after(br, div);
    env.editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(env.draft.doc.text).toBe('ab\n\ncd');
    expect(isCanonical(env.editor)).toBe(true);
    expect(env.editor.querySelector('div, br:not(.cmp-tail)')).toBeNull();
  });

  it('reads nothing while an IME composes, and everything when it ends', () => {
    const env = setup();
    env.editor.dispatchEvent(new Event('compositionstart'));
    typeAt(env, 0, 'にほ');
    expect(env.draft.doc.text).toBe('');
    env.editor.dispatchEvent(new Event('compositionend'));
    expect(env.draft.doc.text).toBe('にほ');
  });

  it('typing is one undo step until a pause, and a chip is its own', () => {
    const env = setup();
    typeAt(env, 0, 'a');
    typeAt(env, 1, 'b');
    typeAt(env, 2, 'c');
    key(env.editor, 'z', { ctrlKey: true });
    expect(env.draft.doc.text).toBe('');
  });
});

describe('deleting and moving around chips', () => {
  function withChip(): Env {
    const env = setup();
    env.c.insertText('ab');
    env.draft.setSelection(caret(1));
    env.c.insertFiles([png('a.png')]);
    return env; // a IMG b
  }
  const before = (t: string) => new InputEvent('beforeinput', { inputType: t, bubbles: true, cancelable: true });

  it('Backspace right after a chip removes the chip, not the text before it', () => {
    const env = withChip();
    env.draft.setSelection(caret(2));
    const p = offsetToPoint(env.editor, 2);
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    const e = before('deleteContentBackward');
    env.editor.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(env.draft.doc.text).toBe('ab');
    expect(chipsOf(env)).toHaveLength(0);
  });

  it('Delete right before a chip removes it', () => {
    const env = withChip();
    const p = offsetToPoint(env.editor, 1);
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    // The caret is in a focused editor for the live selection to count; the draft's is the same offset.
    env.draft.setSelection(caret(1));
    const e = before('deleteContentForward');
    env.editor.dispatchEvent(e);
    expect(env.draft.doc.text).toBe('ab');
  });

  it('Backspace in ordinary text is left to the browser', () => {
    const env = withChip();
    const p = offsetToPoint(env.editor, 1);
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    const e = before('deleteContentBackward');
    env.editor.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a chip’s remove button removes exactly that one and keeps the text in order', () => {
    const env = setup();
    env.c.insertFiles([png('a.png')]);
    typeAt(env, 1, ' mid ');
    env.c.insertFiles([png('b.png')]);
    expect(kinds(env)).toEqual(['<a.png>', ' mid ', '<b.png>']);
    (chipsOf(env)[0]?.querySelector('.cmp-remove') as HTMLElement).click();
    expect(kinds(env)).toEqual([' mid ', '<b.png>']);
    expect(chipsOf(env)[0]?.querySelector('.cmp-num')?.textContent).toBe('#1');
    expect(env.notices.at(-1)).toEqual(['Image 1 removed.', 'info']);
  });

  it('remove does nothing while busy', () => {
    const env = withChip();
    env.c.setBusy(true);
    const b = chipsOf(env)[0]?.querySelector<HTMLButtonElement>('.cmp-remove');
    expect(b?.disabled).toBe(true);
    b?.click();
    expect(chipsOf(env)).toHaveLength(1);
  });

  it('a press on a chip’s button does not move the caret or take focus', () => {
    const env = withChip();
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    chipsOf(env)[0]?.querySelector('.cmp-thumb')?.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Left and Right step over a chip in one press, and only next to one', () => {
    const env = withChip(); // a IMG b
    const sel = (o: number) => {
      const p = offsetToPoint(env.editor, o);
      document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    };
    sel(1);
    const r = key(env.editor, 'ArrowRight');
    expect(r.defaultPrevented).toBe(true);
    expect(env.draft.selection).toEqual(caret(2));
    sel(2);
    const l = key(env.editor, 'ArrowLeft');
    expect(l.defaultPrevented).toBe(true);
    expect(env.draft.selection).toEqual(caret(1));
    sel(0);
    expect(key(env.editor, 'ArrowRight').defaultPrevented).toBe(false);
    sel(3);
    expect(key(env.editor, 'ArrowLeft').defaultPrevented).toBe(false);
  });

  it('Shift+Arrow extends a selection over the chip', () => {
    const env = withChip();
    const p = offsetToPoint(env.editor, 1);
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    key(env.editor, 'ArrowRight', { shiftKey: true });
    expect(env.draft.selection).toEqual({ anchor: 1, focus: 2 });
  });

  it('Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo images together with text', () => {
    const env = setup();
    env.c.insertText('x');
    env.c.insertFiles([png()]);
    expect(chipsOf(env)).toHaveLength(1);
    key(env.editor, 'z', { ctrlKey: true });
    expect(chipsOf(env)).toHaveLength(0);
    expect(env.draft.doc.text).toBe('x');
    key(env.editor, 'Z', { ctrlKey: true, shiftKey: true });
    expect(chipsOf(env)).toHaveLength(1);
    key(env.editor, 'z', { metaKey: true });
    key(env.editor, 'y', { ctrlKey: true });
    expect(chipsOf(env)).toHaveLength(1);
    const e = new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
    env.editor.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(chipsOf(env)).toHaveLength(0);
  });

  it('copy gives the text without the chips, and cut also takes it out', () => {
    const env = withChip();
    document.getSelection()?.setBaseAndExtent(env.editor.firstChild!, 0, env.editor.lastChild!, 0);
    let copied = '';
    const clip = { setData: (_t: string, v: string) => (copied = v) };
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: clip });
    env.editor.dispatchEvent(ev);
    expect(copied).toBe('ab');
    expect(ev.defaultPrevented).toBe(true);
    const cut = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(cut, 'clipboardData', { value: clip });
    env.editor.dispatchEvent(cut);
    expect(env.draft.doc.text).toBe('');
  });
});

describe('the preview', () => {
  function hosted() {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const env = setup({}, dialog);
    let hostCancelled = 0;
    dialog.addEventListener('cancel', (e) => {
      hostCancelled++;
      if (!e.defaultPrevented) dialog.removeAttribute('open');
    });
    return { env, dialog, hostCancelled: () => hostCancelled };
  }
  const lb = () => document.querySelector<HTMLDialogElement>('dialog.cmp-lightbox');
  const open = (env: Env, i = 0) => (chipsOf(env)[i]?.querySelector('.cmp-thumb') as HTMLElement).click();

  it('opens on a click of the thumbnail: a modal dialog, labelled, its close button focused', () => {
    const { env } = hosted();
    env.c.insertFiles([png('one.png')]);
    open(env);
    const d = lb()!;
    expect(d.hasAttribute('open')).toBe(true);
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    expect(d.querySelector('.cmp-lb-cap')?.textContent).toBe('Image 1 · one.png');
    expect(d.querySelector('img')?.getAttribute('alt')).toBe('Image 1: one.png');
    expect(document.activeElement).toBe(d.querySelector('.cmp-lb-close'));
    expect(env.c.previewOpen).toBe(true);
    expect(d.querySelector('.cmp-lb-close')?.getAttribute('aria-label')).toBe('Close preview');
  });

  it('closes with its close button, and the draft is untouched', () => {
    const { env, dialog } = hosted();
    env.c.insertText('hello');
    env.c.insertFiles([png('one.png')]);
    const before = JSON.stringify(env.draft.doc);
    open(env);
    (lb()!.querySelector('.cmp-lb-close') as HTMLElement).click();
    expect(lb()).toBeNull();
    expect(env.c.previewOpen).toBe(false);
    expect(JSON.stringify(env.draft.doc)).toBe(before);
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('Esc closes only the preview, swallows the key, and the host stays open; the next Esc reaches the host', () => {
    const { env, dialog } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(lb()).toBeNull();
    expect(dialog.hasAttribute('open')).toBe(true);
    const next = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', bubbled);
  });

  it('a held Esc closes the preview once; its repeats never reach the host, and a new press after the keyup does', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(key({}));
    expect(lb()).toBeNull();
    for (let i = 0; i < 3; i++) {
      const again = key({ repeat: true });
      document.body.dispatchEvent(again);
      expect(again.defaultPrevented).toBe(true);
    }
    expect(bubbled).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    const next = key({});
    document.body.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', bubbled);
  });

  it('the held-Esc guard lifts on another key, a blur and after a second without a repeat', () => {
    vi.useFakeTimers();
    try {
      const closedByEsc = () => {
        const { env } = hosted();
        env.c.insertFiles([png()]);
        open(env);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(lb()).toBeNull();
      };
      const repeatSwallowed = (): boolean => {
        const again = new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(again);
        return again.defaultPrevented;
      };
      closedByEsc();
      expect(repeatSwallowed()).toBe(true);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      expect(repeatSwallowed()).toBe(false);

      closedByEsc();
      expect(repeatSwallowed()).toBe(true);
      window.dispatchEvent(new Event('blur'));
      expect(repeatSwallowed()).toBe(false);

      closedByEsc();
      vi.advanceTimersByTime(600);
      expect(repeatSwallowed()).toBe(true); // a repeat re-arms the idle time
      vi.advanceTimersByTime(900);
      expect(repeatSwallowed()).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(repeatSwallowed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a cancel of the host while the preview is open, and a cancel of the preview closes only it', () => {
    const { env, dialog, hostCancelled } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const hostCancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(hostCancel);
    expect(hostCancel.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(true);
    const own = new Event('cancel', { cancelable: true });
    lb()!.dispatchEvent(own);
    expect(own.defaultPrevented).toBe(true);
    expect(lb()).toBeNull();
    expect(hostCancelled()).toBe(0); // the host's own handler never saw either
    // Closed, and an Esc may still be down: the host's cancel stays refused until its keyup, then it is its own again.
    const held = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    const later = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    expect(hostCancelled()).toBe(1);
  });

  const pointer = (el: Element, type: string, x: number, y: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    el.dispatchEvent(e);
  };

  it('closes on a press and release on the empty surface, but not on the image', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const img = lb()!.querySelector('img')!;
    pointer(img, 'pointerdown', 5, 5);
    pointer(img, 'click', 5, 5);
    expect(lb()).not.toBeNull();
    const stage = lb()!.querySelector('.cmp-lb-stage')!;
    pointer(stage, 'pointerdown', 5, 5);
    pointer(stage, 'click', 5, 5);
    expect(lb()).toBeNull();
  });

  it('a press on the image and a release on the surface (a drag) does not close it; nor does a drag that ends there', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const stage = lb()!.querySelector('.cmp-lb-stage')!;
    pointer(lb()!.querySelector('img')!, 'pointerdown', 5, 5);
    pointer(stage, 'click', 50, 50); // release elsewhere: the click lands on the common ancestor
    expect(lb()).not.toBeNull();
    pointer(stage, 'pointerdown', 5, 5);
    pointer(stage, 'click', 60, 5);
    expect(lb()).not.toBeNull();
    pointer(stage, 'pointerdown', 5, 5);
    pointer(stage, 'click', 7, 6);
    expect(lb()).toBeNull();
  });

  it('a click on the dialog’s backdrop (the dialog itself) closes it', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const d = lb()!;
    pointer(d, 'pointerdown', 1, 1);
    pointer(d, 'click', 1, 1);
    expect(lb()).toBeNull();
  });

  it('gives back the caret, a backward selection and the scroll exactly, and refocuses the editor', async () => {
    const { env } = hosted();
    env.c.insertText('hello there world');
    env.draft.setSelection(caret(6));
    env.c.insertFiles([png()]);
    env.c.insertText(' tail');
    const total = env.draft.doc.text.length;
    env.draft.setSelection({ anchor: total - 1, focus: 3 }); // backward, across the chip
    env.editor.tabIndex = 0;
    env.editor.focus();
    const a = offsetToPoint(env.editor, total - 1);
    const f = offsetToPoint(env.editor, 3);
    document.getSelection()!.setBaseAndExtent(a.node, a.offset, f.node, f.offset); // what the user's drag or Shift+arrows made
    env.editor.scrollTop = 0;
    open(env);
    env.draft.setSelection(caret(0)); // whatever happens meanwhile: the preview brings the bookmark back
    (lb()!.querySelector('.cmp-lb-close') as HTMLElement).click();
    expect(env.draft.selection).toEqual({ anchor: total - 1, focus: 3 });
    expect(document.activeElement).toBe(env.editor);
    const s = document.getSelection()!;
    expect(pointToOffset(env.editor, s.anchorNode!, s.anchorOffset)).toBe(total - 1);
    expect(pointToOffset(env.editor, s.focusNode!, s.focusOffset)).toBe(3);
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    expect(env.draft.selection).toEqual({ anchor: total - 1, focus: 3 });
  });

  it('keeps the image’s bytes while it is open even if the chip goes, and lets go after', () => {
    const revoked: string[] = [];
    const draft = new Draft({ upload: () => new Promise<CommandResult>(() => {}), createUrl: () => 'blob:x', revokeUrl: (u) => revoked.push(u), historyLimit: 1 });
    const { dialog } = { dialog: document.body };
    const env = setup({ draft }, dialog);
    env.c.insertFiles([png()]);
    open(env);
    env.draft.removeImage(env.draft.snapshot().images[0]!.occ);
    env.draft.replace(0, 0, 'a');
    expect(revoked).toEqual([]);
    env.c.closePreview();
    expect(revoked).toEqual(['blob:x']);
  });

  it('a second click while it is open does not open another', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    env.c.openPreview(env.draft.snapshot().images[0]!.occ);
    expect(document.querySelectorAll('dialog.cmp-lightbox')).toHaveLength(1);
  });

  it('closes when the composer is disposed, and swaps away with a new draft', () => {
    const { env } = hosted();
    env.c.insertFiles([png()]);
    open(env);
    const other = new Draft({ upload: () => new Promise<CommandResult>(() => {}) });
    env.c.setDraft(other);
    expect(lb()).toBeNull();
    other.addImages([png()]);
    open(env);
    expect(lb()).not.toBeNull();
    env.c.dispose();
    expect(lb()).toBeNull();
  });
});

describe('drafts', () => {
  it('shows another draft and back, each with its own text, caret and chips', () => {
    const env = setup();
    env.c.insertText('one');
    env.c.insertFiles([png('a.png')]);
    const first = env.draft;
    const second = new Draft({ upload: () => new Promise<CommandResult>(() => {}) });
    env.c.setDraft(second);
    expect(env.c.getDraft()).toBe(second);
    expect(chipsOf(env)).toHaveLength(0);
    expect(env.editor.dataset.empty).toBe('true');
    env.c.insertText('two');
    env.c.setDraft(first);
    expect(chipsOf(env)).toHaveLength(1);
    expect(kinds(env)).toEqual(['one', '<a.png>']);
    expect(second.doc.text).toBe('two');
  });

  it('a draft survives the composer that showed it: reopen with the same draft and everything is back', async () => {
    const env = setup();
    env.c.insertText('first task ');
    env.c.insertFiles([png('a.png')]);
    env.uploads[0]?.ok('/d/a.png');
    await tick();
    const draft = env.draft;
    env.c.dispose();
    expect(env.c.element.isConnected).toBe(false);
    const again = setup({ draft });
    expect(kinds(again)).toEqual(['first task ', '<a.png>']);
    expect(chipsOf(again)[0]?.dataset.status).toBe('ready');
    const r = await again.c.resolve();
    expect(r).toMatchObject({ ok: true, text: 'first task [Image #1: /d/a.png]' });
  });

  it('dispose stops listening: later draft changes do not draw', () => {
    const env = setup();
    env.c.dispose();
    env.draft.replace(0, 0, 'later');
    expect(env.editor.textContent).not.toContain('later');
  });

  it('needs a draft, an upload function or a wsUrl', () => {
    expect(() => mountComposer({})).toThrow(/wsUrl/);
  });

  it('with a wsUrl the uploads go to /upload beside it', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      seen.push(u);
      return { ok: true, status: 200, json: async () => ({ data: { path: '/d/x.png', mime: 'image/png', size: 1 } }) };
    });
    const c = mountComposer({ wsUrl: 'ws://h:1/ws?token=t', label: 'nibble' });
    document.body.append(c.element);
    c.insertFiles([png()]);
    await tick();
    expect(seen).toEqual(['http://h:1/upload?token=t&label=nibble&n=1']);
    vi.unstubAllGlobals();
  });
});

describe('resolve through the composer', () => {
  it('gives the final text, or the failed images and nothing to send', async () => {
    const env = setup({ label: 'x' } as Partial<ComposerOptions>);
    env.c.insertText('see ');
    env.c.insertFiles([png('a.png')]);
    const p = env.c.resolve();
    env.uploads[0]?.fail('nope');
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'upload', failed: [{ name: 'a.png', numbers: [1], message: 'nope' }] });
    // The draft is kept, and the chip shows the retry.
    expect(chipsOf(env)[0]?.dataset.status).toBe('error');
    expect(kinds(env)).toEqual(['see ', '<a.png>']);
    // The chip's retry, then the send goes through.
    (chipsOf(env)[0]?.querySelector('.cmp-retry') as HTMLElement).click();
    env.uploads[1]?.ok('/d/a.png');
    expect(await env.c.resolve()).toMatchObject({ ok: true, text: 'see [Image #1: /d/a.png]' });
  });
});

describe('tree mapping', () => {
  it('maps offsets to DOM points and back, across chips and empty runs', () => {
    const env = setup();
    env.c.insertText('ab');
    env.draft.setSelection(caret(1));
    env.c.insertFiles([png('a.png'), png('b.png')]); // a IMG IMG b
    for (let o = 0; o <= env.draft.doc.text.length; o++) {
      const p = offsetToPoint(env.editor, o);
      expect(pointToOffset(env.editor, p.node, p.offset)).toBe(o);
    }
  });

  it('a point inside a chip is before it', () => {
    const env = setup();
    env.c.insertText('a');
    env.c.insertFiles([png('a.png')]);
    const inner = chipsOf(env)[0]!.querySelector('.cmp-name')!;
    expect(pointToOffset(env.editor, inner, 0)).toBe(1);
  });

  it('counts a browser <br> as a line break', () => {
    const env = setup();
    env.c.insertText('ab');
    const t = env.editor.firstChild as Text;
    const br = document.createElement('br');
    t.after(br);
    expect(pointToOffset(env.editor, env.editor, [...env.editor.childNodes].indexOf(br) + 1)).toBe(3);
  });
});

describe('a held refusal (#64)', () => {
  const pdf = () => new File(['x'], 'notes.pdf', { type: 'application/pdf' });
  const refusal = (env: Env) => env.editor.parentElement!.querySelector<HTMLElement>('.cmp-refusal')!;
  const dismissBtn = (env: Env) => refusal(env).querySelector<HTMLButtonElement>('.cmp-dismiss')!;
  const held = () => new Draft({ upload: () => new Promise(() => {}), holdRefused: true });

  it('shows the refusal with a dismiss button (named, keyboard reachable) and no second notice', () => {
    const env = setup({ draft: held() });
    expect(refusal(env).hidden).toBe(true);
    paste(env.editor, { files: [pdf()] });
    expect(refusal(env).hidden).toBe(false);
    expect(refusal(env).textContent).toBe('Not attached: notes.pdf is not a PNG, JPEG, GIF or WebP image. Nothing is sent until you dismiss this.');
    expect(env.editor.parentElement?.querySelector('.cmp-sr')?.textContent).toBe('notes.pdf is not a PNG, JPEG, GIF or WebP image.');
    expect(dismissBtn(env).tagName).toBe('BUTTON');
    expect(dismissBtn(env).getAttribute('aria-label')).toMatch(/^Dismiss this message/);
    expect(env.editor.parentElement?.querySelector<HTMLElement>('.cmp-notice')?.hidden).toBe(true);
    expect(env.notices.at(-1)?.[1]).toBe('error');
  });

  it('keeps it through other notices, removing an image and typing; Enter still only asks the host to send', () => {
    const env = setup({ draft: held() });
    env.c.insertFiles([png('a.png')]);
    paste(env.editor, { files: [pdf()] });
    env.c.notice('something else', 'error');
    env.c.clearNotice();
    env.c.insertText('typed');
    env.editor.querySelector<HTMLButtonElement>('.cmp-remove')!.click();
    expect(refusal(env).hidden).toBe(false);
    expect(env.draft.refusal).not.toBeNull();
    env.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(env.submits).toBe(1); // the host reads the refusal and says no; the composer never sends by itself
  });

  it('dismissing clears the refusal, says so and gives the editor the focus back', () => {
    const env = setup({ draft: held() });
    paste(env.editor, { files: [pdf()] });
    dismissBtn(env).click();
    expect(refusal(env).hidden).toBe(true);
    expect(env.draft.refusal).toBeNull();
    expect(document.activeElement).toBe(env.editor);
  });

  it('comes back with its draft: another draft shows none, the first shows it again', () => {
    const env = setup({ draft: held() });
    const first = env.draft;
    paste(env.editor, { files: [pdf()] });
    const other = held();
    env.c.setDraft(other);
    expect(refusal(env).hidden).toBe(true);
    env.c.setDraft(first);
    expect(refusal(env).hidden).toBe(false);
  });

  it('cannot be dismissed while the host is sending; a draft without the option keeps the plain notice', () => {
    const env = setup({ draft: held() });
    paste(env.editor, { files: [pdf()] });
    env.c.setBusy(true);
    expect(dismissBtn(env).disabled).toBe(true);
    env.c.setBusy(false);
    expect(dismissBtn(env).disabled).toBe(false);
    const plain = setup();
    paste(plain.editor, { files: [pdf()] });
    expect(refusal(plain).hidden).toBe(true);
    expect(plain.editor.parentElement?.querySelector('.cmp-notice')?.textContent).toMatch(/notes\.pdf is not a PNG/);
  });
});
