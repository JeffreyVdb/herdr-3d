// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HireInterpretation, HireOptions, HirePrepare } from '../net/protocol';
import { CAT, FULL, NO_EFFORT } from '../world/hireReviewFixtures';
import type { HireHost } from './hire';
import { HireReviewDialog } from './hireReview';
import { HirePrefs } from './hirePrefs';
import { HIRE_PROMPT_MAX_BYTES } from './composer/model';

// #212: the review of a dictated hire. Fixture interpretations (phase 4 does not exist yet); `worker.hire` is counted.

const prep = (over: Partial<HirePrepare> = {}): HirePrepare => ({
  cwd: '/home/test',
  label: 'Nibble',
  git: null,
  // The bridge's floor default: the review must never take an agent choice from it.
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } },
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Env {
  seats: Array<{ name: string } | null>;
  asleep: boolean;
  held: Set<number>;
  catalog: HireOptions;
  prepare: (cwd: string) => Promise<CommandResult>;
}

function setup(over: Partial<Env> = {}, background = false) {
  const env: Env = { seats: Array(6).fill(null), asleep: false, held: new Set(), catalog: CAT, prepare: async () => ({ ok: true, data: prep() }) as CommandResult, ...over };
  const hires: Array<{ args: Record<string, unknown>; answer: (r: CommandResult) => void }> = [];
  const prepares: string[] = [];
  const toasts: Array<{ text: string; kind: string }> = [];
  const reserved: number[] = [];
  const goTos: string[] = [];
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = background;
  const store = {
    get hireOptions() {
      return env.catalog;
    },
    floorView: () => ({ seats: env.seats, asleep: env.asleep, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
  };
  const host = {
    store,
    send: (t: string, args: Record<string, unknown>) => {
      if (t === 'hire.prepare') {
        prepares.push(String(args.cwd ?? ''));
        return env.prepare(String(args.cwd ?? ''));
      }
      return new Promise<CommandResult>((answer) => hires.push({ args, answer }));
    },
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      reserved.push(d);
      env.held.add(d);
      return () => env.held.delete(d);
    },
    held: () => env.held,
    toast: (text: string, kind: string) => void toasts.push({ text, kind }),
    goTo: (id: string) => void goTos.push(id),
    beep: () => {},
    hirePrefs: prefs,
    now: () => Date.now(),
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
  return { rv, env, hires, prepares, toasts, reserved, goTos, prefs };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const section = (id: string) => q(`[data-section="${id}"]`)!;
const toggle = (id: string) => q<HTMLButtonElement>(`[data-key="sec:${id}"]`)!;
const hireBtn = () => q<HTMLButtonElement>('[data-key="hire"]')!;
const pickChip = (name: string, value: string) => q<HTMLInputElement>(`[data-key="${name}:${value}"]`)!.click();
const enter = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
const secOf = (rv: HireReviewDialog, id: string) => rv.summary()!.sections.find((s) => s.id === id)!;

describe('HireReviewDialog', () => {
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

  describe('sections', () => {
    it('a fully specified interpretation: every section collapsed, its value in the summary', async () => {
      const { rv } = setup();
      rv.open('floor', FULL);
      await tick();
      const s = rv.summary()!;
      expect(s.sections.map((x) => [x.id, x.open])).toEqual([['agent', false], ['effort', false], ['task', false], ['where', false]]);
      expect(secOf(rv, 'agent').summary).toBe('Claude Code · Haiku 5.5');
      expect(secOf(rv, 'effort').summary).toBe('high');
      expect(secOf(rv, 'task').summary).toBe('fix the login bug.');
      expect(secOf(rv, 'where').summary).toContain('Desk 1');
      expect(secOf(rv, 'where').summary).toContain('/home/test');
      for (const id of ['agent', 'effort', 'task', 'where']) {
        expect(toggle(id).getAttribute('aria-expanded')).toBe('false');
        expect(q(`#review-${id}-p`)!.hidden).toBe(true);
        expect(toggle(id).getAttribute('aria-controls')).toBe(`review-${id}-p`);
      }
      expect(s.blocker).toBeNull();
      expect(hireBtn().disabled).toBe(false);
    });

    it('a missing effort: Effort open with the question and the levels, nothing selected, Hire disabled', async () => {
      const { rv } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      expect(secOf(rv, 'effort')).toMatchObject({ open: true, attention: true });
      expect(secOf(rv, 'agent').open).toBe(false);
      expect(q('#review-effort-q')!.textContent).toBe('What effort level should this agent use?');
      const radios = [...document.querySelectorAll<HTMLInputElement>('[data-pick="effort"] input')];
      expect(radios.map((r) => r.value)).toEqual(['low', 'medium', 'high']);
      expect(radios.some((r) => r.checked)).toBe(false);
      expect(rv.summary()!.form.effort).toBe('');
      expect(hireBtn().disabled).toBe(true);
      expect(rv.summary()!.blocker).toBe('Choose an effort.');
    });

    it('an unusable model opens Harness and model with nothing chosen (no first-model fallback)', async () => {
      const { rv } = setup();
      rv.open('floor', { ...FULL, model: { provenance: 'invalid', said: 'GPT-5.5 Haiku' }, effort: { provenance: 'missing' } });
      await tick();
      expect(secOf(rv, 'agent')).toMatchObject({ open: true, attention: true });
      expect(rv.summary()!.form.model).toBe('');
      expect([...document.querySelectorAll<HTMLInputElement>('[data-pick="model"] input')].some((r) => r.checked)).toBe(false);
      expect(secOf(rv, 'agent').summary).toContain('GPT-5.5 Haiku');
      expect(hireBtn().disabled).toBe(true);
    });

    it('several sections stay open at once: choosing an effort does not stop Model from opening', async () => {
      const { rv } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      pickChip('effort', 'medium');
      toggle('agent').click();
      toggle('task').click();
      expect(secOf(rv, 'effort').open).toBe(true);
      expect(secOf(rv, 'agent').open).toBe(true);
      expect(secOf(rv, 'task').open).toBe(true);
      expect(toggle('agent').getAttribute('aria-expanded')).toBe('true');
      toggle('agent').click();
      expect(secOf(rv, 'agent').open).toBe(false);
      expect(secOf(rv, 'effort').open).toBe(true);
    });

    it('focuses the first section that needs a choice, never Hire', async () => {
      const { rv } = setup();
      rv.open('floor', NO_EFFORT);
      expect(document.activeElement).toBe(toggle('effort'));
      rv.close();
      rv.open('floor', FULL);
      expect(document.activeElement).toBe(toggle('agent'));
    });
  });

  describe('provenance', () => {
    it('says dictated, resolved by the interpreter and default, and your choice after an edit', async () => {
      const { rv } = setup();
      rv.open('floor', FULL);
      await tick();
      toggle('agent').click();
      toggle('where').click();
      const origin = q('[data-hook="agent-origin"]')!.textContent!;
      expect(origin).toContain('Harness Dictated');
      expect(origin).toContain('Model Resolved by the interpreter');
      expect(secOf(rv, 'agent').origin).toBe('Dictated · Resolved by the interpreter');
      expect(secOf(rv, 'where').origin).toBe('Floor · defaults');
      expect(section('where').textContent).toContain('Default');
      // a click on a model: it is now the human's
      pickChip('model', 'claude-sonnet-5-5');
      expect(q('[data-hook="agent-origin"]')!.textContent).toContain('Model Your choice');
      const label = q<HTMLInputElement>('#review-label')!;
      label.value = 'Pip';
      label.dispatchEvent(new Event('input'));
      expect(secOf(rv, 'where').origin).toBe('Floor · your choices');
    });
  });

  describe('changing the model', () => {
    it('keeps a still-supported effort; clears an unsupported one, opens Effort and disables Hire until it is picked again', async () => {
      const { rv } = setup();
      const interp: HireInterpretation = { ...FULL, model: { provenance: 'dictated', value: 'claude-opus-5-5' }, effort: { provenance: 'dictated', value: 'xhigh' } };
      rv.open('floor', interp);
      await tick();
      toggle('task').click();
      const text = q<HTMLTextAreaElement>('#review-task')!.value;
      // sonnet has no xhigh... so use `high`, which every claude model takes: first keep
      pickChip('effort', 'high'); // opens nothing; effort now `high` (chosen)
      pickChip('model', 'claude-sonnet-5-5');
      expect(rv.summary()!.form).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
      expect(hireBtn().disabled).toBe(false);
      // back to opus, take xhigh, then to haiku which has no xhigh
      pickChip('model', 'claude-opus-5-5');
      pickChip('effort', 'xhigh');
      // Effort was valid all along: it stays folded until a choice is needed
      expect(secOf(rv, 'effort').open).toBe(false);
      pickChip('model', 'claude-haiku-5-5');
      expect(rv.summary()!.form.effort).toBe('');
      expect(secOf(rv, 'effort')).toMatchObject({ open: true, attention: true });
      expect([...document.querySelectorAll<HTMLInputElement>('[data-pick="effort"] input')].map((r) => r.value)).toEqual(['low', 'medium', 'high']);
      expect(q('#review-effort-q')!.textContent).toContain('“xhigh” is not supported by Haiku 5.5');
      expect(hireBtn().disabled).toBe(true);
      expect(q<HTMLTextAreaElement>('#review-task')!.value).toBe(text);
      expect(rv.summary()!.choice.task).toBe('fix the login bug.');
      pickChip('effort', 'medium');
      expect(hireBtn().disabled).toBe(false);
      expect(rv.summary()!.form.effort).toBe('medium');
    });

    it('a new harness empties the model and never picks one', async () => {
      const { rv } = setup();
      rv.open('floor', FULL);
      await tick();
      pickChip('harness', 'codex');
      expect(rv.summary()!.form).toMatchObject({ harness: 'codex', model: '' });
      expect(secOf(rv, 'agent')).toMatchObject({ open: true, attention: true });
      expect(hireBtn().disabled).toBe(true);
      pickChip('model', 'gpt-6-sol');
      expect(rv.summary()!.form).toMatchObject({ harness: 'codex', model: 'gpt-6-sol', effort: 'high' });
    });

    it('never takes the effort from the bridge’s floor default', async () => {
      const { rv } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      expect(rv.summary()!.form.effort).toBe('');
      expect(rv.summary()!.choice.origin.effort).toBe('missing');
    });
  });

  describe('a dictated answer', () => {
    it('answerEffort takes a supported level like a click, marked dictated, and refuses another', async () => {
      const { rv, hires } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      expect(rv.answerEffort('max')).toBe(false);
      expect(rv.summary()!.form.effort).toBe('');
      expect(rv.answerEffort('high')).toBe(true);
      expect(rv.summary()!.form.effort).toBe('high');
      expect(secOf(rv, 'effort').origin).toBe('Dictated');
      expect(secOf(rv, 'effort').summary).toBe('high');
      expect(hireBtn().disabled).toBe(false);
      expect(hires).toHaveLength(0);
    });

    it('a follow-up interpretation fills the effort and never launches', async () => {
      const { rv, hires } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      const t = rv.begin()!;
      expect(rv.apply(FULL, t)).toBe(true);
      expect(rv.summary()!.form.effort).toBe('high');
      expect(hires).toHaveLength(0);
    });
  });

  describe('late replies never overwrite a human edit', () => {
    it('an interpretation asked for before an edit changes neither the edited effort nor the task', async () => {
      const { rv, hires } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      const t = rv.begin()!;
      pickChip('effort', 'low');
      toggle('task').click();
      const area = q<HTMLTextAreaElement>('#review-task')!;
      area.value = 'my own wording';
      area.dispatchEvent(new Event('input'));
      expect(rv.apply({ ...FULL, effort: { provenance: 'dictated', value: 'high' }, task: { provenance: 'dictated', value: 'something else' } }, t)).toBe(true);
      expect(rv.summary()!.form).toMatchObject({ effort: 'low', prompt: 'my own wording' });
      expect(area.value).toBe('my own wording');
      expect(secOf(rv, 'effort').origin).toBe('Your choice');
      expect(hires).toHaveLength(0);
    });

    it('a reply for a review that was cancelled or replaced is dropped', async () => {
      const { rv } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      const t = rv.begin()!;
      rv.close();
      expect(rv.apply(FULL, t)).toBe(false);
      rv.open('floor', NO_EFFORT);
      await tick();
      expect(rv.apply(FULL, t)).toBe(false);
      expect(rv.summary()!.form.effort).toBe('');
    });

    it('a slow hire.prepare answer does not overwrite a label or task typed meanwhile', async () => {
      let answer!: (r: CommandResult) => void;
      const { rv } = setup({ prepare: () => new Promise((r) => (answer = r)) });
      rv.open('floor', FULL);
      toggle('task').click();
      const area = q<HTMLTextAreaElement>('#review-task')!;
      area.value = 'typed before the floor answered';
      area.dispatchEvent(new Event('input'));
      answer({ ok: true, data: prep() } as CommandResult);
      await tick();
      expect(rv.summary()!.form.prompt).toBe('typed before the floor answered');
      expect(rv.summary()!.state).toBe('ready');
    });

    it('a prepare answer for a review that was closed is ignored', async () => {
      let answer!: (r: CommandResult) => void;
      const { rv } = setup({ prepare: () => new Promise((r) => (answer = r)) });
      rv.open('floor', FULL);
      const stale = answer;
      rv.close();
      rv.open('floor', NO_EFFORT);
      stale({ ok: true, data: prep({ label: 'Stale' }) } as CommandResult);
      await tick();
      expect(rv.summary()!.state).toBe('preparing');
    });

    it('a catalog that lost the model clears it, opens its section, and leaves the task alone', async () => {
      const { rv, env } = setup();
      rv.open('floor', FULL);
      await tick();
      env.catalog = { ...CAT, claude: { ...CAT.claude!, models: ['claude-opus-5-5'] } };
      rv.refresh();
      expect(rv.summary()!.form).toMatchObject({ model: '', prompt: 'fix the login bug.' });
      expect(secOf(rv, 'agent').open).toBe(true);
      expect(hireBtn().disabled).toBe(true);
    });
  });

  describe('nothing launches but Hire', () => {
    it('Enter in any field, Cancel, section toggles, picks and follow-ups send no worker.hire', async () => {
      const { rv, hires } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      for (const id of ['agent', 'task', 'where']) toggle(id).click();
      for (const el of [q('#review-task')!, q('#review-label')!, q('#review-cwd')!, toggle('agent'), q('[data-key="model:claude-haiku-5-5"]')!]) enter(el);
      pickChip('model', 'claude-sonnet-5-5');
      pickChip('effort', 'high');
      rv.apply(FULL, rv.begin()!);
      rv.answerEffort('low');
      for (const id of ['agent', 'task', 'where', 'effort']) toggle(id).click();
      expect(hires).toHaveLength(0);
      q<HTMLButtonElement>('[data-key="cancel"]')!.click();
      expect(rv.isOpen).toBe(false);
      expect(hires).toHaveLength(0);
    });

    it('Escape (the dialog’s cancel) discards the pending hire', async () => {
      const { rv, hires } = setup();
      rv.open('floor', FULL);
      await tick();
      q('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      rv.close();
      expect(rv.summary()).toBeNull();
      expect(hires).toHaveLength(0);
    });

    it('Hire sends exactly one worker.hire with the reviewed values; a second click sends none', async () => {
      const { rv, hires, reserved } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      pickChip('model', 'claude-sonnet-5-5');
      pickChip('effort', 'medium');
      toggle('task').click();
      const area = q<HTMLTextAreaElement>('#review-task')!;
      area.value = 'fix the login bug.\nAnd its tests.';
      area.dispatchEvent(new Event('input'));
      expect(hires).toHaveLength(0);
      hireBtn().click();
      hireBtn().click();
      enter(q('#review-label')!);
      await tick();
      expect(hires).toHaveLength(1);
      expect(hires[0]!.args).toEqual({ session: 'floor', desk_index: 0, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', label: 'Nibble', cwd: '/home/test', prompt: 'fix the login bug.\nAnd its tests.' });
      expect(reserved).toEqual([0]);
      // an edit after Hire does not reach the hire on its way
      area.value = 'too late';
      expect(hires[0]!.args.prompt).toBe('fix the login bug.\nAnd its tests.');
      hires[0]!.answer({ ok: true, data: { id: 'w1', workspace_id: 'ws', trust: 'none', prompted: true } } as CommandResult);
      await tick();
      expect(rv.isOpen).toBe(false);
      expect(hires).toHaveLength(1);
    });

    it('Hire is refused while a value is missing, even by a click on the disabled button', async () => {
      const { rv, hires } = setup();
      rv.open('floor', NO_EFFORT);
      await tick();
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(0);
      expect(rv.summary()!.state).toBe('ready');
    });

    it('a task cleared by the human blocks Hire; one starting with -- is refused', async () => {
      const { rv } = setup();
      rv.open('floor', FULL);
      await tick();
      toggle('task').click();
      const area = q<HTMLTextAreaElement>('#review-task')!;
      area.value = '  ';
      area.dispatchEvent(new Event('input'));
      expect(hireBtn().disabled).toBe(true);
      expect(secOf(rv, 'task').attention).toBe(true);
      area.value = '--help me';
      area.dispatchEvent(new Event('input'));
      expect(rv.summary()!.blocker).toMatch(/“--”/);
      expect(hireBtn().disabled).toBe(true);
    });

    it('in the background the review closes at once, the desk is held, and the outcome is the coordinator’s toast', async () => {
      const { rv, hires, toasts, goTos, env } = setup({}, true);
      rv.open('floor', FULL);
      await tick();
      hireBtn().click();
      await tick();
      expect(rv.isOpen).toBe(false);
      expect(hires).toHaveLength(1);
      expect(env.held.has(0)).toBe(true);
      hires[0]!.answer({ ok: true, data: { id: 'w1', workspace_id: 'ws', trust: 'none', prompted: true } } as CommandResult);
      await tick();
      expect(toasts.map((t) => t.text)).toContain('Agent spawned successfully.');
      expect(goTos).toEqual([]);
      expect(env.held.has(0)).toBe(false);
    });

    it('a refused hire leaves the review as it was, ready for another press', async () => {
      const { rv, hires } = setup();
      rv.open('floor', FULL);
      await tick();
      hireBtn().focus();
      hireBtn().click();
      await tick();
      expect(rv.summary()!.state).toBe('hiring');
      expect(document.activeElement).toBe(hireBtn());
      // In flight it is busy, not disabled (#216 row 14), and a second press sends nothing.
      expect(hireBtn().getAttribute('aria-busy')).toBe('true');
      expect(hireBtn().getAttribute('aria-disabled')).toBe('true');
      expect(hireBtn().disabled).toBe(false);
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(1);
      hires[0]!.answer({ ok: false, code: 'capacity', message: 'full' } as CommandResult);
      await tick();
      expect(rv.isOpen).toBe(true);
      expect(rv.summary()!.state).toBe('ready');
      expect(rv.summary()!.error).toBe(true);
      expect(rv.summary()!.form).toMatchObject({ harness: 'claude', model: 'claude-haiku-5-5', effort: 'high', prompt: 'fix the login bug.' });
      expect(hires).toHaveLength(1);
    });
  });

  describe('floor and desk', () => {
    it('the first free desk: skips an occupied one and one another hire is on its way to', async () => {
      const seats = Array(6).fill(null);
      seats[0] = { name: 'Ada' };
      const { rv, toasts } = setup({ seats, held: new Set([1]) });
      expect(rv.open('floor', FULL)).toBe(true);
      expect(rv.summary()!.desk).toBe(2);
      expect(toasts).toEqual([]);
    });

    it('refuses a desk somebody sits at, or one that is held, and says why', () => {
      const seats = Array(6).fill(null);
      seats[3] = { name: 'Ada' };
      const { rv, toasts } = setup({ seats, held: new Set([4]) });
      expect(rv.open('floor', FULL, 3)).toBe(false);
      expect(rv.open('floor', FULL, 4)).toBe(false);
      expect(toasts.map((t) => t.text)).toEqual(['Ada sits at Desk 4.', 'Someone is already on the way to Desk 5.']);
      expect(rv.isOpen).toBe(false);
    });

    it('a blocked floor (asleep) does not open; one that goes to sleep meanwhile closes with a toast', async () => {
      const blocked = setup({ asleep: true });
      expect(blocked.rv.open('floor', FULL)).toBe(false);
      expect(blocked.rv.isOpen).toBe(false);
      expect(blocked.toasts[0]!.text).toMatch(/asleep\. Wake it/);
      document.body.replaceChildren();
      const { rv, env, toasts, hires } = setup();
      rv.open('floor', FULL);
      await tick();
      env.asleep = true;
      rv.refresh();
      expect(rv.isOpen).toBe(false);
      expect(toasts.at(-1)!.text).toBe('floor went to sleep; wake it to hire.');
      expect(hires).toHaveLength(0);
    });

    it('a desk taken meanwhile blocks Hire and offers the next free one', async () => {
      const { rv, env, hires } = setup();
      rv.open('floor', FULL);
      await tick();
      env.seats[0] = { name: 'Ada' };
      rv.refresh();
      expect(rv.summary()!.blocker).toBe('Ada just sat down at Desk 1.');
      expect(secOf(rv, 'where')).toMatchObject({ open: true, attention: true });
      expect(hireBtn().disabled).toBe(true);
      q<HTMLButtonElement>('[data-key="other-desk"]')!.click();
      expect(rv.summary()!.desk).toBe(1);
      expect(rv.summary()!.blocker).toBeNull();
      hireBtn().click();
      await tick();
      expect(hires[0]!.args.desk_index).toBe(1);
    });

    it('a desk another hire is on its way to is not hired at', async () => {
      const { rv, env } = setup();
      rv.open('floor', FULL);
      await tick();
      env.held.add(0);
      rv.refresh();
      expect(rv.summary()!.blocker).toBe('Another hire is already on its way to Desk 1.');
      expect(hireBtn().disabled).toBe(true);
    });

    it('the hard cap blocks Hire and says so; the soft cap warns and allows it', async () => {
      const full = setup({ prepare: async () => ({ ok: true, data: prep({ capacity: { floor: { count: 20, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } } }) }) as CommandResult });
      full.rv.open('floor', FULL);
      await tick();
      expect(full.rv.summary()!.blocker).toMatch(/hard cap/);
      expect(secOf(full.rv, 'where').attention).toBe(true);
      expect(q('[data-level="full"]')).not.toBeNull();
      expect(hireBtn().disabled).toBe(true);
      document.body.replaceChildren();
      const warn = setup({ prepare: async () => ({ ok: true, data: prep({ capacity: { floor: { count: 10, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } } }) }) as CommandResult });
      warn.rv.open('floor', FULL);
      await tick();
      expect(q('[data-level="warn"]')).not.toBeNull();
      expect(hireBtn().disabled).toBe(false);
    });

    it.each([true, false])('uses the configured worktree default after prepare or refetch (initial fetch: %s), with a per-hire override', async (fetched) => {
      const git = { repo_root: '/home/test', default_branch: 'main', base_sha: 'abcdef1234', base_time: Date.now(), fetched: true };
      let fresh = fetched;
      const { rv, hires, prefs } = setup({ prepare: async () => ({ ok: true, data: prep({ git: { ...git, fetched: fresh } }) }) as CommandResult });
      prefs.worktreeByDefault = false;
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      expect(q<HTMLInputElement>('#review-worktree')!.checked).toBe(false);
      if (!fresh) {
        fresh = true;
        q<HTMLButtonElement>('[data-key="refetch"]')!.click();
        await tick();
        expect(q<HTMLInputElement>('#review-worktree')!.checked).toBe(false);
      }
      q<HTMLInputElement>('#review-worktree')!.click();
      hireBtn().click();
      await tick();
      expect(hires[0]!.args.worktree).toBe(true);
      expect(prefs.worktreeByDefault).toBe(false);
    });

    it('shows the floor, the desk, the folder, the label and the worktree choice; none is hidden', async () => {
      const git = { repo_root: '/home/test', default_branch: 'main', base_sha: 'abcdef1234', base_time: Date.now(), fetched: true };
      const { rv, hires } = setup({ prepare: async () => ({ ok: true, data: prep({ git }) }) as CommandResult });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      expect(q('[data-hook="place"]')!.textContent).toContain('Floor 2 of 3 · HQ');
      expect(q('[data-hook="place"]')!.textContent).toContain('Desk 1');
      expect(q<HTMLInputElement>('#review-label')!.value).toBe('Nibble');
      expect(q<HTMLInputElement>('#review-cwd')!.value).toBe('/home/test');
      expect(q<HTMLInputElement>('#review-worktree')!.checked).toBe(true);
      expect(secOf(rv, 'where').summary).toContain('own worktree');
      q<HTMLInputElement>('#review-worktree')!.click();
      expect(secOf(rv, 'where').summary).toContain('no worktree');
      q<HTMLInputElement>('#review-worktree')!.click();
      hireBtn().click();
      await tick();
      expect(hires[0]!.args).toMatchObject({ worktree: true, cwd: '/home/test', label: 'Nibble' });
    });
  });
  describe('a folder check and the folder typed since', () => {
    const git = (root: string) => ({ repo_root: root, default_branch: 'main', base_sha: 'abcdef1234', base_time: Date.now(), fetched: true });
    /** The first prepare answers at once (the initial review); every later one waits for the test to answer it. */
    function slowFolders(initial: Partial<HirePrepare> = {}) {
      const waiting = new Map<string, (r: CommandResult) => void>();
      let first = true;
      const prepare = (cwd: string) => {
        if (first) {
          first = false;
          return Promise.resolve({ ok: true, data: prep(initial) } as CommandResult);
        }
        return new Promise<CommandResult>((r) => waiting.set(cwd, r));
      };
      return { waiting, prepare };
    }
    const type = (el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event('input'));
    };
    const blur = (el: HTMLInputElement) => el.dispatchEvent(new Event('change'));

    it('L1: a late answer for the folder the human has since changed never touches the folder, git or worktree', async () => {
      const { waiting, prepare } = slowFolders({ git: git('/home/test') });
      const { rv, hires } = setup({ prepare });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      let cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '/repo-a');
      blur(cwd);
      type(cwd, '/repo-b');
      expect(rv.summary()!.form.cwd).toBe('/repo-b');
      waiting.get('/repo-a')!({ ok: true, data: prep({ cwd: '/repo-a', git: null }) } as CommandResult);
      await tick();
      const s = rv.summary()!;
      expect(s.form.cwd).toBe('/repo-b');
      expect(q<HTMLInputElement>('#review-cwd')!.value).toBe('/repo-b');
      expect(s.git).toMatchObject({ usable: true });
      expect(s.form.worktree).toBe(true);
      expect(s.status).toBe('');
      // The folder it was typed for is checked on blur, and that answer is applied.
      cwd = q<HTMLInputElement>('#review-cwd')!;
      blur(cwd);
      waiting.get('/repo-b')!({ ok: true, data: prep({ cwd: '/repo-b', git: null }) } as CommandResult);
      await tick();
      expect(rv.summary()!.form).toMatchObject({ cwd: '/repo-b', worktree: false });
      hireBtn().click();
      await tick();
      expect(hires[0]!.args).toMatchObject({ cwd: '/repo-b' });
      expect(hires[0]!.args).not.toHaveProperty('worktree');
    });

    it('L2: Hire is off, with the reason, while the changed folder is checked, and sends nothing', async () => {
      const { waiting, prepare } = slowFolders({ git: git('/home/test') });
      const { rv, hires } = setup({ prepare });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      expect(rv.summary()!.form.worktree).toBe(true);
      expect(hireBtn().disabled).toBe(false);
      const cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '/non-repo');
      // Typed, not checked yet.
      expect(hireBtn().disabled).toBe(true);
      expect(rv.summary()!.blocker).toMatch(/not been checked/);
      blur(cwd);
      expect(rv.summary()!.blocker).toBe('Checking the folder…');
      expect(hireBtn().disabled).toBe(true);
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(0);
      waiting.get('/non-repo')!({ ok: true, data: prep({ cwd: '/non-repo', git: null }) } as CommandResult);
      await tick();
      expect(rv.summary()!.blocker).toBeNull();
      expect(hireBtn().disabled).toBe(false);
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(1);
      expect(hires[0]!.args).toMatchObject({ cwd: '/non-repo' });
      expect(hires[0]!.args).not.toHaveProperty('worktree');
    });

    it('L2: a folder that did not check out keeps Hire off', async () => {
      const { waiting, prepare } = slowFolders({ git: git('/home/test') });
      const { rv } = setup({ prepare });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      const cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '/nowhere');
      blur(cwd);
      waiting.get('/nowhere')!({ ok: false, code: 'bad_request', message: 'no such folder' } as CommandResult);
      await tick();
      expect(rv.summary()!.error).toBe(true);
      expect(hireBtn().disabled).toBe(true);
    });

    it('L5: Fetch again after a folder edit checks the folder in the form, and the answer keeps it', async () => {
      const fail = { ...git('/home/test'), fetched: false, fetch_error: 'offline' };
      const { waiting, prepare } = slowFolders({ git: fail });
      const { rv, prepares } = setup({ prepare });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      const cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '/repo-new');
      blur(cwd);
      q<HTMLButtonElement>('[data-key="refetch"]')!.click();
      // Every prepare is for the folder in the form, never the one it replaced.
      expect(prepares).toEqual(['', '/repo-new', '/repo-new']);
      waiting.get('/repo-new')!({ ok: true, data: prep({ cwd: '/repo-new', git: git('/repo-new') }) } as CommandResult);
      await tick();
      const s = rv.summary()!;
      expect(s.form.cwd).toBe('/repo-new');
      expect(s.form.worktree).toBe(true);
      expect(q<HTMLInputElement>('#review-cwd')!.value).toBe('/repo-new');
      expect(hireBtn().disabled).toBe(false);
    });

    it('L6: clearing a checked custom folder keeps Hire off, with its worktree never sent, until the default is checked', async () => {
      const { waiting, prepare } = slowFolders({ git: null });
      const { rv, hires, prepares } = setup({ prepare });
      rv.open('floor', FULL);
      await tick();
      toggle('where').click();
      let cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '/repo-new');
      blur(cwd);
      waiting.get('/repo-new')!({ ok: true, data: prep({ cwd: '/repo-new', git: git('/repo-new') }) } as CommandResult);
      await tick();
      expect(rv.summary()!.form.worktree).toBe(true);
      expect(hireBtn().disabled).toBe(false);
      cwd = q<HTMLInputElement>('#review-cwd')!;
      type(cwd, '');
      expect(hireBtn().disabled).toBe(true);
      blur(cwd);
      expect(prepares).toEqual(['', '/repo-new', '/home/test']);
      expect(hireBtn().disabled).toBe(true);
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(0);
      waiting.get('/home/test')!({ ok: true, data: prep({ cwd: '/home/test', git: null }) } as CommandResult);
      await tick();
      expect(q<HTMLInputElement>('#review-cwd')!.value).toBe('');
      expect(hireBtn().disabled).toBe(false);
      hireBtn().click();
      await tick();
      expect(hires).toHaveLength(1);
      expect(hires[0]!.args).not.toHaveProperty('cwd');
      expect(hires[0]!.args).not.toHaveProperty('worktree');
    });
  });

  describe('sections that need the human start open', () => {
    it.each([
      ['a task that starts with “--”', '--fix the login bug', /“--”/],
      ['a task over the size limit', 'x'.repeat(HIRE_PROMPT_MAX_BYTES + 1), /too long/],
    ])('L3: %s opens Task, Hire is off, and the human can still fold it', async (_n, task, why) => {
      const { rv } = setup();
      rv.open('floor', { ...FULL, task: { provenance: 'dictated', value: task, span: { source: 0, start: 0, end: task.length } } });
      await tick();
      expect(secOf(rv, 'task')).toMatchObject({ open: true, attention: true });
      expect(secOf(rv, 'agent').open).toBe(false);
      expect(rv.summary()!.blocker).toMatch(why);
      expect(hireBtn().disabled).toBe(true);
      toggle('task').click();
      expect(secOf(rv, 'task').open).toBe(false);
    });
  });
});
