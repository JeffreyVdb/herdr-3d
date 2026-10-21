// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexProfile, CodexProfilesState, HireOptions, HirePrepare, Limits } from '../net/protocol';
import { HireDialog, type HireHost, type HirePrefill } from './hire';
import { HireModelPrefs } from './hireModelPrefs';
import { LimitBook } from '../world/limits';

// #139: the hire dialog's "Codex profile": not there with one profile (the dialog as before), a list with two or more,
// the default picked first; hidden and gone profiles not offered, one not signed in shown and not pickable; a preset's
// profile picked, or the default with a note when it is gone; the limits line of the profile picked. Fixture names only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2'], efforts: ['low', 'high'] },
  claude: { models: ['y-1'], efforts: ['low', 'high'] },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const prep: HirePrepare = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'x-1', effort: 'low' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};

const prof = (key: string, more: Partial<CodexProfile> = {}): CodexProfile => ({
  key,
  name: key,
  path: `/home/test/.codex-${key}`,
  display: `~/.codex-${key}`,
  plan: '',
  signed_in: true,
  default: false,
  hidden: false,
  added: false,
  ...more,
});
const own = prof('codex', { default: true, path: '/home/test/.codex', display: '~/.codex' });
const TWO: CodexProfilesState = { hire: true, profiles: [own, prof('work', { name: 'Work seat' })] };

const reading = (key: string, pct: number): Limits => ({
  provider: 'codex',
  plan: 'team',
  windows: [{ label: '5h', pct, resets_at: Date.now() + 3600_000, window_mins: 300 }],
  at: Date.now(),
  stale: false,
  source: 'probe',
  account: { key, name: key, plan: 'team', default: key === 'codex' },
});

function setup(profiles: CodexProfilesState | null, limits: Limits[] = []) {
  const hires: Record<string, unknown>[] = [];
  const send = vi.fn(async (t: string, args: Record<string, unknown>) => {
    if (t === 'hire.prepare') return { ok: true, data: prep };
    if (t === 'worker.hire') {
      hires.push(args);
      return { ok: true, data: { id: `w${hires.length}` } };
    }
    return { ok: false, code: 'unknown_command', message: '' };
  });
  const book = new LimitBook();
  book.reset(limits);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    floorView: () => ({ seats: Array(10).fill(null) }),
    limits: book,
    workerView: () => null,
    hirePresets: { known: true, instructions: false },
    codexProfiles: { state: profiles },
  };
  const savePreset = vi.fn();
  const host = {
    store,
    modelPrefs: new HireModelPrefs(memory()),
    send,
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
    savePreset,
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, hires, savePreset, inner: dlg as unknown as { hire(): Promise<void> } };
}

const field = () => document.querySelector<HTMLFieldSetElement>('[data-pick="codex-profile"]');
const chip = (key: string) => document.querySelector<HTMLInputElement>(`[data-key="codex-profile:${key}"]`);
const pick = (name: string, value: string) => {
  const c = document.querySelector<HTMLInputElement>(`[data-key="${name}:${value}"]`) as HTMLInputElement;
  c.checked = true;
  c.dispatchEvent(new Event('change'));
};
const fromPreset = (profile: string): HirePrefill => ({
  prompt: 'Review it.',
  choice: { harness: 'codex', model: 'x-1', effort: 'low' },
  preset: { id: 'hp_1', name: 'Review', scope: 'floor', profile },
});

describe('HireDialog: Codex profile (#139)', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('has no profile field with one visible profile, and sends no profile: the dialog as before', async () => {
    for (const state of [null, { hire: true, profiles: [own, prof('shy', { hidden: true }), prof('gone', { added: true, missing: true })] }, { profiles: TWO.profiles }]) {
      const { dlg, hires, inner } = setup(state);
      dlg.open('floor', 0);
      await tick();
      expect(field()).toBeNull();
      await inner.hire();
      expect(hires.at(-1)).not.toHaveProperty('codex_profile');
      dlg.close();
      document.body.replaceChildren();
    }
  });

  it('lists the profiles by name with two or more, the default picked; a hire sends the one picked', async () => {
    const { dlg, hires, inner } = setup(TWO);
    dlg.open('floor', 0);
    await tick();
    expect([...(field()?.querySelectorAll('.dd-chip') ?? [])].map((c) => c.textContent)).toEqual(['codex', 'Work seat']);
    expect(field()?.querySelector('legend')?.textContent).toBe('Codex profile');
    expect(chip('codex')?.checked).toBe(true);
    pick('codex-profile', 'work');
    expect(chip('work')?.checked).toBe(true);
    await inner.hire();
    expect(hires[0]).toMatchObject({ harness: 'codex', codex_profile: 'work' });
  });

  it('offers no hidden or gone profile, and shows one not signed in that cannot be picked', async () => {
    const state: CodexProfilesState = {
      hire: true,
      profiles: [own, prof('work'), prof('shy', { hidden: true }), prof('gone', { added: true, missing: true }), prof('new', { signed_in: false })],
    };
    const { dlg } = setup(state);
    dlg.open('floor', 0);
    await tick();
    expect([...(field()?.querySelectorAll('input') ?? [])].map((i) => i.value)).toEqual(['codex', 'work', 'new']);
    expect(chip('new')?.disabled).toBe(true);
    expect(chip('new')?.closest('label')?.textContent).toBe('newnot signed in');
    expect(chip('work')?.disabled).toBe(false);
  });

  it('is only for Codex: a Claude hire has no profile field and sends none', async () => {
    const { dlg, hires, inner } = setup(TWO);
    dlg.open('floor', 0);
    await tick();
    pick('harness', 'claude');
    expect(field()).toBeNull();
    await inner.hire();
    expect(hires[0]).not.toHaveProperty('codex_profile');
  });

  it('starts on a preset’s profile; a gone one falls back to the default and says so', async () => {
    let { dlg } = setup(TWO);
    dlg.open('floor', 0, fromPreset('work'));
    await tick();
    expect(chip('work')?.checked).toBe(true);
    expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
    dlg.close();
    document.body.replaceChildren();
    ({ dlg } = setup(TWO));
    dlg.open('floor', 0, fromPreset('old'));
    await tick();
    expect(chip('codex')?.checked).toBe(true);
    expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “old” is gone: it hires on codex.');
  });

  it('a preset whose profile is gone says so also with only the default left (no picker), and hires on it', async () => {
    for (const state of [{ hire: true, profiles: [own] }, { hire: true, profiles: [own, prof('work', { hidden: true })] }]) {
      const { dlg, hires, inner } = setup(state);
      dlg.open('floor', 0, fromPreset('work'));
      await tick();
      expect(field()).toBeNull();
      expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “work” is gone: it hires on codex.');
      await inner.hire();
      expect(hires.at(-1)).not.toHaveProperty('codex_profile');
      dlg.close();
      document.body.replaceChildren();
    }
    // Nothing for a preset on the default, nor from a bridge that hires on no profile.
    for (const [state, want] of [[{ hire: true, profiles: [own] }, 'codex'], [{ profiles: [own] }, 'work']] as [CodexProfilesState, string][]) {
      const { dlg } = setup(state);
      dlg.open('floor', 0, fromPreset(want));
      await tick();
      expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
      dlg.close();
      document.body.replaceChildren();
    }
  });

  it('“Save as preset…” hands the profile picked to the preset editor', async () => {
    const { dlg, savePreset } = setup(TWO);
    dlg.open('floor', 0);
    await tick();
    pick('codex-profile', 'work');
    document.querySelector<HTMLButtonElement>('[data-key="save-preset"]')?.click();
    expect(savePreset.mock.calls[0]?.[0]).toMatchObject({ harness: 'codex', profile: 'work' });
  });

  it('shows the limits of the profile picked', async () => {
    const { dlg } = setup(TWO, [reading('codex', 41), reading('work', 77)]);
    dlg.open('floor', 0);
    await tick();
    const limits = () => document.querySelector('[data-hook="plan-limits"]')?.textContent ?? '';
    expect(limits()).toContain('41%');
    expect(limits()).not.toContain('77%');
    pick('codex-profile', 'work');
    expect(limits()).toContain('77%');
    expect(limits()).not.toContain('41%');
  });
});

// #140: Auto: the first chip and a new Codex hire's default on a bridge that takes it; it sends "auto". A preset with
// Auto starts on it, one with a profile keeps it (manual wins), one with none keeps meaning the default. With one usable
// profile the dialog is as before: no picker, nothing sent.
describe('HireDialog: Auto (#140)', () => {
  const AUTO: CodexProfilesState = { ...TWO, auto: true, rules: [] };
  beforeEach(() => {
    localStorage.clear();
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

  it('comes first and is picked for a new Codex hire, says what it does, and sends "auto"', async () => {
    const { dlg, hires, inner } = setup(AUTO, [reading('codex', 41)]);
    dlg.open('floor', 0);
    await tick();
    expect([...(field()?.querySelectorAll('.dd-chip') ?? [])].map((c) => c.textContent)).toEqual(['Auto', 'codex', 'Work seat']);
    expect(chip('auto')?.checked).toBe(true);
    expect(document.querySelector('[data-hook="profile-auto"]')?.textContent).toContain('The bridge picks at hire');
    // No preview of the pick: no Codex limits line while Auto is picked.
    expect(document.querySelector('[data-hook="plan-limits"]')?.textContent ?? '').not.toContain('41%');
    await inner.hire();
    expect(hires[0]).toMatchObject({ harness: 'codex', codex_profile: 'auto' });
  });

  it('a profile picked by hand is sent as it is, and the hint goes', async () => {
    const { dlg, hires, inner } = setup(AUTO);
    dlg.open('floor', 0);
    await tick();
    pick('codex-profile', 'codex');
    expect(document.querySelector('[data-hook="profile-auto"]')).toBeNull();
    await inner.hire();
    expect(hires[0]).toMatchObject({ codex_profile: 'codex' });
  });

  it('a preset: Auto starts on Auto, a profile on that profile, none on the default', async () => {
    for (const [want, checked] of [['auto', 'auto'], ['work', 'work'], ['', 'codex']] as const) {
      const { dlg, hires, inner } = setup(AUTO);
      dlg.open('floor', 0, fromPreset(want));
      await tick();
      expect(chip(checked)?.checked).toBe(true);
      expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
      await inner.hire();
      expect(hires.at(-1)).toMatchObject({ codex_profile: checked });
      dlg.close();
      document.body.replaceChildren();
    }
  });

  it('with one usable profile there is no picker and nothing is sent, also from an Auto preset', async () => {
    const one: CodexProfilesState = { hire: true, auto: true, rules: [], profiles: [own, prof('shy', { hidden: true })] };
    for (const prefill of [undefined, fromPreset('auto')]) {
      const { dlg, hires, inner } = setup(one);
      dlg.open('floor', 0, prefill);
      await tick();
      expect(field()).toBeNull();
      expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
      await inner.hire();
      expect(hires.at(-1)).not.toHaveProperty('codex_profile');
      dlg.close();
      document.body.replaceChildren();
    }
  });

  it('a bridge without Auto: no Auto chip, the default picked, an Auto preset hires on the default', async () => {
    const { dlg, hires, inner } = setup(TWO);
    dlg.open('floor', 0, fromPreset('auto'));
    await tick();
    expect(chip('auto')).toBeNull();
    expect(chip('codex')?.checked).toBe(true);
    await inner.hire();
    expect(hires[0]).toMatchObject({ codex_profile: 'codex' });
  });

  it('“Save as preset…” hands Auto to the preset editor', async () => {
    const { dlg, savePreset } = setup(AUTO);
    dlg.open('floor', 0);
    await tick();
    document.querySelector<HTMLButtonElement>('[data-key="save-preset"]')?.click();
    expect(savePreset.mock.calls[0]?.[0]).toMatchObject({ harness: 'codex', profile: 'auto' });
  });
});
