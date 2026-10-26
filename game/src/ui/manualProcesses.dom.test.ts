// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualProcess } from '../net/protocol';
import { WorldStore } from '../world/store';
import { askpassEligible, ManualProcessesDialog } from './manualProcesses';

beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
const p = { id: 'p', worker: 'w', worker_name: 'Worker', host: 'bridge', title: 'server', state: 'running', cleanup: 'none', created_at: 1, started_at: 1 } as ManualProcess;
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('manual process list', () => {
  it('shows orphan cleanup and permits only eligible actions', () => {
    const store = new WorldStore(); store.manualProcesses.reset([p, { ...p, id: 'orphan', worker: 'gone', worker_name: 'Gone', state: 'exited', cleanup: 'needed', cleanup_note: 'effect remains' }]);
    const dlg = new ManualProcessesDialog(document.body, { store, send: vi.fn(), input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.open(null);
    const orphan = document.querySelector('[data-process="orphan"]')!;
    expect(orphan.textContent).toContain('Gone');
    expect(orphan.textContent).toContain('Cleanup: needed');
    expect(orphan.textContent).toContain('Stop');
    expect(orphan.textContent).not.toContain('Dismiss');
    dlg.close();
  });
  it('confirms Stop and keeps the record until the bridge removes it', async () => {
    const store = new WorldStore(); store.manualProcesses.reset([p]);
    const send = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.open('w'); button('Stop').click(); await Promise.resolve();
    expect(send).toHaveBeenCalledWith('manual_process.stop', { id: 'p' });
    expect(document.querySelector('[data-process="p"]')).not.toBeNull();
    vi.restoreAllMocks();
  });
  it('starts a manual command from the all-processes view and reuses an operation on retry', async () => {
    const store = new WorldStore();
    store.workers.set('w', { id: 'w', name: 'Worker', cwd: '/work' } as never);
    const send = vi.fn().mockResolvedValue({ ok: false, code: 'timeout', message: '' });
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.open(null);
    button('Run a command…').click();
    const field = document.querySelector<HTMLTextAreaElement>('.mp-command-input')!;
    field.value = 'echo ok';
    button('Run').click(); await Promise.resolve(); await Promise.resolve();
    button('Run').click(); await Promise.resolve(); await Promise.resolve();
    expect(send.mock.calls[0]![1]).toMatchObject({ worker: 'w', command: 'echo ok', cwd: '/work', source: { kind: 'manual' } });
    expect(send.mock.calls[0]![1].op).toBe(send.mock.calls[1]![1].op);
  });
  it('offers askpass only for top-level sudo followed by a non-flag word', () => {
    expect(askpassEligible('sudo id')).toBe(true);
    expect(askpassEligible('sudo -n id')).toBe(false);
    expect(askpassEligible('echo sudo id')).toBe(false);
    expect(askpassEligible('sudo\nid')).toBe(false);
  });
});
