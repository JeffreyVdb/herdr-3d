// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnMessage, ManualProcess } from '../net/protocol';

const terms = vi.hoisted(() => [] as Array<{ resolve: () => void; frames: unknown[]; disposed: boolean; disposes: number }>);
vi.mock('../laptop/seatTerm', () => ({ SeatTerminal: class {
  grid = { cols: 80, rows: 24, cell: { width: 8, height: 16 } };
  rec = { resolve: () => {}, frames: [] as unknown[], disposed: false, disposes: 0 };
  private ready: Promise<void>;
  constructor() { this.ready = new Promise<void>((resolve) => { this.rec.resolve = resolve; }); terms.push(this.rec); }
  mount() { return this.ready; }
  dispose() { this.rec.disposed = true; this.rec.disposes++; }
  frame(f: unknown) { this.rec.frames.push(f); return true; }
} }));
import { mountRunTerminal, RunTerminalBroker, runStateText, type RunTerminalHost } from './runTerminal';

const p = { id: 'p', worker: 'w', worker_name: 'Worker', host: 'bridge', title: 'server', state: 'running', cleanup: 'none', created_at: 1, started_at: 1 } as ManualProcess;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function setup() {
  const watch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const input = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const broker = new RunTerminalBroker(watch);
  const host: RunTerminalHost = { broker, watch, input, external: vi.fn() };
  const watches = () => watch.mock.calls.filter(([t]) => t === 'terminal.watch' || t === 'terminal.unwatch').map(([t, a]) => `${t} ${a.id}`);
  return { watch, input, broker, host, watches };
}
const key = (el: Element, init: KeyboardEventInit) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e; };

beforeEach(() => { document.body.replaceChildren(); terms.length = 0; });

describe('mountRunTerminal', () => {
  it('lets the seat’s chords through before any byte goes to the process', async () => {
    const { host, input } = setup();
    const onKey = vi.fn((e: KeyboardEvent) => e.ctrlKey && e.shiftKey && /^Digit[1-4]$|^KeyE$/.test(e.code));
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn(), onKey });
    document.body.append(t.el);
    terms[0]!.resolve(); await flush();
    const field = t.el.querySelector('.mp-terminal-input')!;
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyE']) key(field, { key: code === 'KeyE' ? 'E' : '!', code, ctrlKey: true, shiftKey: true });
    await flush();
    expect(onKey).toHaveBeenCalledTimes(5);
    expect(input).not.toHaveBeenCalled();
    key(field, { key: 'Tab', code: 'Tab' });
    key(field, { key: 'Escape', code: 'Escape' });
    key(field, { key: 'c', code: 'KeyC', ctrlKey: true });
    await vi.waitFor(() => expect(input.mock.calls.map(([a]) => a.text)).toEqual(['\t', '\x1b', '\x03']));
  });

  it('Ctrl+Esc releases the keyboard instead of reaching the process; Ctrl+P is the process’s', async () => {
    const { host, input } = setup();
    const releaseFocus = vi.fn();
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus });
    document.body.append(t.el);
    terms[0]!.resolve(); await flush();
    const field = t.el.querySelector('.mp-terminal-input')!;
    const e = key(field, { key: 'Escape', code: 'Escape', ctrlKey: true });
    expect(releaseFocus).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
    key(field, { key: 'p', code: 'KeyP', ctrlKey: true });
    await vi.waitFor(() => expect(input.mock.calls.map(([a]) => a.text)).toEqual(['\x10']));
  });

  it('the dialog takes the seat’s run: the seat shows its placeholder, frames go to the dialog, closing hands it back', async () => {
    const { host, broker, watches } = setup();
    const seat = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    document.body.append(seat.el);
    terms[0]!.resolve(); await flush();
    expect(watches()).toEqual(['terminal.watch mp:p']);
    const dialog = mountRunTerminal(host, p, { surface: 'dialog', releaseFocus: vi.fn(), onStatus: vi.fn() });
    document.body.append(dialog.el);
    expect(seat.holding).toBe(false);
    expect(dialog.holding).toBe(true);
    expect(seat.el.hasAttribute('data-held')).toBe(true);
    expect(seat.el.querySelector('.mp-run-held')!.textContent).toContain('open in the processes dialog');
    expect((seat.el.querySelector('.mp-terminal') as HTMLElement).hidden).toBe(true);
    // Its Show it here is refused while the dialog holds the run.
    seat.el.querySelector<HTMLButtonElement>('[data-action="run-take-back"]')!.click();
    expect(dialog.holding).toBe(true);
    terms[1]!.resolve(); await flush();
    broker.onConn({ t: 'terminal.frame', id: 'mp:p', n: 1, full: true, cols: 80, rows: 24, data: '' } as ConnMessage);
    expect(terms[1]!.frames).toHaveLength(1);
    expect(terms[0]!.frames).toHaveLength(0);
    dialog.dispose();
    expect(terms[1]!.disposed).toBe(true);
    expect(seat.holding).toBe(true);
    expect(seat.el.hasAttribute('data-held')).toBe(false);
    await flush();
    expect(watches()).toEqual(['terminal.watch mp:p', 'terminal.watch mp:p', 'terminal.watch mp:p']);
    seat.dispose();
    expect(watches().at(-1)).toBe('terminal.unwatch mp:p');
  });

  it('a surface that lost the run while its terminal was still mounting never watches', async () => {
    const { host, watches } = setup();
    const seat = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    const dialog = mountRunTerminal(host, p, { surface: 'dialog', releaseFocus: vi.fn(), onStatus: vi.fn() });
    terms[0]!.resolve(); await flush();
    expect(watches()).toEqual([]);
    terms[1]!.resolve(); await flush();
    expect(watches()).toEqual(['terminal.watch mp:p']);
    // Disposed while mounting: nothing is watched for it either.
    dialog.dispose(); seat.dispose();
    expect(watches()).toEqual(['terminal.watch mp:p', 'terminal.unwatch mp:p']);
  });

  it('a dispose while its terminal is still mounting disposes it again once the mount completes; a loss keeps it', async () => {
    const { host, watches } = setup();
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    t.dispose();
    expect(terms[0]!.disposes).toBe(1);
    // The real SeatTerminal builds its xterm and ResizeObserver after the font loads, even past a dispose.
    terms[0]!.resolve(); await flush();
    expect(terms[0]!.disposes).toBe(2);
    expect(watches()).not.toContain('terminal.watch mp:p');
    const seat = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    const dialog = mountRunTerminal(host, p, { surface: 'dialog', releaseFocus: vi.fn(), onStatus: vi.fn() });
    expect(seat.holding).toBe(false);
    terms[1]!.resolve(); terms[2]!.resolve(); await flush();
    // The seat only lost the run: it may hold again, so its terminal stays.
    expect(terms[1]!.disposes).toBe(0);
    dialog.dispose(); seat.dispose();
  });

  it('a watch answer that comes after the run was taken is ignored (no resize, no status)', async () => {
    let answer!: (r: unknown) => void;
    const watch = vi.fn((t: string) => (t === 'terminal.watch' && !answer ? new Promise((r) => { answer = r; }) : Promise.resolve({ ok: true, data: {} })));
    const broker = new RunTerminalBroker(watch as never);
    const host: RunTerminalHost = { broker, watch: watch as never, input: vi.fn(), external: vi.fn() };
    const onStatus = vi.fn();
    const seat = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn(), onStatus });
    terms[0]!.resolve(); await flush();
    mountRunTerminal(host, p, { surface: 'dialog', releaseFocus: vi.fn(), onStatus: vi.fn() });
    answer({ ok: false, code: 'capacity', message: 'x' }); await flush();
    expect(onStatus).not.toHaveBeenCalled();
    expect(watch.mock.calls.filter(([t]) => t === 'terminal.resize')).toHaveLength(0);
    expect(seat.holding).toBe(false);
  });

  it('sends input in serial 16 KiB chunks, IME text once, and only while it holds the run', async () => {
    const { host, input } = setup();
    let release!: () => void;
    input.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, data: {} }); }));
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    terms[0]!.resolve(); await flush();
    const field = t.el.querySelector<HTMLTextAreaElement>('.mp-terminal-input')!;
    field.value = 'é'.repeat(9000); // 18000 bytes
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }));
    await flush();
    expect(input).toHaveBeenCalledTimes(1);
    release(); await flush();
    expect(input).toHaveBeenCalledTimes(2);
    expect(input.mock.calls.map(([a]) => new TextEncoder().encode(a.text).length)).toEqual([16384, 18000 - 16384]);
    field.dispatchEvent(new CompositionEvent('compositionend', { data: 'かな' }));
    field.value = 'かな';
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertFromComposition' }));
    await flush();
    expect(input.mock.calls.slice(2).map(([a]) => a.text)).toEqual(['かな']);
    // Taken by the dialog: its keys no longer go anywhere from here.
    mountRunTerminal(host, p, { surface: 'dialog', releaseFocus: vi.fn(), onStatus: vi.fn() });
    field.value = 'x'; field.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    await flush();
    expect(input).toHaveBeenCalledTimes(3);
  });

  it('read only and closed are said; the field is disabled read only; the state line follows the record', async () => {
    const { host, broker } = setup();
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    terms[0]!.resolve(); await flush();
    const field = t.el.querySelector<HTMLTextAreaElement>('.mp-terminal-input')!;
    const note = t.el.querySelector<HTMLElement>('.mp-run-note')!;
    broker.onConn({ t: 'terminal.control', id: 'mp:p', mode: 'observe', cols: 80, rows: 24 } as ConnMessage);
    expect(field.disabled).toBe(true);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/read only because another client controls it/);
    broker.onConn({ t: 'terminal.control', id: 'mp:p', mode: 'control', cols: 80, rows: 24 } as ConnMessage);
    expect(field.disabled).toBe(false);
    expect(note.hidden).toBe(true);
    broker.onConn({ t: 'terminal.closed', id: 'mp:p', reason: 'gone' } as ConnMessage);
    expect(note.textContent).toBe('The terminal closed.');
    const ended = { ...p, state: 'exited', exit_code: 42, cleanup: 'needed', cleanup_note: 'effect remains' } as ManualProcess;
    t.update(ended);
    expect(t.el.querySelector('.mp-run-state')!.textContent).toBe(runStateText(ended));
    expect(t.el.textContent).toContain('Exited with code 42 — output stays until you dismiss it');
    expect(t.el.querySelector('.mp-run-state')!.getAttribute('aria-live')).toBe('polite');
  });

  it('reconnect re-watches at its size; dispose unwatches and never stops the process', async () => {
    const { host, watch } = setup();
    const t = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn() });
    terms[0]!.resolve(); await flush();
    t.reconnect(); await flush();
    expect(watch.mock.calls.filter(([c]) => c === 'terminal.watch').map(([, a]) => a)).toEqual([
      { id: 'mp:p', fps: 10, control: true, cols: 80, rows: 24 },
      { id: 'mp:p', fps: 10, control: true, cols: 80, rows: 24 },
    ]);
    t.dispose();
    t.dispose();
    expect(watch.mock.calls.map(([c]) => c).filter((c) => c !== 'terminal.resize')).toEqual(['terminal.watch', 'terminal.watch', 'terminal.unwatch']);
    expect(watch.mock.calls.some(([c]) => String(c).startsWith('manual_process'))).toBe(false);
  });

  it('a custom placeholder gets a take-back that works once the dialog’s surface is gone', async () => {
    const { host } = setup();
    const other = mountRunTerminal(host, { ...p, id: 'q' }, { surface: 'seat', releaseFocus: vi.fn() });
    const seat = mountRunTerminal(host, p, { surface: 'seat', releaseFocus: vi.fn(), placeholder: (takeBack) => { const b = document.createElement('button'); b.textContent = 'Take it back'; b.onclick = takeBack; return b; } });
    // The later seat surface holds; the first shows the default placeholder; take the run back to the first, then to the second.
    expect(seat.holding).toBe(true);
    other.activate();
    expect(other.holding).toBe(true);
    expect(seat.el.querySelector('.mp-run-held')!.textContent).toBe('Take it back');
    seat.el.querySelector<HTMLButtonElement>('.mp-run-held button')!.click();
    expect(seat.holding).toBe(true);
    seat.focus();
    other.focus();
    expect(document.activeElement).not.toBe(other.el.querySelector('.mp-terminal-input'));
  });
});
