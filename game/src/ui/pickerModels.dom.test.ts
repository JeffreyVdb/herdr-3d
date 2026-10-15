// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hire, HireOptions, Preset, RunPrepare } from '../net/protocol';
import { PresetBook } from '../world/presets';
import { HireModelPrefs } from './hireModelPrefs';
import { PresetsPanel, type PresetsHost } from './presets';
import { StartRunDialog, type StartRunHost } from './startRun';

// The other model pickers (Start run's orchestrator, the team preset editor) name models as Hire does (#200) and offer
// the models Settings → Harness models leaves shown (#194). Fixture slugs only; nothing here is an app default.

const CAT: HireOptions = {
  claude: {
    models: ['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-lab'],
    efforts: ['low', 'high'],
    model_labels: { 'claude-opus-5': 'Opus 5', 'claude-lab': '<b>Lab</b>' },
  },
  codex: { models: ['gpt-6.1-sol', 'gpt-6-sol'], efforts: ['high'], model_labels: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const role = (model: string, harness = 'claude'): Hire => ({ harness, model, effort: 'high' });
const PRESET: Preset = {
  id: 'p_000000000001',
  name: 'Team',
  roles: { orch: role('claude-fable-5-1'), coder: role('claude-opus-5-5'), reviewer: role('gpt-6-sol', 'codex'), ux: role('claude-opus-5'), researcher: role('claude-lab') },
};

function bookOf(...list: Preset[]): PresetBook {
  const b = new PresetBook();
  b.reset(list);
  return b;
}

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
});

describe('Start run: the orchestrator model chips', () => {
  const setup = (prefs: HireModelPrefs, orch: Hire = PRESET.roles.orch) => {
    const prep: RunPrepare = { prompt: '', label: '', preset: PRESET.id, orch, cwd: '/home/test', git: null, capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } } };
    const store = {
    floorName: (id: string) => id,
      hireOptions: CAT,
      presets: bookOf(PRESET),
      floorView: () => ({ seats: Array(10).fill(null), floor: {}, settings: {}, suggested: {} }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
    };
    const host = {
      store,
      modelPrefs: prefs,
      showModelSettings: vi.fn(),
      send: vi.fn(async (t: string) => (t === 'run.prepare' ? { ok: true, data: prep } : await new Promise(() => {}))),
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
    return { dlg, host };
  };
  const chipTexts = () => [...document.querySelectorAll<HTMLElement>('[data-pick="orch-model"] .dd-chip')].map((l) => l.querySelector('span')!.firstChild!.textContent);
  const chipValues = () => [...document.querySelectorAll<HTMLInputElement>('[data-pick="orch-model"] input')].map((i) => i.value);
  const orch = (dlg: StartRunDialog) => (dlg.summary() as { form: { orch: Hire | null } }).form.orch;

  it('names the models, keeps the exact id as the value, and renders labels as text', async () => {
    const { dlg } = setup(new HireModelPrefs(memory()));
    dlg.open({ floor: 'floor', desk: 0 });
    await tick();
    expect(chipTexts()).toEqual(['Opus 5', 'Opus 5.5', 'Fable 5.1', '<b>Lab</b>']);
    expect(chipValues()).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-lab']);
    expect(document.querySelector('[data-pick="orch-model"] b')).toBeNull();
    document.querySelector<HTMLInputElement>('[data-key="orch-harness:codex"]')!.click();
    expect(chipTexts()).toEqual(['GPT 6.1 Sol', 'GPT 6 Sol']);
  });

  it('offers only the models Settings leaves shown, plus the preset’s orchestrator even when hidden', async () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('claude', 'claude-opus-5', false);
    prefs.setShown('claude', 'claude-fable-5-1', false);
    const { dlg } = setup(prefs);
    dlg.open({ floor: 'floor', desk: 0 });
    await tick();
    expect(chipValues()).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-lab']);
    expect(orch(dlg)).toEqual(PRESET.roles.orch);
  });

  it('follows Settings while open: a newly hidden model goes, an orchestrator on it takes the first shown one', async () => {
    const prefs = new HireModelPrefs(memory());
    const { dlg } = setup(prefs, role('claude-opus-5-5'));
    dlg.open({ floor: 'floor', desk: 0 });
    await tick();
    expect(orch(dlg)?.model).toBe('claude-opus-5-5');
    prefs.setShown('claude', 'claude-opus-5-5', false);
    expect(chipValues()).toEqual(['claude-opus-5', 'claude-fable-5-1', 'claude-lab']);
    expect(orch(dlg)?.model).toBe('claude-opus-5');
  });

  it('a harness with every model hidden says so instead of offering chips', async () => {
    const prefs = new HireModelPrefs(memory());
    for (const m of CAT.codex!.models) prefs.setShown('codex', m, false);
    const { dlg, host } = setup(prefs);
    dlg.open({ floor: 'floor', desk: 0 });
    await tick();
    document.querySelector<HTMLInputElement>('[data-key="orch-harness:codex"]')!.click();
    expect(orch(dlg)).toEqual({ harness: 'codex', model: '', effort: '' });
    expect(document.querySelector('[data-pick="orch-model"]')).toBeNull();
    const none = document.querySelector<HTMLElement>('[data-hook="no-models"]')!;
    expect(none.textContent).toContain('All 2 Codex models are hidden');
    none.querySelector<HTMLButtonElement>('[data-key="show-models"]')!.click();
    expect(host.showModelSettings).toHaveBeenCalled();
  });
});

describe('Team presets: names and the models Settings leaves shown', () => {
  const setup = (prefs: HireModelPrefs) => {
    const host: PresetsHost = {
      store: { hireOptions: CAT, presets: bookOf(PRESET) } as unknown as PresetsHost['store'],
      send: vi.fn(async () => await new Promise<never>(() => {})),
      unsupported: () => false,
      toast: () => {},
      modelPrefs: prefs,
    };
    return new PresetsPanel(document.body, host);
  };
  const options = (key: string) => [...document.querySelectorAll<HTMLOptionElement>(`[data-key="${key}"] option`)].map((o) => [o.value, o.textContent]);
  const value = (key: string) => document.querySelector<HTMLSelectElement>(`[data-key="${key}"]`)!.value;

  it('the list names each role’s model', () => {
    setup(new HireModelPrefs(memory())).open();
    const lines = [...document.querySelectorAll('.pp-roles dd')].map((d) => d.textContent);
    expect(lines).toEqual(['claude · Fable 5.1 · high', 'claude · Opus 5.5 · high', 'codex · GPT 6 Sol · high', 'claude · Opus 5 · high', 'claude · <b>Lab</b> · high']);
  });

  it('the editor names the models (value: the exact id) and offers the shown ones plus the role’s saved model', () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('claude', 'claude-opus-5', false);
    prefs.setShown('claude', 'claude-fable-5-1', false);
    setup(prefs).open();
    document.querySelector<HTMLButtonElement>(`[data-key="edit:${PRESET.id}"]`)!.click();
    // The orchestrator is saved on the hidden Fable 5.1: kept, and still chosen. Opus 5 (hidden, saved by ux) only there.
    expect(options('role:orch:model')).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-fable-5-1', 'Fable 5.1'],
      ['claude-lab', '<b>Lab</b>'],
    ]);
    expect(value('role:orch:model')).toBe('claude-fable-5-1');
    expect(options('role:coder:model').map(([v]) => v)).toEqual(['claude-opus-5-5', 'claude-lab']);
    expect(options('role:ux:model').map(([v]) => v)).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-lab']);
    expect(document.querySelector('[data-key="role:researcher:model"] b')).toBeNull();
  });

  it('a new preset starts on shown models only', () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('claude', 'claude-fable-5-1', false);
    setup(prefs).open();
    document.querySelector<HTMLButtonElement>('[data-key="new"]')!.click();
    // The default preset's orchestrator (Fable 5.1) is hidden: the new one takes the first shown model.
    expect(value('role:orch:model')).toBe('claude-opus-5');
    expect(options('role:orch:model').map(([v]) => v)).not.toContain('claude-fable-5-1');
  });
});
