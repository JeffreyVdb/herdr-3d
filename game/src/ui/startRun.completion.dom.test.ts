// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Hire, HireOptions, Preset, RunPrepare } from '../net/protocol';
import { PresetBook } from '../world/presets';
import { StartRunDialog, type StartRunHost } from './startRun';

// #39: Start run's Extra instructions and First prompt complete `/`, `@` and `@r:` of the orchestrator's hire (its
// floor, harness and folder): a repository picked in Extra on a board item (a Kaneo task) is plain text that the
// preview's run.prepare and the run.start carry; a stalled skill lookup holds only its popup.

const CAT: HireOptions = { claude: { models: ['claude-fable-5-1'], efforts: ['high'] }, codex: { models: ['gpt-6-sol'], efforts: ['high'] } };
const role = (model: string, harness = 'claude'): Hire => ({ harness, model, effort: 'high' });
const PRESET: Preset = {
  id: 'p_000000000001',
  name: 'Team',
  roles: { orch: role('gpt-6-sol', 'codex'), coder: role('claude-fable-5-1'), reviewer: role('claude-fable-5-1'), ux: role('claude-fable-5-1'), researcher: role('claude-fable-5-1') },
};
const ITEM = { provider: 'kaneo', id: 't1', key: 'HRD-3', title: 'Lobby lights', provider_name: 'Kaneo' };
const REPOS = { repos: [{ session: 'api', building: 'Work', same_building: true, repo: 'acme/api', dir: '/src/api', cloned: true }] };

interface Ask {
  t: string;
  args: Record<string, unknown>;
  answer(r: CommandResult): void;
}

function setup() {
  const asks: Ask[] = [];
  const book = new PresetBook();
  book.reset([PRESET]);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    presets: book,
    floorView: () => ({ seats: Array(10).fill(null), floor: {}, settings: {}, suggested: {} }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
    repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
  };
  const send = (t: string, args: Record<string, unknown>) => {
    if (t === 'run.prepare') {
      const extra = typeof args.extra === 'string' && args.extra.trim() ? `\n\n${args.extra.trim()}` : '';
      const prep: RunPrepare = {
        prompt: `$write-code Kaneo task HRD-3: Lobby lights\n\nTeam: …${extra}`,
        label: 'ORCH|hrd-3',
        preset: PRESET.id,
        orch: PRESET.roles.orch,
        cwd: '/home/test',
        git: null,
        capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
      };
      asks.push({ t, args, answer: () => {} });
      return Promise.resolve({ ok: true, data: prep });
    }
    return new Promise<CommandResult>((res) => asks.push({ t, args, answer: res }));
  };
  const host = {
    store,
    send,
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
    hireAt: () => {},
    openPresets: () => {},
    started: () => {},
  } as unknown as StartRunHost;
  const dlg = new StartRunDialog(document.body, host);
  return { dlg, asks, of: (t: string) => asks.filter((a) => a.t === t) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const editor = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const status = () => {
  const s = [...document.querySelectorAll<HTMLElement>('.desk-dlg--run .cmp-pop-status')].find((e) => !e.hidden && !e.closest('.cmp-pop')?.hasAttribute('hidden'));
  return s?.textContent ?? null;
};
const text = (id: string) => (editor(id).textContent ?? '').replace(/​/g, '');
function type(id: string, s: string): void {
  const ed = editor(id);
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
const press = (id: string, k: string, mod = false) => editor(id).dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: mod, bubbles: true, cancelable: true }));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  vi.stubGlobal('CSS', { escape: (s: string) => s });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Start run: completion in Extra instructions and the First prompt (#39)', () => {
  it('a Kaneo task: @r: in Extra puts a repository’s folder in, the preview and run.start carry it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dlg, of } = setup();
    dlg.open({ floor: 'floor', desk: 0, workItem: ITEM });
    await vi.runAllTimersAsync();
    type('run-extra', 'Please use @r:');
    expect(of('hire.repos').map((a) => a.args)).toEqual([{ floor: 'floor' }]);
    of('hire.repos')[0]!.answer({ ok: true, data: REPOS });
    await vi.runAllTimersAsync();
    press('run-extra', 'Enter');
    expect(text('run-extra')).toBe('Please use /src/api ');
    await vi.advanceTimersByTimeAsync(300);
    const prepares = of('run.prepare');
    expect(prepares.at(-1)!.args).toMatchObject({ floor: 'floor', work_item: { provider: 'kaneo', id: 't1' }, extra: 'Please use /src/api ' });
    expect(text('run-prompt')).toContain('Please use /src/api');
    vi.useRealTimers();
    press('run-extra', 'Enter', true);
    await flush();
    await flush();
    const start = of('run.start');
    expect(start).toHaveLength(1);
    expect(start[0]!.args).toMatchObject({ work_item: { provider: 'kaneo', id: 't1' }, extra: 'Please use /src/api ' });
  });

  it('with the skill lookup stalled: / says Loading skills… in Extra (the Codex orchestrator’s, the floor’s folder) and the run starts before it answers', async () => {
    const { dlg, of } = setup();
    dlg.open({ floor: 'floor', desk: 0, workItem: ITEM });
    await flush();
    type('run-extra', '/');
    expect(status()).toBe('Loading skills…');
    expect(of('hire.commands').map((a) => a.args)).toEqual([{ floor: 'floor', harness: 'codex', cwd: '/home/test' }]);
    press('run-extra', 'Escape');
    type('run-extra', ' keep it small');
    press('run-extra', 'Enter', true);
    await flush();
    await flush();
    expect(of('run.start')).toHaveLength(1);
    of('hire.commands')[0]!.answer({ ok: false, code: 'timeout', message: 'no answer' });
    await flush();
    expect(text('run-extra')).toBe('/ keep it small');
  });

  it('the edited First prompt completes too', async () => {
    const { dlg, of } = setup();
    dlg.open({ floor: 'floor', desk: 0, workItem: ITEM });
    await flush();
    await new Promise((r) => setTimeout(r, 300));
    type('run-prompt', ' @r:');
    expect(of('hire.repos')).toHaveLength(1);
  });
});
