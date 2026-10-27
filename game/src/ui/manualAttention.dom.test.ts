// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualAttention, ManualProcess } from '../net/protocol';
import { WorldStore } from '../world/store';

vi.mock('../laptop/seatTerm', () => ({ SeatTerminal: class {
  grid = { cols: 80, rows: 24, cell: { width: 8, height: 16 } };
  mount() { return Promise.resolve(); }
  dispose() {}
  frame() {}
} }));
import { openAttention } from '../world/manualProcess';
import { AttentionChip } from './manualAttention';
import { ManualProcessesDialog } from './manualProcesses';

beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
const run = (id: string, o: Partial<ManualProcess> = {}) => ({ id, worker: 'w', worker_name: 'Zippy', host: 'fixture-bridge', title: 'sudo id', command: 'sudo id', state: 'running', cleanup: 'none', created_at: 1, started_at: 1, ...o }) as ManualProcess;
const credential = { request: 'cr_1', prompt: '[sudo] password for fixture:', user: 'root', attempt: 1, expires_at: 9 };
const input = (confidence: 'confirmed' | 'uncertain', reason = 'tty_read'): ManualAttention => ({ id: `in-${confidence}`, kind: 'input', confidence, reason, since: 5 });
const chip = (names = true) => { const host = { respond: vi.fn(), terminal: vi.fn(), list: vi.fn() }; const c = new AttentionChip(host, { names, label: 'Manual runs asking for you' }); document.body.append(c.el); return { c, host }; };

describe('#213 attention chip', () => {
  it('one password request: the tape, whose run and which command, and Respond for that run', () => {
    const { c, host } = chip();
    c.set(openAttention([run('p', { state: 'waiting', credential })]));
    expect(c.el.hidden).toBe(false);
    expect(c.el.getAttribute('role')).toBe('group');
    expect(c.el.querySelector('.mpa-tape')!.textContent).toBe('Password requested');
    expect(c.el.querySelector('.mpa-what')!.textContent).toBe('Zippy · sudo id');
    const b = c.el.querySelector<HTMLButtonElement>('.mpa-act')!;
    expect(b.textContent).toBe('Respond');
    expect(b.getAttribute('aria-label')).toBe('Respond to the password request of “sudo id” (Zippy)');
    b.click();
    expect(host.respond).toHaveBeenCalledWith('p', b);
    expect(c.el.textContent).not.toContain('[sudo] password for fixture');
  });
  it('input by certainty: Open terminal, never a password request; the outline when it only may be', () => {
    const { c, host } = chip(false);
    c.set(openAttention([run('p', { attention: input('confirmed') })]));
    expect(c.el.querySelector('.mpa-tape')!.textContent).toBe('Waiting for input');
    expect(c.el.querySelector('.mpa-what')!.textContent).toBe('sudo id');
    c.set(openAttention([run('p', { attention: input('uncertain', 'sudo_terminal') })]));
    expect(c.el.querySelector('.mpa-tape')!.textContent).toBe('May be waiting for input');
    expect(c.el.querySelector('.mpa-tape--maybe')).not.toBeNull();
    expect(c.el.textContent).not.toMatch(/password/i);
    c.el.querySelector<HTMLButtonElement>('.mpa-act')!.click();
    expect(host.terminal).toHaveBeenCalledWith('p', expect.any(HTMLButtonElement));
    expect(host.respond).not.toHaveBeenCalled();
  });
  it('several runs: one count that opens the list; none: hidden', () => {
    const { c, host } = chip();
    c.set(openAttention([run('a', { credential }), run('b', { worker_name: 'Pebble', attention: input('uncertain') })]));
    const b = c.el.querySelector<HTMLButtonElement>('.mpa-count')!;
    expect(b.textContent).toBe('2 runs need you');
    expect(b.getAttribute('aria-label')).toBe('Manual runs: 2 runs need you. Open the list');
    b.click();
    expect(host.list).toHaveBeenCalled();
    c.set([]);
    expect(c.el.hidden).toBe(true);
    expect(c.el.childElementCount).toBe(0);
  });
  it('keeps the keyboard on its action across an update', () => {
    const { c } = chip();
    c.set(openAttention([run('p', { attention: input('uncertain') })]));
    c.el.querySelector<HTMLButtonElement>('.mpa-act')!.focus();
    c.set(openAttention([run('p', { attention: input('confirmed') })]));
    expect(document.activeElement).toBe(c.el.querySelector('.mpa-act'));
  });
});

describe('#213 the all-processes list', () => {
  it('names worker, host, run and kind, puts the asking runs first with their direct action, and says what detection cannot see', () => {
    const store = new WorldStore();
    store.manualProcesses.reset([run('quiet', { title: 'make', command: 'make', created_at: 9 }), run('pw', { state: 'waiting', credential, attention: { id: 'cr_1', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 7 }, input_detection: 'hints' }), run('in', { title: 'read x', command: 'read x', worker_name: 'Pebble', attention: input('confirmed'), input_detection: 'none' })]);
    const respond = vi.fn();
    const dlg = new ManualProcessesDialog(document.body, { store, send: vi.fn(), input: vi.fn(), watch: vi.fn(), changed: vi.fn(), external: vi.fn(), respond });
    dlg.open(null);
    const rows = [...document.querySelectorAll<HTMLElement>('.mp-row')];
    expect(rows.map((r) => r.dataset.process)).toEqual(['in', 'pw', 'quiet']);
    expect(rows[1]!.textContent).toContain('Zippy · fixture-bridge');
    expect(rows[1]!.querySelector('.mp-attn')!.textContent).toContain('Password requested');
    expect(rows[1]!.querySelector('.mp-detect')!.textContent).toMatch(/may not be detected/);
    const b = rows[1]!.querySelector<HTMLButtonElement>('[data-key="respond:pw"]')!;
    expect(b.getAttribute('aria-label')).toBe('Respond to the password request of “sudo id” (Zippy)');
    b.click();
    expect(respond).toHaveBeenCalledWith('pw', b);
    expect(rows[0]!.querySelector('.mp-attn')!.textContent).toContain('Waiting for input');
    expect(rows[0]!.textContent).not.toMatch(/password/i);
    expect(rows[0]!.querySelector('[data-key="open:in"]')!.getAttribute('aria-label')).toBe('Open the terminal of “read x” (Pebble)');
    expect(rows[0]!.querySelector('.mp-detect')!.textContent).toMatch(/not detected/);
    expect(rows[2]!.querySelector('.mp-attn')).toBeNull();
    dlg.close();
  });
  it('opens one run’s terminal straight away, with its state and the detection note', async () => {
    const store = new WorldStore();
    store.manualProcesses.reset([run('in', { attention: input('uncertain'), input_detection: 'hints' })]);
    const watch = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const dlg = new ManualProcessesDialog(document.body, { store, send: vi.fn(), input: vi.fn(), watch, changed: vi.fn(), external: vi.fn() });
    dlg.openRun('in');
    expect(dlg.isOpen).toBe(true);
    expect(document.querySelector('.mp-dialog')!.textContent).toContain('May be waiting for input');
    expect(document.querySelector('.mp-dialog .mp-detect')!.textContent).toMatch(/may not be detected/);
    expect(document.querySelector('.mp-terminal')).not.toBeNull();
    dlg.close();
  });
});
