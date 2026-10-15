// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import { CommandCatalogs } from '../laptop/commandCatalog';
import { type PromptHost, PromptOverlay } from './prompt';

// #39: the P overlay completes `/`, `@` and `@r:` as its worker's transcript does (the same list of commands, the app's
// `CommandCatalogs`), and a stalled lookup holds only its popup: the prompt goes while it is out.

interface Ask {
  t: string;
  args: Record<string, unknown>;
  answer(r: CommandResult): Promise<void>;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const asks: Ask[] = [];
  const send = (t: string, args: Record<string, unknown>) =>
    new Promise<CommandResult>((res) => {
      asks.push({
        t,
        args,
        async answer(r) {
          res(r);
          await flush();
        },
      });
    });
  const catalogs = new CommandCatalogs({ send: (t, args) => send(t, args as Record<string, unknown>) });
  const view = (id: string) => ({ name: id, desk: 0, harness: id === 'S' ? undefined : 'claude', display: 'idle', worker: { id, session: 's', agent_kind: 'claude', status: 'idle' } });
  const host = {
    store: { floorName: (id: string) => id, workerView: view, floorView: () => ({ asleep: false }), workers: new Map([['A', {}], ['S', {}]]), repoRefs: { state: null, onChange: () => () => {} } },
    unsupported: () => false,
    toast: () => {},
    upload: () => Promise.resolve({ ok: true, data: { path: '/drops/image.png' } }),
    send,
    catalogs,
  } as unknown as PromptHost;
  const overlay = new PromptOverlay(document.body, host);
  return { overlay, asks, catalogs, of: (t: string) => asks.filter((a) => a.t === t) };
}

const box = () => document.querySelector<HTMLElement>('#prompt-text')!;
const pop = () => document.querySelector<HTMLElement>('.desk-dlg--prompt .cmp-pop');
const isOpen = () => !!pop() && !pop()!.hidden;
const status = () => {
  const s = document.querySelector<HTMLElement>('.desk-dlg--prompt .cmp-pop-status');
  return s && !s.hidden ? s.textContent : null;
};
function type(s: string): void {
  const ed = box();
  ed.focus();
  let node = [...ed.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
  if (!node) {
    node = document.createTextNode('');
    ed.replaceChildren(node);
  }
  const at = node.length;
  node.insertData(at, s);
  document.getSelection()?.setBaseAndExtent(node, at + s.length, node, at + s.length);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
const press = (k: string) => box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('PromptOverlay: completion (#39)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('with the worker’s list stalled, / says Loading skills… and the prompt is sent before it answers', async () => {
    const { overlay, of } = setup();
    overlay.open('A');
    expect(of('worker.commands')).toHaveLength(0);
    type('/');
    expect(status()).toBe('Loading skills…');
    expect(of('worker.commands').map((a) => a.args)).toEqual([{ id: 'A' }]);
    press('Escape');
    type(' please');
    press('Enter');
    await flush();
    expect(of('worker.prompt').map((a) => a.args)).toEqual([{ id: 'A', text: '/ please' }]);
    await of('worker.commands')[0]!.answer({ ok: true, data: { commands: [{ name: 'grill', description: '', argument_hint: '', kind: 'skill' }], partial: false } });
    expect(isOpen()).toBe(false);
  });

  it('shares the transcript’s list: a list already asked shows at once', async () => {
    const { overlay, of, catalogs } = setup();
    const list = catalogs.get('A');
    void list.refresh();
    await of('worker.commands')[0]!.answer({ ok: true, data: { commands: [{ name: 'grill', description: '', argument_hint: '', kind: 'skill' }], partial: false } });
    overlay.open('A');
    type('/gr');
    expect([...document.querySelectorAll('.desk-dlg--prompt [role="option"] .tx-cmd-name')].map((e) => e.textContent)).toEqual(['/grill']);
    press('Enter');
    expect((box().textContent ?? '').replace(/​/g, '')).toBe('/grill ');
  });

  it('@r: lists the worker’s other floors; a worker with no agent has no `/`', async () => {
    const { overlay, of } = setup();
    overlay.open('A');
    type('@r:');
    expect(of('worker.repos').map((a) => a.args)).toEqual([{ id: 'A' }]);
    expect(status()).toBe('Loading repositories…');
    press('Escape');
    overlay.close();
    overlay.open('S');
    type(' /');
    expect(isOpen()).toBe(false);
  });
});
