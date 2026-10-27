// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualProcess } from '../net/protocol';
import { WorldStore } from '../world/store';
import { askpassEligible, ManualProcessesDialog, newManualOp } from './manualProcesses';

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
  it('keeps a newer unsent entry when an earlier start completes', async () => {
    let finish!: (result: { ok: true; data: object }) => void;
    const send = vi.fn(() => new Promise<{ ok: true; data: object }>((resolve) => { finish = resolve; }));
    const store = new WorldStore(); store.host = 'fixture-bridge';
    store.workers.set('w', { id: 'w', name: 'Worker', cwd: '/tmp' } as never);
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.entry('w', 'first command'); button('Run').click(); button('Back').click(); button('Run a command…').click();
    const field = document.querySelector<HTMLTextAreaElement>('.mp-command-input')!; field.value = 'second unsent command';
    finish({ ok: true, data: {} }); await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.mp-command-input')).toBe(field);
    expect(field.value).toBe('second unsent command');
    expect(document.body.textContent).toContain('Machine: fixture-bridge');
  });
  it('ignores a start response after closing and reopening the dialog', async () => {
    let finish!: (result: { ok: true; data: object }) => void;
    const send = vi.fn(() => new Promise<{ ok: true; data: object }>((resolve) => { finish = resolve; }));
    const store = new WorldStore(); store.workers.set('w', { id: 'w', name: 'Worker' } as never);
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.entry('w', 'first'); button('Run').click(); dlg.close(); dlg.entry('w', 'new');
    finish({ ok: true, data: {} }); await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector<HTMLTextAreaElement>('.mp-command-input')?.value).toBe('new');
  });
  it('does not show an old stop failure in a newer entry', async () => {
    let finish!: (result: { ok: false; code: string; message: string }) => void;
    const send = vi.fn(() => new Promise<{ ok: false; code: string; message: string }>((resolve) => { finish = resolve; }));
    const store = new WorldStore(); store.manualProcesses.reset([p]); store.workers.set('w', { id: 'w', name: 'Worker' } as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    dlg.open('w'); button('Stop').click(); button('Run a command…').click();
    finish({ ok: false, code: 'error', message: 'old failure' }); await Promise.resolve(); await Promise.resolve();
    expect(document.body.textContent).not.toContain('old failure'); vi.restoreAllMocks();
  });
  it('generates usable operation IDs without randomUUID', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('unavailable'); });
    expect(newManualOp()).toMatch(/^mp-[a-z0-9]{20}$/);
    vi.restoreAllMocks();
  });
  it('#213: Edit and run… fills the form with the exact command, sends nothing until Run, then sends it byte for byte', async () => {
    const store = new WorldStore(); store.workers.set('w', { id: 'w', name: 'Worker', cwd: '/work' } as never);
    const send = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    const command = 'sudo -k python3 tools/hello_world_server.py 80\r\n';
    dlg.entry('w', command, '/srv');
    const field = document.querySelector<HTMLTextAreaElement>('.mp-command-input')!;
    expect(field.value).toBe('sudo -k python3 tools/hello_world_server.py 80\n');
    expect(document.activeElement).toBe(field);
    expect(document.querySelector('.mp-dialog pre')!.textContent).toBe('sudo -A -k python3 tools/hello_world_server.py 80\r\n');
    expect(send).not.toHaveBeenCalled();
    button('Run').click(); await Promise.resolve();
    expect(send.mock.calls[0]![1]).toMatchObject({ command, cwd: '/srv', askpass: true, source: { kind: 'manual' } });
    dlg.close();
  });
  it('#213: Edit and run… with carriage returns says so; once edited it sends exactly the field, even edited back', async () => {
    const store = new WorldStore(); store.workers.set('w', { id: 'w', name: 'Worker', cwd: '/work' } as never);
    const send = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const dlg = new ManualProcessesDialog(document.body, { store, send, input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn() });
    const command = "sudo -k printf 'a\rb'\r\n";
    const field = () => document.querySelector<HTMLTextAreaElement>('.mp-command-input')!;
    const type = (text: string) => { field().value = text; field().dispatchEvent(new Event('input')); };
    const sent = async () => { button('Run').click(); await Promise.resolve(); await Promise.resolve(); return (send.mock.calls.at(-1)![1] as { command: string }).command; };
    const note = () => document.querySelector('#mp-cr-note');
    // Unedited: the original bytes, and the notice.
    dlg.entry('w', command);
    expect(note()?.textContent).toMatch(/carriage returns, shown here as line breaks.*unedited.*kept.*sent as shown/);
    expect(field().getAttribute('aria-describedby')).toBe('mp-cr-note');
    expect(await sent()).toBe(command);
    // Another character edited: exactly the field (LF where the CRs were), and the preview follows the same bytes.
    dlg.entry('w', command);
    type(field().value.replace('printf', 'echo'));
    expect(await sent()).toBe("sudo -k echo 'a\nb'\n");
    dlg.entry('w', 'sudo -k id\r\n');
    expect(document.querySelector('.mp-dialog pre')!.textContent).toBe('sudo -A -k id\r\n');
    type(field().value.replace('id', 'whoami'));
    expect(document.querySelector('.mp-dialog pre')!.textContent).toBe('sudo -A -k whoami\n');
    expect(await sent()).toBe('sudo -k whoami\n');
    // Replaced with LF-only text: that text.
    dlg.entry('w', command);
    type('sudo -k id\n');
    expect(await sent()).toBe('sudo -k id\n');
    // Edited, then back to the text as first shown: still edited, the field's text (no CR comes back).
    dlg.entry('w', command);
    const shown = field().value;
    type('x'); type(shown);
    expect(await sent()).toBe(shown);
    expect(shown).not.toContain('\r');
    // No CR: no notice.
    dlg.entry('w', 'sudo id\n');
    expect(note()).toBeNull();
    expect(field().hasAttribute('aria-describedby')).toBe(false);
    dlg.close();
  });
  it('offers askpass only for top-level sudo followed by a non-flag word', () => {
    expect(askpassEligible('sudo id')).toBe(true);
    expect(askpassEligible('sudo  \tid')).toBe(true);
    expect(askpassEligible('sudo -n id')).toBe(false);
    expect(askpassEligible('echo sudo id')).toBe(false);
    expect(askpassEligible('sudo\nid')).toBe(false);
  });
});
