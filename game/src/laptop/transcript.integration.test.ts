// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TranscriptItem } from '../net/protocol';
import { loadRenderer, TranscriptMode } from './transcriptMode';
import { TranscriptWatches } from './transcriptWatches';

/**
 * M16 end to end on the game's side: the real watch, the real seated-mode controller and the real render module
 * (loaded the way the game loads it), fed what the bridge sends for its own fixtures (game/fixtures/transcript, kept
 * in step with internal/transcript by its TestGameFixtures).
 */

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/transcript', name), 'utf8')) as TranscriptItem[];
const CLAUDE = fixture('claude.json');
const SUBAGENT = fixture('claude-subagent.json');
const CODEX = fixture('codex.json');

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
    sink: { reset: (id, ack) => mode.reset(id, ack), push: (id, items, updates) => mode.push(id, items, updates), stop: () => {} },
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
  it('Claude: sit, the watch acks, Ctrl+Esc mounts the view over the bridge’s items; a subagent loads as a page', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w1', 'Ada');
    r.watches.sync(new Set(['w1']));
    expect(r.last('transcript.watch').args).toEqual({ id: 'w1', limit: 200 });
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: 's1', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false, items: CLAUDE } });
    await Promise.resolve();
    expect(r.mode.itemCount).toBe(CLAUDE.length);

    r.mode.toggle();
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    expect(box.hidden).toBe(false);
    expect(r.mode.counts.mounted).toBe(1);
    const rows = [...box.querySelectorAll<HTMLElement>('.tx-list:not(.tx-nested) > .tx-item')];
    expect(rows.length).toBe(CLAUDE.length);
    // What the bridge hides waits for "show system"; its other notices (an interrupt, command output) are shown.
    const hidden = CLAUDE.filter((it) => it.hidden).map((it) => it.id);
    expect(rows.filter((row) => row.classList.contains('tx-sys')).map((row) => row.dataset.id)).toEqual(hidden);
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
    expect(r.mode.counts).toEqual({ mounted: 1, destroyed: 1, overlays: 1, removed: 1 });
  });

  it('Codex: a multi-file apply_patch shows every file, with no made-up line numbers', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w2', 'Bo');
    r.watches.sync(new Set(['w2']));
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'codex', session: 's2', version: '0.50.0', cursor: 'c:1', has_more: false, pending: false, items: CODEX } });
    await Promise.resolve();
    r.mode.toggle();
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

  it('a pending watch: the first push (with the head) fills the view', async () => {
    const r = rig();
    layer = r.layer;
    r.mode.sit('w3', 'Cy');
    r.watches.sync(new Set(['w3']));
    r.last('transcript.watch').resolve({ ok: true, data: { harness: 'claude', session: '', version: '', cursor: 'c:1', has_more: false, pending: true, items: [] } });
    await Promise.resolve();
    r.mode.toggle();
    const box = r.mode.box as HTMLElement;
    await settle(() => !!box.querySelector('.tx'));
    expect((box.querySelector('.tx-empty') as HTMLElement).hidden).toBe(false);
    r.watches.items({ t: 'transcript.items', id: 'w3', items: CLAUDE.slice(0, 3), updates: [], harness: 'claude', session: 's3', version: '2.1.0', cursor: 'c:1', has_more: false, pending: false });
    expect(box.querySelectorAll('.tx-list > .tx-item').length).toBe(3);
    expect((box.querySelector('.tx-empty') as HTMLElement).hidden).toBe(true);
    r.mode.stand();
  });
});
