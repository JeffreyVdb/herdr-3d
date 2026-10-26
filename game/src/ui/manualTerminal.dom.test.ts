// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { ManualProcess } from '../net/protocol';
import { WorldStore } from '../world/store';

const mounts = vi.hoisted(() => [] as Array<() => void>);
vi.mock('../laptop/seatTerm', () => ({ SeatTerminal: class {
  grid = { cols: 80, rows: 24, cell: { width: 8, height: 16 } };
  mount() { return new Promise<void>((resolve) => mounts.push(resolve)); }
  dispose() {}
  frame() {}
} }));
import { ManualProcessesDialog } from './manualProcesses';

beforeEach(() => {
  document.body.replaceChildren(); mounts.length = 0;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});

it('does not start an old watch if its terminal was closed and reopened while mounting', async () => {
  const store = new WorldStore();
  store.manualProcesses.reset([{ id: 'p', worker: 'w', worker_name: 'Worker', host: 'bridge', title: 'server', state: 'running', cleanup: 'none', created_at: 1, started_at: 1 } as ManualProcess]);
  const watch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const input = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const dialog = new ManualProcessesDialog(document.body, { store, send: vi.fn(), input, watch, changed: vi.fn(), external: vi.fn() });
  const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
  dialog.open('w'); button('Open terminal').click();
  button('Back to processes').click(); button('Open terminal').click();
  mounts[0]!(); await Promise.resolve(); await Promise.resolve();
  expect(watch.mock.calls.filter(([t]) => t === 'terminal.watch')).toHaveLength(0);
  mounts[1]!(); await Promise.resolve(); await Promise.resolve();
  expect(watch.mock.calls.filter(([t]) => t === 'terminal.watch')).toHaveLength(1);
  document.querySelector('.mp-terminal-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  expect(input).toHaveBeenCalledWith({ id: 'mp:p', text: '\x10' });
});

it('releases keyboard focus and updates process state without remounting', async () => {
  const store = new WorldStore();
  const p = { id: 'p', worker: 'w', worker_name: 'Worker', host: 'bridge', title: 'server', state: 'running', cleanup: 'none', created_at: 1, started_at: 1 } as ManualProcess;
  store.manualProcesses.reset([p]);
  const watch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const input = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const dialog = new ManualProcessesDialog(document.body, { store, send: vi.fn(), input, watch, changed: vi.fn(), external: vi.fn() });
  const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
  dialog.open('w'); button('Open terminal').click(); mounts[0]!(); await Promise.resolve(); await Promise.resolve();
  const field = document.querySelector<HTMLTextAreaElement>('.mp-terminal-input')!;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await vi.waitFor(() => expect(input.mock.calls.map(([args]) => args.text)).toEqual(['\t', '\x1b']));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(button('Back to processes'));
  store.manualProcesses.reset([{ ...p, state: 'exited', exit_code: 42, cleanup: 'needed', cleanup_note: 'effect remains' }]); dialog.refresh();
  expect(document.body.textContent).toContain('Exited with code 42');
  expect(document.body.textContent).toContain('Cleanup: needed — effect remains');
  expect(document.querySelector('.mp-terminal-input')).toBe(field);
  expect(watch.mock.calls.filter(([t]) => t === 'terminal.watch')).toHaveLength(1);
});

it('keeps a later terminal open when an earlier entry start completes', async () => {
  let finish!: (result: { ok: true; data: object }) => void;
  const send = vi.fn(() => new Promise<{ ok: true; data: object }>((resolve) => { finish = resolve; }));
  const store = new WorldStore();
  store.workers.set('w', { id: 'w', name: 'Worker' } as never);
  store.manualProcesses.reset([{ id: 'p', worker: 'w', worker_name: 'Worker', host: 'bridge', title: 'server', state: 'running', cleanup: 'none', created_at: 1, started_at: 1 } as ManualProcess]);
  const dialog = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
  const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
  dialog.entry('w', 'first'); button('Run').click(); button('Back').click(); button('Open terminal').click();
  const terminal = document.querySelector('.mp-terminal');
  finish({ ok: true, data: {} }); await Promise.resolve(); await Promise.resolve();
  expect(document.querySelector('.mp-terminal')).toBe(terminal);
  expect(button('Back to processes')).toBeDefined();
});
