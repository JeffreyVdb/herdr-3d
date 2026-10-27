// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualAttention, ManualProcess } from '../net/protocol';
import { WorldStore } from '../world/store';
import { openAttention } from '../world/manualProcess';
import { NeedsYouLine, needsYouText, waited } from '../ui/needsYou';
import { RunsView, runStateText, type RunsViewHost, type RunTerminalLike } from './runsView';
import { changeMarks, chatCount } from './index';

beforeEach(() => document.body.replaceChildren());

const run = (id: string, o: Partial<ManualProcess> = {}) => ({ id, worker: 'w', worker_name: 'Zippy', host: 'fixture-bridge', title: o.command ?? 'sudo id', command: 'sudo id', state: 'running', cleanup: 'none', created_at: 1, started_at: 1, ended_at: 0, ...o }) as ManualProcess;
const credential = { request: 'cr_1', prompt: '[sudo] password for fixture:', user: 'root', attempt: 1, expires_at: 9 };
const input = (confidence: 'confirmed' | 'uncertain', since = 5): ManualAttention => ({ id: `in-${confidence}-${since}`, kind: 'input', confidence, reason: 'tty_read', since });

describe('#216 the needs-you line', () => {
  const line = (now = () => 65_000) => {
    const host = { respond: vi.fn(), terminal: vi.fn(), more: vi.fn(), refocus: vi.fn() };
    const l = new NeedsYouLine(host, now);
    document.body.append(l.el);
    return { l, host };
  };

  it('a password request: who, the command, the host and the wait; Respond (primary) and Open terminal', () => {
    const { l, host } = line();
    l.set(openAttention([run('p', { state: 'waiting', credential, attention: { id: 'cr_1', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 5_000 } })]));
    expect(l.el.hidden).toBe(false);
    expect(l.el.querySelector('.seat-needs-who')!.textContent).toBe('Zippy’s run asks for your password');
    expect(l.el.querySelector('.seat-needs-cmd')!.textContent).toBe('sudo id');
    expect(l.el.querySelector('.seat-needs-where')!.textContent).toBe('fixture-bridge · 00:01:00');
    const [respond, open] = [...l.el.querySelectorAll<HTMLButtonElement>('.seat-needs-acts button')];
    expect(respond!.className).toContain('btn--primary');
    expect(respond!.getAttribute('aria-label')).toBe('Respond to the password request of “sudo id” (Zippy)');
    expect(open!.className).not.toContain('btn--primary');
    respond!.click();
    open!.click();
    expect(host.respond).toHaveBeenCalledWith('p', respond);
    expect(host.terminal).toHaveBeenCalledWith('p');
    expect(l.el.textContent).not.toContain('[sudo] password for fixture');
    l.dispose();
  });

  it('input: never "password", Open terminal is the primary action; several: the oldest and +N more', () => {
    const { l, host } = line();
    const a = run('a', { command: 'read -p "Name? " n', attention: input('uncertain', 10) });
    l.set(openAttention([a]));
    expect(l.el.querySelector('.seat-needs-who')!.textContent).toBe('Zippy’s run may be waiting for input');
    l.set(openAttention([{ ...a, attention: input('confirmed', 10) }]));
    expect(l.el.querySelector('.seat-needs-who')!.textContent).toBe('Zippy’s run is waiting for input');
    expect(l.el.textContent).not.toMatch(/password|Respond/i);
    expect(l.el.querySelectorAll('.seat-needs-acts button')).toHaveLength(1);
    expect(l.el.querySelector('.seat-needs-acts button')!.className).toContain('btn--primary');
    l.set(openAttention([{ ...a, attention: input('confirmed', 10) }, run('b', { attention: input('confirmed', 20) }), run('c', { state: 'waiting', credential, attention: { id: 'cr_1', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 30 } })]));
    const more = l.el.querySelector<HTMLButtonElement>('.seat-needs-more')!;
    expect(more.textContent).toBe('+2 more');
    expect(l.el.querySelector('.seat-needs-who')!.textContent).toBe('Zippy’s run is waiting for input');
    more.click();
    expect(host.more).toHaveBeenCalled();
    l.dispose();
  });

  it('goes when nothing waits; one that had the keyboard hands it back; it never takes it by itself', () => {
    const { l, host } = line();
    l.set(openAttention([run('a', { attention: input('confirmed') })]));
    expect(document.activeElement).toBe(document.body);
    (l.el.querySelector('button') as HTMLButtonElement).focus();
    l.set([]);
    expect(l.el.hidden).toBe(true);
    expect(host.refocus).toHaveBeenCalledTimes(1);
    expect(needsYouText(openAttention([run('x', { worker_name: '', worker: 'w9', attention: input('confirmed') })])[0]!)).toBe('w9’s run is waiting for input');
    expect(waited(3_725_000)).toBe('01:02:05');
    expect(waited(-5)).toBe('00:00:00');
  });
});

describe('#216 the Runs view', () => {
  const mount = (runs: ManualProcess[], o: Partial<RunsViewHost> = {}) => {
    const store = new WorldStore();
    store.manualProcesses.reset([...runs, run('other', { worker: 'w2', worker_name: 'Mango' })]);
    const send = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const terms: Array<RunTerminalLike & { id: string; disposed: boolean; focused: number }> = [];
    const host: RunsViewHost = {
      worker: 'w',
      store,
      name: () => 'Zippy',
      send,
      card: { worker: 'w', host: () => 'fixture-bridge', start: vi.fn(), dismiss: vi.fn(), edit: vi.fn() },
      respond: vi.fn(),
      runCommand: vi.fn(),
      terminal: (p) => {
        const t = { id: p.id, el: document.createElement('div'), disposed: false, focused: 0, update: vi.fn(), focus: () => void t.focused++, activate: vi.fn(), reconnect: vi.fn(), dispose: () => void (t.disposed = true) };
        terms.push(t);
        return t;
      },
      confirm: vi.fn().mockReturnValue(true),
      ...o,
    };
    const v = new RunsView(host);
    document.body.append(v.el);
    return { v, store, send, terms, host };
  };

  it('this worker’s runs only, the ones asking first; the picked run’s terminal only while the view is up', () => {
    const { v, terms } = mount([run('old', { created_at: 1 }), run('new', { created_at: 5 }), run('ask', { created_at: 3, attention: input('confirmed') }), run('done', { state: 'exited', exit_code: 0, cleanup: 'done', created_at: 9 })]);
    v.update();
    expect(v.summary().rows.map((r) => r.split(':')[0])).toEqual(['ask', 'new', 'old', 'done']);
    expect(v.summary().sub).toBe('3 running · 1 finished');
    expect(v.summary().selected).toBe('ask');
    expect(terms).toHaveLength(0); // hidden: no terminal, no watch
    v.setVisible(true);
    expect(terms.map((t) => t.id)).toEqual(['ask']);
    v.select('old', true);
    expect(terms.map((t) => [t.id, t.disposed])).toEqual([['ask', true], ['old', false]]);
    v.setVisible(false);
    expect(terms[1]!.disposed).toBe(true);
    v.dispose();
  });

  it('as the dialog: Respond for a password request, Stop asks first for a live run, Dismiss only an ended one', async () => {
    const { v, send, host } = mount([run('live'), run('pw', { state: 'waiting', credential, created_at: 2 }), run('gone', { state: 'exited', exit_code: 1, cleanup: 'none' }), run('dirty', { state: 'exited', cleanup: 'needed' })]);
    v.update();
    const row = (id: string) => v.el.querySelector<HTMLElement>(`.seat-run[data-process="${id}"]`)!;
    const names = (id: string) => [...row(id).querySelectorAll('.seat-run-acts button')].map((b) => b.getAttribute('aria-label'));
    expect(names('pw')).toEqual(['Respond to the password request of “sudo id”', 'Open the terminal of “sudo id”', 'Stop “sudo id”']);
    expect(names('gone')).toEqual(['Open the terminal of “sudo id”', 'Dismiss “sudo id”']);
    expect(names('dirty')).toEqual(['Open the terminal of “sudo id”', 'Stop “sudo id”']);
    row('pw').querySelector<HTMLButtonElement>('[aria-label^="Respond"]')!.click();
    expect(host.respond).toHaveBeenCalledWith('pw', expect.any(HTMLButtonElement));
    (host.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    row('live').querySelector<HTMLButtonElement>('[aria-label^="Stop"]')!.click();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    row('live').querySelector<HTMLButtonElement>('[aria-label^="Stop"]')!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('manual_process.stop', { id: 'live' }));
    row('gone').querySelector<HTMLButtonElement>('[aria-label^="Dismiss"]')!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('manual_process.dismiss', { id: 'gone' }));
    send.mockResolvedValueOnce({ ok: false, code: 'internal', message: 'boom' });
    row('dirty').querySelector<HTMLButtonElement>('[aria-label^="Stop"]')!.click(); // ended: no question
    await vi.waitFor(() => expect(v.el.querySelector<HTMLElement>('.seat-runs-status')!.hidden).toBe(false));
    expect(runStateText(run('x', { state: 'exited', exit_code: 0, cleanup: 'done' }))).toBe('Exited 0 · cleaned up');
    expect(runStateText(run('x', { state: 'waiting', credential }))).toBe('Password requested');
    v.dispose();
  });

  it('↑ ↓ pick a run, Enter opens its terminal; the request card is a second instance of the agent’s', () => {
    const { v, store, terms } = mount([run('a', { created_at: 3 }), run('b', { created_at: 2 })]);
    store.workers.set('w', { id: 'w', name: 'Zippy', command_request: { key: 'k1', at: 1, commands: [{ command: 'sudo id', cwd: '/x', cwd_named: false, host: 'bridge', host_text: '', why: '' }] } } as never);
    v.setVisible(true);
    expect(v.summary().card).toBe(true);
    const picks = () => [...v.el.querySelectorAll<HTMLButtonElement>('.seat-run-pick')];
    picks()[0]!.focus();
    picks()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(v.summary().selected).toBe('b');
    expect(document.activeElement).toBe(picks()[1]);
    picks()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(terms.at(-1)!.id).toBe('b');
    expect(terms.at(-1)!.focused).toBeGreaterThan(0);
    v.dispose();
  });
});

describe('#216 the drawer’s marks and the rail’s Chat count', () => {
  it('Changes: untracked U, every other entry M', () => {
    const m = changeMarks({ files: [{ path: 'a.ts', index: '.', worktree: 'M', insertions: 1, deletions: 0, binary: false }, { path: 'new/', untracked: true, insertions: 0, deletions: 0, binary: false }, { path: 'gone.ts', index: 'D', insertions: 0, deletions: 3, binary: false }] });
    expect([...m]).toEqual([['a.ts', 'M'], ['new/', 'U'], ['gone.ts', 'M']]);
    expect(changeMarks(null).size).toBe(0);
  });

  it('counts the questions and the commands to review', () => {
    expect(chatCount(null, false)).toBe(0);
    const w = { id: 'w', command_request: { key: 'k', at: 1, commands: [{ command: 'a', cwd: '/', cwd_named: false, host: 'bridge', host_text: '', why: '' }, { command: 'b', cwd: '/', cwd_named: false, host: 'bridge', host_text: '', why: '' }] } };
    expect(chatCount(w as never, false)).toBe(2);
    expect(chatCount({ ...w, question: { hash: 'h', text: 'q', excerpt: [], choices: [] } } as never, true)).toBe(3);
  });
});
