// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { FirePrepare } from '../net/protocol';
import { installDialogs, flush, secretsBridge } from '../test/secretsBridge';
import { packupPrompt } from '../world/packup';
import { WRAPUP_PROMPT } from '../world/wrapup';
import type { DialogHost } from './hire';
import { SendHomeDialog } from './sendHome';

// #108 round 4: the send home's last prompt through the review (a wrap-up), and a pack-up's task with its check's
// hand-over: as answered it needs no review again; edited, it is reviewed as usual; refused, nothing goes.

const PREP: FirePrepare = { name: 'Pixel', label: 'pixel', branch: 'h3d/pixel', worktree: { path: '/w/pixel', linked: true }, dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true };
const REF = '[secret in file /run/user/1000/herdr-world/secrets/AAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBB]';

function setup(o: { on?: boolean; wrapups?: CommandResult[] } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const wrapups = [...(o.wrapups ?? [])];
  const worker = { id: 'A', session: 's', label: 'pixel', agent_kind: 'claude', status: 'idle', worktree: { path: '/w/pixel', linked: true } };
  const host = {
    store: { floorName: (id: string) => id, workerView: () => ({ name: 'Pixel', desk: 0, harness: 'claude', display: 'idle', worker }), workers: new Map([['A', worker]]) },
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => 0,
    secrets: b.flow,
    send: (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, args });
      if (cmd === 'worker.fire.prepare') return Promise.resolve({ ok: true, data: PREP });
      return Promise.resolve(wrapups.shift() ?? { ok: true, data: { queued: false } });
    },
  } as unknown as DialogHost;
  const dlg = new SendHomeDialog(document.body, host);
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`.desk-dlg--home [data-key="${key}"]`)!;
  const wraps = () => sent.filter((s) => s.cmd === 'worker.wrapup').map((s) => s.args);
  return { b, dlg, sent, wraps, toasts, q };
}

/** Puts `text` in the dialog's prompt box as typing would. */
function type(box: HTMLTextAreaElement, text: string): void {
  box.value = text;
  box.dispatchEvent(new Event('input'));
}

describe('SendHomeDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(installDialogs);
  afterEach(() => document.body.replaceChildren());

  it('a wrap-up’s last prompt with a secret: reviewed first, nothing before Confirm, sent with the decisions the bridge takes', async () => {
    const e = setup();
    e.dlg.open('A');
    await flush();
    e.q('wrap').click();
    const text = `${WRAPUP_PROMPT} Then push with TOKEN=ghp_abcdefghijklmnopqrstu1.`;
    type(e.q<HTMLTextAreaElement>('wrap-prompt'), text);
    e.q('send').click();
    await flush();
    expect(e.b.open()).toMatchObject({ target: 'Pixel', action: 'Confirm and send', counts: { found: 1 } });
    expect(e.wraps()).toEqual([]);
    e.b.confirm();
    await flush();
    const [args] = e.wraps();
    expect(args).toMatchObject({ id: 'A', prompt: text, worktree: 'delete', secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    expect(e.b.gate(text, args!.secrets, 'A')).toMatchObject({ protected: 1, text: expect.stringContaining('TOKEN=[secret in file ') });
    expect(e.toasts.at(-1)).toMatch(/^Pixel is wrapping up/);
  });

  it('“Review secrets” and Ctrl/⌘+Shift+X open the review on purpose (nothing found too); off there is no such control and no scan', async () => {
    const e = setup();
    e.dlg.open('A');
    await flush();
    e.q('wrap').click();
    expect(e.q('review').textContent).toBe('Review secrets');
    e.q<HTMLTextAreaElement>('wrap-prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(e.b.open()).toMatchObject({ manual: true, counts: { found: 0 } });
    e.b.cancel();
    await flush();
    expect(e.dlg.summary()).toMatchObject({ state: 'ready', status: 'Not sent: the prompt is still here.' });
    expect(e.wraps()).toEqual([]);
    const off = setup({ on: false });
    off.dlg.open('A');
    await flush();
    off.q('wrap').click();
    expect(document.querySelector('.desk-dlg--home [data-key="review"]')).toBeNull();
    off.q('send').click();
    await flush();
    expect(off.b.scans).toEqual([]);
    expect(off.wraps()).toEqual([{ id: 'A', prompt: WRAPUP_PROMPT, worktree: 'delete' }]);
  });

  describe('pack up with a hand-over', () => {
    const task = `Deploy with the token in ${REF}`;
    const original = `${task} and then go home`;
    const open = async (e: ReturnType<typeof setup>) => {
      const done = e.dlg.openPackup('A', { original, task, removed: [{ start: task.length, end: original.length }], pending: 'tok-1' });
      await flush();
      return done;
    };

    it('the task as the check answered it: sent with the hand-over, no scan, no review', async () => {
      const e = setup();
      const done = open(e);
      await flush();
      e.q('send').click();
      await flush();
      expect(e.b.scans).toEqual([]);
      expect(e.wraps()).toEqual([{ id: 'A', prompt: packupPrompt(task), worktree: 'delete_branch', secrets_pending: 'tok-1' }]);
      await expect(done).resolves.toBe('done');
    });

    it('an edited task is reviewed as usual (its references scan clean), and still goes with the hand-over', async () => {
      const e = setup();
      void open(e);
      await flush();
      type(e.q<HTMLTextAreaElement>('wrap-prompt'), `${task}, PASSWORD=hunter22`);
      e.q('send').click();
      await flush();
      expect(e.b.open()).toMatchObject({ counts: { found: 1 } });
      e.b.confirm();
      await flush();
      const [args] = e.wraps();
      expect(args).toMatchObject({ prompt: packupPrompt(`${task}, PASSWORD=hunter22`), secrets_pending: 'tok-1', secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    });

    it('the hand-over refused as stale: nothing more goes (no review again), and why; an older bridge: update it', async () => {
      const e = setup({ wrapups: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }, { ok: false, code: 'bad_request', message: 'bad args: json: unknown field "secrets_pending"' }] });
      void open(e);
      await flush();
      e.q('send').click();
      await flush();
      expect(e.wraps()).toHaveLength(1);
      expect(e.b.open()).toBeNull();
      expect(e.dlg.summary()).toMatchObject({ error: true, status: expect.stringMatching(/^Nothing was sent: the check of the prompt’s secrets no longer holds/) });
      e.q('send').click();
      await flush();
      expect(e.dlg.summary()).toMatchObject({ error: true, status: expect.stringMatching(/can’t hand a pack-up’s protected secrets to a wrap-up yet\. Update the bridge/) });
    });
  });

  it('a pack-up without a hand-over (nothing was reviewed): its task is reviewed as any wrap-up prompt', async () => {
    const e = setup();
    const task = 'Push with TOKEN=ghp_abcdefghijklmnopqrstu1';
    void e.dlg.openPackup('A', { original: `${task} and go home`, task, removed: [{ start: task.length, end: task.length + 12 }] });
    await flush();
    e.q('send').click();
    await flush();
    expect(e.b.open()).toMatchObject({ counts: { found: 1 } });
    e.b.confirm('c1');
    await flush();
    const [args] = e.wraps() as Array<{ secrets_pending?: string; secrets: unknown }>;
    expect(args!.secrets_pending).toBeUndefined();
    expect(e.b.gate(packupPrompt(task), args!.secrets, 'A')).toMatchObject({ protected: 0 });
  });
});

