// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HandoffCandidate, HandoffEntry, HandoffPreviewAck, Worker } from '../net/protocol';
import { HandoffBook } from '../world/handoff';
import { Cabinet } from './cabinet';
import { HandoffDialog } from './handoffDialog';

// #223: the filing dialog (exact text, provenance, the send-home choice, success and failure, a stale reply) and the
// cabinet (list, safe search snippets, sanitised preview, copy, delete with a confirm, hire from a handoff).

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 70000, images: 1 };
const TEXT = '  # Loader\n\n```go\nfunc main() {}\n```\n  ';
const PREVIEW: HandoffPreviewAck = {
  candidate: CAND,
  text: TEXT,
  truncated: true,
  title: 'Loader',
  provenance: { floor: 'herdr-3d', worker_name: 'Pixel', label: 'h3d-223', harness: 'claude', model: 'opus', branch: 'h3d/223-handoff', session: 'sess-123456789' },
  can_send_home: true,
};
const ENTRY: HandoffEntry = { id: 7, floor: 'herdr-3d', worker_id: 'A', worker_name: 'Pixel', branch: 'h3d/x', harness: 'claude', model: 'claude-opus-5-5', cwd: '/w/x', path: '/home/u/handoff/herdr-3d/20261010-1559-pixel-loader.md', title: 'Loader', created_at: Date.UTC(2026, 9, 10, 15, 59), source: 'literal', bytes: 300 };

type Reply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function setup(worker: Partial<Worker> = {}, replies: Record<string, Reply[]> = {}) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const copies: string[] = [];
  const cabinets: Array<[string, number | undefined]> = [];
  const hires: HandoffEntry[] = [];
  const w: Worker = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'h3d-223', agent_kind: 'claude', status: 'idle', handoff: CAND, ...worker } as Worker;
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: { 'herdr-3d': 1 } });
  const store = { workerView: (id: string) => (store.workers.get(id) ? { name: 'Pixel', desk: 2, harness: 'claude', display: 'idle', worker: store.workers.get(id) } : null), workers: new Map([['A', w]]), handoffs };
  const host = {
    store,
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => 0,
    copy: async (t: string) => (copies.push(t), true),
    openCabinet: (f: string, s?: number) => cabinets.push([f, s]),
    hireFrom: (e: HandoffEntry) => hires.push(e),
    send: (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, args });
      const q = replies[cmd];
      const r = q && q.length > 1 ? q.shift() : q?.[0];
      return Promise.resolve(r ?? { ok: true, data: {} });
    },
  };
  const flush = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-key="${key}"]`)!;
  const hook = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-hook="${key}"]`);
  return { host, store, w, sent, toasts, copies, cabinets, hires, flush, q, hook };
}

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

describe('HandoffDialog', () => {
  it('previews the exact text with its provenance, and files it literally (no send home unless ticked)', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }], 'worker.handoff': [{ ok: true, data: { handoff: ENTRY } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', candidate: 'cand-1' } });
    expect(e.hook('ho-text')?.textContent).toBe(TEXT); // as text, whitespace and fences kept
    expect(e.hook('ho-text')?.querySelector('*')).toBeNull();
    expect(e.hook('ho-title')?.textContent).toBe('Loader');
    expect(e.hook('ho-notes')?.textContent).toMatch(/the whole reply is filed.*An image in this message is not text/);
    expect(e.hook('ho-prov')?.textContent).toContain('h3d/223-handoff');
    e.q('file').click();
    await e.flush();
    const filed = e.sent.find((x) => x.cmd === 'worker.handoff');
    expect(filed?.args).toMatchObject({ worker: 'A', mode: 'literal', session: 'sess', candidate: 'cand-1', revision: 'rev-1' });
    expect(filed?.args.send_home).toBeUndefined();
    expect(String(filed?.args.op)).toMatch(/^ho-/);
    expect(d.summary().state).toBe('filed');
    expect(e.hook('ho-path')?.textContent).toBe(ENTRY.path);
    e.q('copy').click();
    await e.flush();
    expect(e.copies).toEqual([ENTRY.path]);
    e.q('cabinet').click();
    expect(e.cabinets).toEqual([['herdr-3d', 7]]);
  });

  it('sends home only when ticked, and says why it did not', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }], 'worker.handoff': [{ ok: true, data: { handoff: ENTRY, send_home: 'skipped', send_home_reason: 'Pixel is working' } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    const box = document.getElementById('ho-send-home') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(e.q('file').textContent).toContain('File, then send home');
    e.q('file').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'worker.handoff')?.args.send_home).toBe(true);
    expect(e.hook('ho-home')?.textContent).toBe('Pixel was not sent home: Pixel is working.');
  });

  it('offers no send home when the worker cannot go, and keeps the op on a retry after a failure', async () => {
    const e = setup({}, {
      'worker.handoff_preview': [{ ok: true, data: { ...PREVIEW, can_send_home: false, send_home_blocked: 'Pixel is blocked: it waits on you' } }],
      'worker.handoff': [
        { ok: false, code: 'handoff_failed', message: 'filing the handoff failed: disk full' },
        { ok: true, data: { handoff: ENTRY } },
      ],
    });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect((document.getElementById('ho-send-home') as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById('ho-send-hint')?.textContent).toContain('Not now: Pixel is blocked');
    e.q('file').click();
    await e.flush();
    expect(d.summary()).toMatchObject({ state: 'ready', error: true });
    expect(d.summary().status).toContain('Nobody was sent home');
    e.q('file').click();
    await e.flush();
    const ops = e.sent.filter((x) => x.cmd === 'worker.handoff').map((x) => x.args.op);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBe(ops[1]);
    expect(d.summary().state).toBe('filed');
  });

  it('a newer reply makes the preview stale: File is off until the latest is shown', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    e.w.handoff = { ...CAND, id: 'cand-2', revision: 'rev-2' };
    d.refresh();
    expect(d.summary().stale).toBe(true);
    expect(e.q('file').getAttribute('aria-disabled')).toBe('true');
    e.q('file').click();
    await e.flush();
    expect(e.sent.some((x) => x.cmd === 'worker.handoff')).toBe(false);
    e.q('reload').click();
    await e.flush();
    expect(e.sent.at(-1)).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', candidate: 'cand-2' } });
  });

  it('without a candidate it says why and offers nothing else (never a summary)', async () => {
    const e = setup({ status: 'working' });
    delete (e.w as Partial<Worker>).handoff;
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(d.summary().state).toBe('none');
    expect(e.hook('ho-why')?.textContent).toMatch(/working/);
    expect(e.sent).toEqual([]);
    expect([...document.querySelectorAll('.dd-actions button')].map((b) => b.textContent)).toEqual(['Close']);
  });
});

describe('Cabinet', () => {
  const LIST = { floor: 'herdr-3d', handoffs: [{ ...ENTRY, snippet: '…the \uE000<img src=x onerror="window.__pwned=1">\uE001 here…' }] };
  const BODY = '# Loader\n\n<script>window.__pwned=1</script><img src="https://evil/x.png" onerror="window.__pwned=1">\n\n- one';

  it('lists, searches with text-only snippets, shows sanitised Markdown, copies and hires from a handoff', async () => {
    const e = setup({}, { 'handoff.list': [{ ok: true, data: LIST }], 'handoff.get': [{ ok: true, data: { handoff: ENTRY, body: BODY } }] });
    const c = new Cabinet(document.body, e.host as never);
    c.open('herdr-3d');
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'handoff.list', args: { floor: 'herdr-3d' } });
    const mark = document.querySelector('.cab-snippet mark');
    expect(mark?.textContent).toBe('<img src=x onerror="window.__pwned=1">');
    expect(document.querySelector('.cab-snippet img')).toBeNull();
    (document.querySelector('.cab-row') as HTMLElement).click();
    await e.flush();
    const doc = e.hook('cab-doc') as HTMLElement;
    expect(doc.querySelector('h1')?.textContent).toBe('Loader');
    expect(doc.querySelector('script, img, [onerror]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    e.q('copy').click();
    await e.flush();
    expect(e.copies).toEqual([ENTRY.path]);
    e.q('hire').click();
    expect(e.hires.map((h) => h.id)).toEqual([7]);
  });

  it('deletes only after a confirm, to the trash', async () => {
    const e = setup({}, { 'handoff.list': [{ ok: true, data: LIST }], 'handoff.get': [{ ok: true, data: { handoff: ENTRY, body: 'x' } }], 'handoff.delete': [{ ok: true, data: { handoff: ENTRY } }] });
    const c = new Cabinet(document.body, e.host as never);
    c.open('herdr-3d', 7);
    await e.flush();
    expect(c.summary().selected).toBe(7);
    e.q('delete').click();
    expect(c.summary().confirming).toBe(true);
    expect(e.sent.some((x) => x.cmd === 'handoff.delete')).toBe(false);
    e.q('keep').click();
    expect(c.summary().confirming).toBe(false);
    e.q('delete').click();
    e.q('confirm-delete').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'handoff.delete')?.args).toEqual({ id: 7, confirm: true });
    expect(c.summary().rows).toEqual([]);
    expect(c.summary().status).toContain('trash');
  });
});
