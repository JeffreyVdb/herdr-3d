// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirePrepare } from '../net/protocol';
import { PACKUP_CLEANUP } from '../world/packup';
import type { DialogHost } from './hire';
import { SendHomeDialog } from './sendHome';

// #110: the send home's pack-up mode: the original struck, the task editable, the worktree and its branch
// preselected, and the three ways out.

const TEXT = 'Please make a PR and end your turn';
const PREP: FirePrepare = { name: 'Pixel', label: 'pixel', branch: 'h3d/pixel', worktree: { path: '/w/pixel', linked: true }, dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true };

function setup(prep: FirePrepare = PREP) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const worker = { id: 'A', session: 's', label: 'pixel', agent_kind: 'claude', status: 'idle', worktree: { path: '/w/pixel', linked: true } };
  const host = {
    store: { floorName: (id: string) => id, workerView: () => ({ name: 'Pixel', desk: 0, harness: 'claude', display: 'idle', worker }), workers: new Map([['A', worker]]) },
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => 0,
    send: (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, args });
      return Promise.resolve(cmd === 'worker.fire.prepare' ? { ok: true, data: prep } : { ok: true, data: { queued: false } });
    },
  } as unknown as DialogHost;
  const dlg = new SendHomeDialog(document.body, host);
  const flush = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-key="${key}"]`)!;
  return { dlg, sent, toasts, flush, q };
}

describe('SendHomeDialog: pack up on request (#110)', () => {
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

  it('shows the original struck, the task editable, the branch delete preselected; Send and go home is a wrap-up', async () => {
    const e = setup();
    const done = e.dlg.openPackup('A', { original: TEXT, task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    await e.flush();
    const s = e.dlg.summary()!;
    expect(s.mode).toBe('packup');
    expect(s.title).toBe('Send the task, then send Pixel home');
    expect(s.choice).toBe('delete_branch');
    expect(e.q('pk-original').textContent).toBe(TEXT);
    expect(e.q('pk-original').querySelector('del')!.textContent).toBe(' and end your turn');
    expect([...document.querySelectorAll('.dd-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Send as written (stay)', 'Send and go home']);
    const box = e.q<HTMLTextAreaElement>('wrap-prompt');
    expect(box.value).toBe('Please make a PR');
    box.value = 'Please make a draft PR';
    box.dispatchEvent(new Event('input'));
    e.q('send').click(); // a click sends, the choice in plain sight
    await e.flush();
    const wrap = e.sent.filter((x) => x.cmd === 'worker.wrapup');
    expect(wrap).toEqual([{ cmd: 'worker.wrapup', args: { id: 'A', prompt: `Please make a draft PR\n\n${PACKUP_CLEANUP}`, worktree: 'delete_branch' } }]);
    expect(await done).toBe('done');
    expect(e.dlg.isOpen).toBe(false);
    expect(e.toasts.at(-1)).toContain('Once it reports CLEAN it goes home. Its worktree and branch are deleted.');
  });

  it('Send as written (stay) hands it back; Cancel and Esc send nothing', async () => {
    const e = setup();
    const stay = e.dlg.openPackup('A', { original: TEXT, task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    await e.flush();
    e.q('stay').click();
    expect(await stay).toBe('stay');
    const cancel = e.dlg.openPackup('A', { original: TEXT, task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    await e.flush();
    e.q('cancel').click();
    expect(await cancel).toBe('cancel');
    expect(e.sent.filter((x) => x.cmd !== 'worker.fire.prepare')).toEqual([]);
  });

  it('falls back to the worktree, then keep, with the send home’s warning', async () => {
    const e = setup({ ...PREP, can_delete_branch: false });
    void e.dlg.openPackup('A', { original: TEXT, task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    await e.flush();
    expect(e.dlg.summary()!.choice).toBe('delete');
    const f = setup({ ...PREP, can_delete: false, can_delete_branch: false, unpushed: 2, reason: '2 commits are not on any remote' });
    void f.dlg.openPackup('A', { original: TEXT, task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    await f.flush();
    expect(f.dlg.summary()!.choice).toBe('keep');
    expect(document.querySelector('.dd-callout[data-level="warn"]')!.textContent).toContain('Deleting is off: 2 commits are not on any remote');
  });
});
