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
