// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TranscriptItem } from '../net/protocol';
import { loadRenderer, TranscriptMode } from './transcriptMode';
import { PRINT_WATCH_LIMIT } from './prints';
import { TranscriptWatches, WATCH_LIMIT } from './transcriptWatches';

/**
 * M16 end to end on the game's side: the real watch, the real seated-mode controller and the real render module
 * (loaded the way the game loads it), fed what the bridge sends for its own fixtures (game/fixtures/transcript, kept
 * in step with internal/transcript by its TestGameFixtures).
 */

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/transcript', name), 'utf8')) as TranscriptItem[];
const CLAUDE = fixture('claude.json');
const SUBAGENT = fixture('claude-subagent.json');
const CODEX = fixture('codex.json');
const CODEX_MCP = fixture('codex-mcp.json');

interface Sent {
  t: string;
  args: Record<string, unknown>;
  resolve: (r: CommandResult) => void;
}

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(until()).toBe(true);
};

function rig() {
  const sent: Sent[] = [];
  const send = (t: string, args: unknown) => new Promise<CommandResult>((resolve) => sent.push({ t, args: args as Record<string, unknown>, resolve }));
  const layer = document.createElement('div');
  document.body.append(layer);
  const status: Array<[string, string | null]> = [];
  const mode = new TranscriptMode({
    send,
    feed: () => null,
    renderer: loadRenderer,
    overlay: () => {
      const box = document.createElement('div');
      box.hidden = true;
      box.tabIndex = -1;
      layer.append(box);
      return box;
    },
    storage: null,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: () => {},
  });
  const watches = new TranscriptWatches({
    send,
    sink: { reset: (id, ack) => mode.reset(id, ack), push: (id, items, updates, head) => mode.push(id, items, updates, head), stop: () => {} },
    failed: () => {},
    closed: () => {},
    now: () => 0,
  });
  const last = (t: string) => [...sent].reverse().find((s) => s.t === t) as Sent;
  return { sent, layer, mode, watches, status, last };
}

let layer: HTMLElement | null = null;
afterEach(() => layer?.remove());

describe('transcript mode with the real render module', () => {
  it('clears a replaced session immediately, stays loading, and ignores late old responses', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w1', 'Nibble', true, 'codex');
    r.watches.sync(new Set(['w1']));
    const item = (text: string): TranscriptItem => ({ id: text, seq: 1, ts: 0, kind: 'user', parts: [{ text }] });
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'codex', session: 'old', items: [item('OLD CONVERSATION')], cursor: 'c:2', has_more: true } });
    await settle(() => layer?.textContent?.includes('OLD CONVERSATION') === true);
    const jump = r.mode.jump({ item_id: 'older', origin: 'input', source: 'inline' });
    const page = r.last('transcript.page');
    // A refresh is in flight when the bridge identifies a replacement.
    r.watches.refresh('w1');
    r.watches.sync(new Set(['w1']));
    const oldWatch = r.last('transcript.watch');
    r.watches.closed({ t: 'transcript.closed', id: 'w1', reason: 'session_changed' });
    expect(layer.textContent).not.toContain('OLD CONVERSATION');
    expect(r.mode.itemCount).toBe(0);
    expect(layer.querySelector<HTMLElement>('.txl')?.hidden).toBe(false);
    oldWatch.resolve({ ok: true, data: { session: 'old', items: [item('LATE OLD WATCH')] } });
    page.resolve({ ok: true, data: { items: [item('LATE OLD PAGE')] } });
    await jump;
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(0);
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'codex', session: 'new', pending: true, items: [] } });
    await Promise.resolve();
    expect(layer.querySelector<HTMLElement>('.txl')?.hidden).toBe(false);
    r.watches.items({ t: 'transcript.items', id: 'w1', harness: 'codex', session: 'new', pending: false, items: [item('NEW CONVERSATION')], updates: [] });
    await settle(() => layer?.textContent?.includes('NEW CONVERSATION') === true);
    expect(layer.textContent).not.toContain('OLD');
    expect(layer.querySelector<HTMLElement>('.txl')?.hidden).toBe(true);
    // A second close in the retry window clears the view before the delayed re-watch too.
    r.watches.closed({ t: 'transcript.closed', id: 'w1', reason: 'session_changed' });
    expect(layer.textContent).not.toContain('NEW CONVERSATION');
    expect(layer.querySelector<HTMLElement>('.txl')?.hidden).toBe(false);
    r.mode.stand();
  });

  it('Claude: sit, the watch acks, the view mounts over the bridge’s items; a subagent loads as a page', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w1', 'Ada');
    r.watches.sync(new Set(['w1']));
    expect(r.last('transcript.watch').args).toEqual({ id: 'w1', limit: 200 });
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: 's1', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, items: CLAUDE } });
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(CLAUDE.length);

    // #98: the conversation is up from the moment you sit.
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    expect(box.hidden).toBe(false);
    expect(r.mode.counts.mounted).toBe(1);
    const rowIds = () => [...box.querySelectorAll<HTMLElement>('.tx-list:not(.tx-nested) > .tx-item')].map((row) => row.dataset.id);
    // What the bridge hides waits for "show system" (#126: unbuilt till then); its other notices (an interrupt, command
    // output) are shown.
    const system = (it: TranscriptItem) => it.hidden === true || it.kind === 'unknown';
    const hidden = CLAUDE.filter(system).map((it) => it.id);
    expect(hidden.length).toBeGreaterThan(0);
    expect(rowIds()).toEqual(CLAUDE.filter((it) => !system(it)).map((it) => it.id));
    (box.querySelector('.tx-sys-toggle') as HTMLButtonElement).click();
    expect(rowIds()).toEqual(CLAUDE.map((it) => it.id));
    expect([...box.querySelectorAll<HTMLElement>('.tx-list:not(.tx-nested) > .tx-sys')].map((row) => row.dataset.id)).toEqual(hidden);
    (box.querySelector('.tx-sys-toggle') as HTMLButtonElement).click();
    const visibleNotices = CLAUDE.filter((it) => it.kind === 'notice' && !it.hidden);
    expect(visibleNotices.length).toBeGreaterThan(0);
    for (const n of visibleNotices) expect(box.querySelector(`[data-id="${CSS.escape(n.id)}"]`)?.classList.contains('tx-sys')).toBe(false);

    // The Edit's diff, from the bridge's snake_case hunks: real line numbers.
    const edit = CLAUDE.find((it) => it.tool?.name === 'Edit') as TranscriptItem;
    const editRow = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(edit.id)}"]`) as HTMLElement;
    (editRow.querySelector('.tx-tool-row') as HTMLButtonElement).click();
    expect(editRow.querySelector('.tx-diff-path')?.textContent).toBe(edit.tool?.diff?.path);
    expect(editRow.querySelector('.tx-dh')?.textContent).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(editRow.querySelector('.tx-dl:not(.tx-dh) .tx-dn')?.textContent).toMatch(/^\d+$/);

    // The Agent call: transcript.page with agent (newest page), not transcript.item.
    const sub = CLAUDE.find((it) => it.kind === 'subagent') as TranscriptItem;
    const subRow = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(sub.id)}"]`) as HTMLElement;
    (subRow.querySelector('.tx-sub-row') as HTMLButtonElement).click();
    const page = r.last('transcript.page');
    expect(page.args).toEqual({ id: 'w1', before: '', agent: sub.subagent?.agent_id, limit: 500 });
    expect(r.sent.some((s) => s.t === 'transcript.item')).toBe(false);
    page.resolve({ ok: true, data: { items: SUBAGENT, cursor: 'c:1', has_more: false } });
    await settle(() => !!subRow.querySelector('.tx-nested'));
    expect(subRow.querySelectorAll('.tx-nested > .tx-item').length).toBe(SUBAGENT.length);

    // Live: a tool's new state is an update in place, not a new row.
    const running = CLAUDE.find((it) => it.tool?.name === 'Bash') as TranscriptItem;
    const done: TranscriptItem = { ...running, tool: { ...(running.tool as NonNullable<TranscriptItem['tool']>), status: 'error', output_text: 'boom' } };
    r.watches.items({ t: 'transcript.items', id: 'w1', items: [], updates: [done] });
    expect(box.querySelectorAll('.tx-list:not(.tx-nested) > .tx-item').length).toBe(CLAUDE.length);
    expect(box.querySelector(`[data-id="${CSS.escape(running.id)}"]`)?.getAttribute('data-status')).toBe('error');

    // Back to the terminal: hidden, kept; standing up: gone.
    r.mode.toggle();
    expect(box.hidden).toBe(true);
    r.mode.stand();
    expect(box.isConnected).toBe(false);
    expect(r.mode.counts).toMatchObject({ mounted: 1, destroyed: 1, overlays: 1, removed: 1 });
  });

  it('Codex: a multi-file apply_patch shows every file, with no made-up line numbers', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w2', 'Bo');
    r.watches.sync(new Set(['w2']));
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'codex', session: 's2', version: '0.50.0', cursor: 'c:1', has_more: false, pending: false, items: CODEX } });
    await Promise.resolve();
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    const patch = CODEX.find((it) => it.tool?.name === 'apply_patch') as TranscriptItem;
    const row = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(patch.id)}"]`) as HTMLElement;
    (row.querySelector('.tx-tool-row') as HTMLButtonElement).click();
    const files = (patch.tool?.diffs ?? [patch.tool?.diff]).map((d) => d?.path);
    expect([...row.querySelectorAll('.tx-diff-path')].map((e) => e.textContent)).toEqual(files);
    expect([...row.querySelectorAll('.tx-dl .tx-dn')].every((n) => n.textContent === '')).toBe(true);
    r.mode.stand();
  });

  it('Codex #151: MCP calls the log holds only as events render as tool rows: server.tool, status, arguments and result behind a click', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w4', 'Di');
    r.watches.sync(new Set(['w4']));
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'codex', session: 's4', version: '0.50.0', cursor: 'c:1', has_more: false, pending: false, items: CODEX_MCP } });
    await Promise.resolve();
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    const row = (id: string) => box.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) as HTMLElement;
    const text = (el: HTMLElement, sel: string) => el.querySelector(sel)?.textContent;
    // [id, "<server>.<tool>", data-status, status label, a string in the arguments, a string in the result ('' for none)]
    const cases: Array<[string, string, string, string, string, string]> = [
      ['exec-0001', 'alterlab.alterlab_search', 'ok', 'done', '"num_results": 2', '2. Blog https://example.com/blog'],
      ['exec-0002', 'alterlab.alterlab_scrape', 'ok', 'done', '"formats"', '# Spec'],
      ['exec-0101', 'alterlab.alterlab_search', 'error', 'error', '"query": "slow query"', 'Gateway timeout for slow query.'],
      ['exec-0102', 'monday.all_api_read', 'error', 'error', 'items { id body }', 'Cannot query field "body" on type "Item".'],
      ['exec-0103', 'team-search.list_repo_groups', 'error', 'error', '', 'user rejected MCP tool call'],
      ['exec-0104', 'grafana.query', 'ok', 'done', '"expr": "up"', '{"rows":3}'],
      // Deduped: the start and its completion are one row, the finished call's response item and event are one row.
      ['exec-0201', 'alterlab.alterlab_search', 'ok', 'done', '"query": "dup query"', 'one result'],
      ['exec-0202', 'alterlab.alterlab_scrape', 'running', 'running', '"url": "https://example.com/slow"', ''],
      ['call_dup0001', 'mcp__alterlab.alterlab_search', 'ok', 'done', '"query": "both"', 'response text'],
      ['call_dup0002', 'mcp__alterlab.alterlab_search', 'ok', 'done', '"query": "early"', 'early response text'],
    ];
    for (const [id] of cases) expect(box.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)).toHaveLength(1);
    for (const [id, name, status, label, args, result] of cases) {
      const el = row(id);
      expect(el.classList.contains('tx-tool'), id).toBe(true);
      expect(el.getAttribute('data-status'), id).toBe(status);
      expect(text(el, '.tx-tool-name'), id).toBe(name);
      expect(text(el, '.tx-tool-status'), id).toBe(label);
      // Collapsed by default: nothing of the arguments or the result is in the DOM until the header is clicked.
      const head = el.querySelector('.tx-tool-row') as HTMLButtonElement;
      const body = el.querySelector('.tx-tool-body') as HTMLElement;
      expect(head.getAttribute('aria-expanded'), id).toBe('false');
      expect(body.hidden, id).toBe(true);
      expect(body.childNodes.length, id).toBe(0);
      head.click();
      expect(head.getAttribute('aria-expanded'), id).toBe('true');
      expect(body.hidden, id).toBe(false);
      if (args) expect(text(el, '.tx-input-json'), id).toContain(args);
      if (result) {
        expect(text(el, '.tx-out:not(.tx-input-json)'), id).toContain(result);
      } else {
        expect(text(el, '.tx-note'), id).toBe('Still running…');
      }
      head.click();
      expect(body.hidden, id).toBe(true);
    }
    // The summary beside the name is the call's main argument.
    expect(text(row('exec-0001'), '.tx-tool-sum')).toBe('model context protocol spec');
    // The enclosing exec call stays its own row, and the events that are not MCP calls stay hidden notices.
    expect(text(row('call_mcp_exec_a'), '.tx-tool-name')).toBe('exec');
    r.mode.stand();
  });

  it('sit, stand while a desk print keeps the watch, sit again: a new watch, its ack shows the history, live pushes after it', async () => {
    const r = rig();
    layer = r.layer;
    // As the laptop sits you down: the view starts empty, the watches are told so, then synced.
    const sit = (id: string) => {
      r.mode.sit(id, 'Ada');
      r.watches.refresh(id);
      r.watches.sync(new Map([[id, WATCH_LIMIT]]));
    };
    const ack = (items: TranscriptItem[]): CommandResult => ({ ok: true, data: { harness: 'claude', session: 's1', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, items } });
    const watches = () => r.sent.filter((s) => s.t === 'transcript.watch');
    sit('w1');
    watches()[0]?.resolve(ack(CLAUDE));
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(CLAUDE.length);

    // Stood up: the desk's print still wants a few items, so the watch of 200 stays.
    r.mode.stand();
    r.watches.sync(new Map([['w1', PRINT_WATCH_LIMIT]]));
    expect(r.sent.some((s) => s.t === 'transcript.unwatch')).toBe(false);
    expect(r.mode.itemCount).toBe(0);

    sit('w1');
    expect(watches().map((s) => s.args)).toEqual([
      { id: 'w1', limit: 200 },
      { id: 'w1', limit: 200 },
    ]);
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    watches()[1]?.resolve(ack(CLAUDE));
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(CLAUDE.length);
    expect(box.querySelectorAll('.tx-list:not(.tx-nested) > .tx-item').length).toBe(CLAUDE.filter((it) => it.hidden !== true && it.kind !== 'unknown').length);
    expect((box.querySelector('.tx-empty') as HTMLElement).hidden).toBe(true);

    // Live: appended after the history.
    const next: TranscriptItem = { id: 'live-1', seq: 10_000, ts: 0, kind: 'assistant', parts: [{ text: 'after' }] };
    r.watches.items({ t: 'transcript.items', id: 'w1', items: [next], updates: [] });
    expect(r.mode.itemCount).toBe(CLAUDE.length + 1);
    expect(box.querySelectorAll('.tx-list:not(.tx-nested) > .tx-item').length).toBe(CLAUDE.filter((it) => it.hidden !== true && it.kind !== 'unknown').length + 1);
    expect(box.querySelector('.tx-list:not(.tx-nested) > .tx-item:last-child')?.getAttribute('data-id')).toBe('live-1');
    r.mode.stand();
  });

  it("sit again while a print keeps the watch: the old watch's update landing before the new ack does not undo the ack's result", async () => {
    const r = rig();
    layer = r.layer;
    const sit = (id: string) => {
      r.mode.sit(id, 'Ada');
      r.watches.refresh(id);
      r.watches.sync(new Map([[id, WATCH_LIMIT]]));
    };
    const ack = (items: TranscriptItem[]): CommandResult => ({ ok: true, data: { harness: 'claude', session: 's1', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, items } });
    const watches = () => r.sent.filter((s) => s.t === 'transcript.watch');
    const bash = CLAUDE.find((it) => it.tool?.name === 'Bash') as TranscriptItem;
    const { output_text: _, ...tool } = bash.tool as NonNullable<TranscriptItem['tool']>;
    const running: TranscriptItem = { ...bash, tool: { ...tool, status: 'running' } };
    const done: TranscriptItem = { ...bash, tool: { ...tool, status: 'ok', output_text: 'the-result-of-ls' } };
    const withTool = (t: TranscriptItem) => CLAUDE.map((it) => (it.id === t.id ? t : it));

    sit('w1');
    watches()[0]?.resolve(ack(withTool(running)));
    await Promise.resolve();
    r.mode.stand();
    r.watches.sync(new Map([['w1', PRINT_WATCH_LIMIT]]));
    sit('w1');
    expect(watches()).toHaveLength(2);
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));

    // The replaced watch's push (the call still running) lands while the new ack is on its way; that ack has the result.
    r.watches.items({ t: 'transcript.items', id: 'w1', items: [], updates: [running] });
    watches()[1]?.resolve(ack(withTool(done)));
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(CLAUDE.length);
    const row = () => box.querySelector<HTMLElement>(`[data-id="${CSS.escape(bash.id)}"]`) as HTMLElement;
    expect(row().getAttribute('data-status')).toBe('ok');
    (row().querySelector('.tx-tool-row') as HTMLButtonElement).click();
    await settle(() => row().textContent?.includes('the-result-of-ls') ?? false);

    // The new watch's live pushes still apply.
    const failed: TranscriptItem = { ...done, tool: { ...tool, status: 'error', output_text: 'boom' } };
    const next: TranscriptItem = { id: 'live-1', seq: 10_000, ts: 0, kind: 'assistant', parts: [{ text: 'after' }] };
    r.watches.items({ t: 'transcript.items', id: 'w1', items: [next], updates: [failed] });
    expect(r.mode.itemCount).toBe(CLAUDE.length + 1);
    expect(row().getAttribute('data-status')).toBe('error');
    r.mode.stand();
  });

  it('a pending watch: the first push (with the head) fills the view', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w3', 'Cy');
    r.watches.sync(new Set(['w3']));
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: '', version: '', cursor: 'c:1', has_more: false, pending: true, items: [] } });
    await Promise.resolve();
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    expect((box.querySelector('.tx-empty') as HTMLElement).hidden).toBe(true);
    expect((box.querySelector('.txl') as HTMLElement).hidden).toBe(false); // #192: pending identity stays loading
    r.watches.items({ t: 'transcript.items', id: 'w3', items: CLAUDE.slice(0, 3), updates: [], harness: 'claude', session: 's3', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false });
    expect(box.querySelectorAll('.tx-list > .tx-item').length).toBe(3);
    expect((box.querySelector('.tx-empty') as HTMLElement).hidden).toBe(true);
    r.mode.stand();
  });

  it('#141: sitting again while a prompt is on its way shows it sending and sends it once; the ack clears it', async () => {
    const r = rig();
    layer = r.layer;
    const prompts = () => r.sent.filter((s) => s.t === 'worker.prompt');
    const input = () => r.layer.querySelector('.tx-input') as HTMLElement;
    const sendBtn = () => r.layer.querySelector('.tx-send') as HTMLButtonElement;
    const sit = async () => {
      r.mode.sit('w1', 'Ada', true, 'claude');
      await settle(() => !!r.layer.querySelector('.tx-input'));
    };
    await sit();
    input().replaceChildren(document.createTextNode('go'));
    document.getSelection()?.setBaseAndExtent(input().firstChild as Text, 2, input().firstChild as Text, 2);
    input().dispatchEvent(new Event('input', { bubbles: true }));
    sendBtn().click();
    await settle(() => prompts().length === 1);
    expect(prompts()[0]?.args).toEqual({ id: 'w1', text: 'go' });

    // Up and back down at the same desk before the bridge answers: the draft is still the one on its way.
    r.mode.stand();
    await sit();
    expect(input().textContent).toBe('go');
    expect(input().getAttribute('contenteditable')).toBe('false');
    expect(input().getAttribute('aria-busy')).toBe('true');
    sendBtn().click();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 20));
    expect(prompts()).toHaveLength(1);

    // The first send's ack lands with the second view up: the box empties and takes a prompt again.
    prompts()[0]?.resolve({ ok: true, data: {} });
    await settle(() => input().getAttribute('contenteditable') === 'true');
    expect((input().textContent ?? '').replace(/\u200B/g, '')).toBe('');
    expect(input().getAttribute('aria-busy')).toBe('false');
    r.mode.stand();
  });
});

describe('#26: a child’s conversation with the real render module', () => {
  it('the board opens a child: its breadcrumb, its own items live, pending words, and back to the worker’s view as it was', async () => {
    const sent: Sent[] = [];
    const send = (t: string, args: unknown) => new Promise<CommandResult>((resolve) => sent.push({ t, args: args as Record<string, unknown>, resolve }));
    const root = document.createElement('div');
    document.body.append(root);
    layer = root;
    const status: Array<[string, string | null]> = [];
    let watches: TranscriptWatches | null = null;
    const mode = new TranscriptMode({
      send,
      feed: () => null,
      renderer: loadRenderer,
      overlay: () => {
        const box = document.createElement('div');
        box.hidden = true;
        root.append(box);
        return box;
      },
      pane: (box) => {
        const p = document.createElement('div');
        p.className = 'seat-pane';
        box.append(p);
        return p;
      },
      storage: null,
      status: (kind, text) => status.push([kind, text]),
      modeChanged: () => {},
      childChanged: () => sync(),
    });
    watches = new TranscriptWatches({
      send,
      sink: {
        reset: (id, ack, child) => (child ? mode.resetChild(id, child, ack) : mode.reset(id, ack)),
        push: (id, items, updates, head, child) => (child ? mode.pushChild(id, child, items, updates, head) : mode.push(id, items, updates, head)),
        stop: () => {},
      },
      failed: () => {},
      closed: () => {},
      now: () => 0,
    });
    const sync = () => {
      const child = mode.child;
      watches?.sync(new Set(['w1']), child ? [{ id: 'w1', child }] : []);
    };
    const last = (t: string) => [...sent].reverse().find((s) => s.t === t) as Sent;
    mode.place({ left: 0, top: 0, width: 900, height: 700 });
    mode.sit('w1', 'Nibble', true, 'claude');
    sync();
    last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: 's1', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, items: CLAUDE } });
    await settle(() => root.querySelectorAll('.tx-item').length > 0);
    const parentView = root.querySelector('.tx') as HTMLElement;
    const parentRows = parentView.querySelectorAll('.tx-item').length;

    const ada = { id: 'ch_ada', generation: 4, provider: 'claude' };
    mode.openChild(ada, { name: 'Explore', type: null, description: 'Check the other seated overlays', state: 'running', since: 'running 2m' });
    expect(last('transcript.watch').args).toEqual({ id: 'w1', limit: 200, child: ada });
    await settle(() => root.querySelectorAll('.tx').length === 2);
    const childView = [...root.querySelectorAll<HTMLElement>('.tx')].find((v) => v !== parentView) as HTMLElement;
    // The breadcrumb: back to the worker (a control), the child with its state; no prompt box; why it is empty.
    const back = childView.querySelector<HTMLButtonElement>('.tx-crumb-back');
    expect(back?.textContent).toBe('Nibble');
    expect(back?.getAttribute('aria-label')).toBe('Back to Nibble’s conversation');
    expect(childView.querySelector('.tx-crumb-here')?.getAttribute('aria-current')).toBe('page');
    expect(childView.querySelector('.tx-crumb-name')?.textContent).toBe('Explore');
    expect(childView.querySelector('.tx-crumbs')?.getAttribute('data-state')).toBe('running');
    expect(childView.querySelector('.tx-crumb-state')?.textContent).toBe('running 2m');
    expect(childView.querySelector('.tx-title')).toBeNull();
    expect(childView.querySelector('.tx-child-foot')?.textContent).toContain('Back to Nibble');
    // #126: until its watch answers it is opening (the outline, its words), not empty.
    expect(childView.querySelector<HTMLElement>('.tx-empty')?.hidden).toBe(true);
    expect(childView.querySelector<HTMLElement>('.txl')?.hidden).toBe(false);
    expect(childView.querySelector('.txl')?.textContent).toBe('Opening Explore’s conversation…');
    expect((parentView.parentElement as HTMLElement).hidden).toBe(true);

    // Not written yet: said so (its own words, not the outline). Then it appears, live on the same watch.
    last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: '', version: '', cursor: 'c:1', has_more: false, pending: true, availability: 'pending', items: [] } });
    await settle(() => childView.querySelector('.tx-empty')?.textContent?.startsWith('Explore hasn’t written anything yet') === true);
    expect(childView.querySelector<HTMLElement>('.tx-empty')?.hidden).toBe(false);
    expect(childView.querySelector<HTMLElement>('.txl')?.hidden).toBe(true);
    watches.items({ t: 'transcript.items', id: 'w1', child: ada, items: SUBAGENT, updates: [], harness: 'claude', session: 'aa37', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, availability: 'available' });
    await settle(() => childView.querySelectorAll('.tx-item').length > 0);
    expect(childView.querySelector<HTMLElement>('.tx-empty')?.hidden).toBe(true);
    expect(parentView.querySelectorAll('.tx-item').length).toBe(parentRows);

    // Back: the child's watch goes, the worker's view is the one it was.
    back?.click();
    await settle(() => root.querySelectorAll('.tx').length === 1);
    expect(root.querySelector('.tx')).toBe(parentView);
    expect((parentView.parentElement as HTMLElement).hidden).toBe(false);
    expect(parentView.querySelectorAll('.tx-item').length).toBe(parentRows);
    expect(last('transcript.unwatch').args).toEqual({ id: 'w1', child: ada });
    expect(watches.ids()).toEqual(['w1']);
    mode.stand();
  });
});
