// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Floor, HireInterpretation, Snapshot } from '../net/protocol';
import { WorldStore } from '../world/store';
import { DictationBar, type DictationHost, type DictationLive, type DictationReply } from './dictation';

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the game's code looks at.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => void (document.body.innerHTML = ''));

const hire: HireInterpretation = {
  sources: ['Hire an agent.'],
  harness: { provenance: 'missing' },
  model: { provenance: 'missing' },
  effort: { provenance: 'missing' },
  task: { provenance: 'missing' },
  questions: [],
  ready_for_review: false,
};

const floor = (session: string, building: string | null, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building, index: 0, ...over });
const B = (id: string, name: string, floors: string[]): Building => ({ id, name, sort: 0, floors });

/** A promise the test resolves by hand: the interpreter's answer, when the test says. */
function later<T>() {
  let done!: (v: T) => void;
  const p = new Promise<T>((r) => (done = r));
  return { p, done };
}

function setup() {
  const store = new WorldStore(0);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [B('acme', 'Acme', ['a-one', 'a-two'])], unassigned: [], floors: [floor('a-one', 'acme'), floor('a-two', 'acme', { index: 1, state: 'asleep' })], workers: [] },
  };
  store.applySnapshot(snap);
  const replies: Array<ReturnType<typeof later<DictationReply>>> = [];
  const submit = vi.fn((_text: string, _live: DictationLive) => {
    const l = later<DictationReply>();
    replies.push(l);
    return l.p;
  });
  const pickFloor = vi.fn<DictationHost['pickFloor']>(async () => ({ kind: 'done' }));
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const bar = new DictationBar(document.body, { submit, pickFloor, store, here: () => null, online: () => true });
  const dlg = document.querySelector('dialog.dictation') as HTMLDialogElement;
  const field = dlg.querySelector('textarea') as HTMLTextAreaElement;
  const press = (key: string, o: KeyboardEventInit & { keyCode?: number } = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o });
    if (o.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: o.keyCode });
    field.dispatchEvent(e);
    return e;
  };
  const type = (text: string) => {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { bar, dlg, field, press, type, submit, pickFloor, replies, opener, flush };
}

describe('the dictation bar (#213)', () => {
  it('opens empty with the keyboard in its text box, and Esc gives the keyboard back to where it was', () => {
    const t = setup();
    t.bar.open(t.opener);
    expect(t.dlg.open).toBe(true);
    expect(document.activeElement).toBe(t.field);
    expect(t.field.value).toBe('');
    expect(t.bar.summary()).toMatchObject({ kind: 'dictation', state: 'editing', text: '', status: '' });
    const e = t.press('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(t.dlg.open).toBe(false);
    expect(document.activeElement).toBe(t.opener);
    expect(t.bar.summary()).toBeNull();
  });

  it('keeps its keys from the game: nothing pressed in it reaches the window', () => {
    const t = setup();
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    t.bar.open(t.opener);
    for (const k of ['w', 'a', 'h', 'Enter', 'Escape']) t.press(k, { shiftKey: k === 'Enter' });
    window.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('sends on Enter, keeps Shift+Enter (and pasted line breaks) in the text, and leaves paste and letters alone', () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.\nTask: line one');
    const shift = t.press('Enter', { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    expect(t.press('v', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(t.press('w').defaultPrevented).toBe(false);
    expect(t.submit).not.toHaveBeenCalled();
    t.press('Enter');
    expect(t.submit).toHaveBeenCalledWith('Hire an agent.\nTask: line one', expect.any(Function));
  });

  it('does not send while an IME composes (Safari’s Enter after compositionend included)', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('ni');
    t.field.dispatchEvent(new CompositionEvent('compositionstart'));
    t.press('Enter', { isComposing: true });
    t.field.dispatchEvent(new CompositionEvent('compositionend'));
    t.press('Enter', { keyCode: 229 });
    // The beat after compositionend: Safari's committing Enter comes then.
    t.press('Enter');
    expect(t.submit).not.toHaveBeenCalled();
    await t.flush();
    t.press('Enter');
    expect(t.submit).toHaveBeenCalledTimes(1);
  });

  it('sends one request at a time: Enter while one is on its way does nothing, and the box stays as it is', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    const box = t.field;
    t.press('Enter');
    t.press('Enter');
    (t.dlg.querySelector('.dict-send') as HTMLButtonElement).click();
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.bar.summary()).toMatchObject({ state: 'pending', status: 'Reading the command…' });
    // Never disabled, read-only or rebuilt while it waits: dictation still arriving lands in it.
    expect(t.field.disabled).toBe(false);
    expect(t.field.readOnly).toBe(false);
    expect(t.dlg.querySelector('textarea')).toBe(box);
    expect(document.activeElement).toBe(box);
    t.replies[0]!.done({ kind: 'say', text: 'Not supported yet.', error: false });
    await t.flush();
    expect(t.bar.summary()).toMatchObject({ state: 'editing', status: 'Not supported yet.', error: false, text: 'Hire an agent.' });
    expect(t.dlg.querySelector('textarea')).toBe(box);
    t.press('Enter');
    expect(t.submit).toHaveBeenCalledTimes(2);
  });

  it('an error keeps the text and says so; Enter tries again', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    t.replies[0]!.done({ kind: 'say', text: 'The AI provider failed. Press Enter to try again.', error: true });
    await t.flush();
    expect(t.bar.summary()).toMatchObject({ state: 'editing', error: true, text: 'Hire an agent.' });
    expect(t.dlg.querySelector('.dict-status')?.getAttribute('data-tone')).toBe('error');
    t.press('Enter');
    expect(t.submit).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an empty box', () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('   ');
    t.press('Enter');
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.bar.summary()?.status).toBe('Say or type a command first.');
  });

  it('drops an answer that comes after it closed, and tells the game the request is no longer its own before it answers', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    const live = t.submit.mock.calls[0]![1];
    expect(live()).toBe(true);
    t.press('Escape');
    expect(live()).toBe(false);
    t.bar.open(t.opener);
    t.type('Open Settings.');
    // Opened again: still not the old request's bar.
    expect(live()).toBe(false);
    t.replies[0]!.done({ kind: 'floor', hire });
    await t.flush();
    expect(t.bar.summary()).toMatchObject({ state: 'editing', text: 'Open Settings.', status: '' });
    // The chord (the game's close) ends it the same way.
    t.press('Enter');
    const second = t.submit.mock.calls[1]![1];
    t.bar.close();
    expect(second()).toBe(false);
  });

  it('asks which floor for a hire with none: ↑ ↓ choose, Enter picks, editing the text drops the question', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    t.replies[0]!.done({ kind: 'floor', hire });
    await t.flush();
    const s = t.bar.summary();
    expect(s).toMatchObject({ state: 'floor', question: 'Hire on which floor?' });
    expect(s?.floors.map((f) => [f.floor, f.active])).toEqual([['a-one', true], ['a-two', false]]);
    expect(t.dlg.querySelector('.dict-floors .tape')?.textContent).toBe('Asleep');
    expect(t.field.getAttribute('aria-activedescendant')).toBe('dict-floor-0');
    t.press('ArrowDown');
    expect(t.bar.summary()?.floors.find((f) => f.active)?.floor).toBe('a-two');
    // A refusal (the floor is asleep) keeps the list up, with the reason.
    t.pickFloor.mockResolvedValueOnce({ kind: 'say', text: 'a-two is asleep. Wake it from the elevator (L) to hire.', error: true });
    t.press('Enter');
    await t.flush();
    expect(t.pickFloor).toHaveBeenCalledWith('a-two', hire, expect.any(Function), null);
    expect(t.bar.summary()).toMatchObject({ state: 'floor', status: 'a-two is asleep. Wake it from the elevator (L) to hire.', error: true });
    expect(t.submit).toHaveBeenCalledTimes(1);
    // A changed text is a new command.
    t.type('Hire an agent. Task: x');
    expect(t.bar.summary()).toMatchObject({ state: 'editing', floors: [] });
  });

  it('opened again before the last close’s `close` event came: that event does not close the new one', () => {
    const t = setup();
    t.bar.open(t.opener);
    t.press('Escape');
    t.bar.open(t.opener);
    t.type('Open Settings.');
    t.press('Enter');
    const live = t.submit.mock.calls[0]![1];
    // The browser's `close` event for the Esc, a task late.
    t.dlg.dispatchEvent(new Event('close'));
    expect(t.dlg.open).toBe(true);
    expect(document.activeElement).toBe(t.field);
    expect(live()).toBe(true);
    expect(t.bar.summary()).toMatchObject({ state: 'pending', text: 'Open Settings.' });
  });

  it('a floor picked with the mouse opens the review there, for the bar that asked', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    t.replies[0]!.done({ kind: 'floor', hire });
    await t.flush();
    (t.dlg.querySelector('[data-floor="a-one"]') as HTMLElement).click();
    await t.flush();
    expect(t.pickFloor).toHaveBeenCalledWith('a-one', hire, expect.any(Function), null);
    const live = t.pickFloor.mock.calls[0]![2];
    expect(live()).toBe(true);
    t.bar.close();
    expect(live()).toBe(false);
  });

  it('#108 round 4: the interpreter’s hand-over for the hire goes with the floor picked (to the review it opens)', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    t.replies[0]!.done({ kind: 'floor', hire, handover: 'tok-1' });
    await t.flush();
    (t.dlg.querySelector('[data-floor="a-one"]') as HTMLElement).click();
    await t.flush();
    expect(t.pickFloor).toHaveBeenCalledWith('a-one', hire, expect.any(Function), 'tok-1');
  });

  it('Esc while it asks which floor closes the bar, as everywhere else, and gives the keyboard back', async () => {
    const t = setup();
    t.bar.open(t.opener);
    t.type('Hire an agent.');
    t.press('Enter');
    t.replies[0]!.done({ kind: 'floor', hire });
    await t.flush();
    expect(t.bar.summary()?.state).toBe('floor');
    const e = t.press('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(t.dlg.open).toBe(false);
    expect(document.activeElement).toBe(t.opener);
    expect(t.pickFloor).not.toHaveBeenCalled();
    // Opened again, it starts empty, as after any Esc.
    t.bar.open(t.opener);
    expect(t.bar.summary()).toMatchObject({ state: 'editing', text: '', floors: [] });
  });
});
