// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirePrepare } from '../net/protocol';
import type { DialogHost } from './hire';
import { SendHomeDialog } from './sendHome';

// #63: a scheduled agent holds the worktree. The dialog shows the bridge's reason, and a delete refused because a
// schedule came to hold it after the dialog looked shows that reason, then the dialog looks again and keeps.

const PREP: FirePrepare = { name: 'Pixel', label: 'pixel', branch: 'h3d/pixel', worktree: { path: '/w/pixel', linked: true }, dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true };
const HOLD = "used by scheduled agent 'After the soak' at 2026-10-17 12:45 CEST";
const HELD: FirePrepare = { ...PREP, can_delete: false, can_delete_branch: false, reason: HOLD };

type Reply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function setup(preps: FirePrepare[], replies: Partial<Record<string, Reply>> = {}) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const worker = { id: 'A', session: 's', label: 'pixel', agent_kind: 'claude', status: 'idle', worktree: { path: '/w/pixel', linked: true } };
  let n = 0;
  const host = {
    store: { floorName: (id: string) => id, workerView: () => ({ name: 'Pixel', desk: 0, harness: 'claude', display: 'idle', worker }), workers: new Map([['A', worker]]) },
    unsupported: () => false,
    toast: () => {},
    now: () => 0,
    send: (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, args });
      if (cmd === 'worker.fire.prepare') return Promise.resolve({ ok: true, data: preps[Math.min(n++, preps.length - 1)] });
      return Promise.resolve(replies[cmd] ?? { ok: true, data: {} });
    },
  } as unknown as DialogHost;
  const dlg = new SendHomeDialog(document.body, host);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-key="${key}"]`)!;
  const choose = (v: string) => {
    const r = q<HTMLInputElement>(`wt:${v}`);
    r.checked = true;
    r.dispatchEvent(new Event('change'));
  };
  const warning = () => document.querySelector('.dd-callout[data-level="warn"]')?.textContent ?? null;
  return { dlg, sent, flush, q, choose, warning };
}

describe('SendHomeDialog: a worktree a scheduled agent holds (#63)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => document.body.replaceChildren());

  it('shows the hold as the reason, without the commit-and-push advice, and offers only keep', async () => {
    const e = setup([HELD]);
    e.dlg.open('A');
    await e.flush();
    expect(e.warning()).toBe(`Deleting is off: ${HOLD}. The worktree stays until that agent starts, or until its schedule is cancelled.`);
    expect(e.q<HTMLInputElement>('wt:delete').disabled).toBe(true);
    expect(e.dlg.summary()!.choice).toBe('keep');
  });

  it('a delete refused for a hold names it, looks again and keeps', async () => {
    const e = setup([PREP, HELD], { 'worker.fire': { ok: false, code: 'invalid_state', message: `invalid state: ${HOLD}` } });
    e.dlg.open('A');
    await e.flush();
    expect(e.warning()).toBeNull();
    e.choose('delete');
    e.q('send').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'worker.fire')!.args).toEqual({ id: 'A', worktree: 'delete' });
    const s = e.dlg.summary()!;
    expect(s.error).toBe(true);
    expect(s.status).toBe(`Pixel was not sent home: its worktree is ${HOLD}. Keep the worktree to send Pixel home now.`);
    expect(s.status).not.toMatch(/asleep/);
    expect(s.choice).toBe('keep');
    expect(e.sent.filter((x) => x.cmd === 'worker.fire.prepare')).toHaveLength(2);
    expect(e.warning()).toContain(`Deleting is off: ${HOLD}.`);
  });

  it('a wrap-up refused for a hold names it and looks again', async () => {
    const e = setup([PREP, HELD], { 'worker.wrapup': { ok: false, code: 'invalid_state', message: `invalid state: ${HOLD} and 1 more` } });
    e.dlg.open('A');
    await e.flush();
    e.choose('delete');
    e.q('wrap').click();
    await e.flush();
    e.q('send').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'worker.wrapup')!.args).toMatchObject({ id: 'A', worktree: 'delete' });
    expect(e.dlg.summary()!.status).toBe(`Nothing was sent: the worktree is ${HOLD} and 1 more. Keep the worktree to wrap up now.`);
    expect(e.sent.filter((x) => x.cmd === 'worker.fire.prepare')).toHaveLength(2);
  });
});
