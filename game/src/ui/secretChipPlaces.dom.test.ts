// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { FirePrepare, HireInterpretation, HirePrepare, Worker } from '../net/protocol';
import { HandoffBook } from '../world/handoff';
import { HandoffLLMBook } from '../world/handoffLlm';
import { PromptSecretsBook } from '../world/promptSecrets';
import { CAT, FULL } from '../world/hireReviewFixtures';
import { HandoffDialog } from './handoffDialog';
import type { DialogHost, HireHost } from './hire';
import { HirePrefs } from './hirePrefs';
import { HireReviewDialog } from './hireReview';
import { SendHomeDialog } from './sendHome';
import type { Draft as PromptDraft } from './composer/draft';

// #108 round 4: the dialogs that show a text the bridge sent back with references to protected files (pack up's
// prompt, an agent handoff's instruction, a dictated task): each exact reference is a chip; a text box that holds
// some keeps them as written, with a line under it naming the files.

const DIR = '/run/user/1000/herdr-world/secrets';
const OWNER = 'PUKNXUKGN2LDLHO5W4FFT6Z6TW';
const A = `${DIR}/${OWNER}/MZEWFPEUANUI7A3AAWZIDF6AXG`;
const B = `${DIR}/${OWNER}/L3AQJP4CGRRIXWQ35AQI4MXEWR`;
const ref = (p: string) => `[secret in file ${p}]`;

const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const chips = (root: ParentNode | null) => [...(root?.querySelectorAll<HTMLElement>('.secret-chip') ?? [])].map((c) => c.dataset.secretRef);
const book = (dir: string | null = DIR) => {
  const b = new PromptSecretsBook();
  b.reset({ enabled: true, available: true, ...(dir ? { dir } : {}) });
  return b;
};

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

describe('pack up’s confirm (#108 round 4)', () => {
  const PREP: FirePrepare = { name: 'Pixel', label: 'pixel', branch: 'h3d/pixel', worktree: { path: '/w/pixel', linked: true }, dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true };

  function setup() {
    document.body.replaceChildren();
    const worker = { id: 'A', session: 's', label: 'pixel', agent_kind: 'claude', status: 'idle', worktree: { path: '/w/pixel', linked: true } };
    const copies: string[] = [];
    const host = {
      store: { floorName: (id: string) => id, workerView: () => ({ name: 'Pixel', desk: 0, harness: 'claude', display: 'idle', worker }), workers: new Map([['A', worker]]), promptSecrets: book() },
      unsupported: () => false,
      toast: () => {},
      now: () => 0,
      send: (cmd: string) => Promise.resolve(cmd === 'worker.fire.prepare' ? { ok: true, data: PREP } : { ok: true, data: {} }),
    } as unknown as DialogHost;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => (copies.push(t), Promise.resolve()) } });
    return { dlg: new SendHomeDialog(document.body, host), copies };
  }

  it('the prompt the models read shows its references as chips, struck or not; the task box keeps them, the line under it names the files', async () => {
    const e = setup();
    // As packup.detect's `sent` has it: references in place, `removed` indexing it.
    const sent = `Deploy with ${ref(A)} and make a PR, then go home ${ref(B)}`;
    const cut = sent.indexOf(', then');
    void e.dlg.openPackup('A', { original: sent, task: `Deploy with ${ref(A)} and make a PR`, removed: [{ start: cut, end: sent.length }] });
    await flush();
    const original = document.querySelector('[data-key="pk-original"]');
    expect(chips(original)).toEqual([A, B]);
    expect(chips(original?.querySelector('del') ?? null)).toEqual([B]);
    const box = document.querySelector<HTMLTextAreaElement>('[data-key="wrap-prompt"]')!;
    expect(box.value).toBe(`Deploy with ${ref(A)} and make a PR`);
    const line = document.querySelector<HTMLElement>('#home-pk-refs')!;
    expect(line.hidden).toBe(false);
    expect(chips(line)).toEqual([A]);
    expect(box.getAttribute('aria-describedby')).toContain('home-pk-refs');
    // Edited away: the line goes.
    box.value = 'Deploy and make a PR';
    box.dispatchEvent(new Event('input'));
    expect(line.hidden).toBe(true);
    // A chip copies its path; the dialog's status says so.
    (original?.querySelector('.secret-chip') as HTMLElement).click();
    await flush();
    expect(e.copies).toEqual([A]);
    expect(e.dlg.summary()?.status).toBe('Path copied.');
  });
});

describe('an agent handoff’s instruction (#108 round 4)', () => {
  it('stored with its references, shown with chips while the request runs', async () => {
    document.body.replaceChildren();
    const w = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'h3d-223', agent_kind: 'claude', status: 'working', agent_handoff: { op: 'x', state: 'pending', started_at: 1, instruction: `focus on the deploy with ${ref(A)}` } } as unknown as Worker;
    const handoffs = new HandoffBook();
    handoffs.reset({ counts: { 'herdr-3d': 1 } });
    const store = {
      floorName: (id: string) => id,
      workerView: (id: string) => (id === 'A' ? { name: 'Pixel', desk: 2, harness: 'claude', display: 'working', worker: w } : null),
      workers: new Map([['A', w]]),
      handoffs,
      handoffLlm: new HandoffLLMBook(),
      ai: { state: null },
      promptSecrets: book(),
    };
    const copies: string[] = [];
    const host = { store, unsupported: () => false, toast: () => {}, now: () => 0, copy: async (t: string) => (copies.push(t), true), openCabinet: () => {}, send: () => Promise.resolve({ ok: true, data: {} }) };
    const d = new HandoffDialog(document.body, host as never);
    d.open('A');
    await flush();
    const line = document.querySelector<HTMLElement>('[data-hook="ho-instruction"]')!;
    expect(chips(line)).toEqual([A]);
    // What a reader sees: the tape's words, never the path.
    const seen = line.cloneNode(true) as HTMLElement;
    seen.querySelectorAll('.secret-chip-ref').forEach((x) => x.remove());
    expect(seen.textContent).toBe('Instruction: focus on the deploy with protected file');
    (line.querySelector('.secret-chip') as HTMLElement).click();
    await flush();
    expect(copies).toEqual([A]);
  });
});

describe('a dictated task (#108 round 4)', () => {
  const prep = (): HirePrepare => ({ cwd: '/home/test', label: 'Nibble', git: null, choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' }, choice_source: 'floor_default', capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } } });

  function setup(dir: string | null = DIR) {
    document.body.replaceChildren();
    const store = {
      floorName: (id: string) => id,
      hireOptions: CAT,
      floorView: () => ({ seats: Array(6).fill(null), asleep: false, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
      promptSecrets: book(dir),
    };
    const host = {
      store,
      send: (t: string) => (t === 'hire.prepare' ? Promise.resolve({ ok: true, data: prep() } as CommandResult) : new Promise<CommandResult>(() => {})),
      unsupported: () => false,
      reserve: () => () => {},
      held: () => new Set<number>(),
      toast: () => {},
      goTo: () => {},
      beep: () => {},
      hirePrefs: new HirePrefs(null),
      now: () => Date.now(),
    } as unknown as HireHost;
    return new HireReviewDialog(document.body, host);
  }

  it('the collapsed task’s summary cuts whole references only, as inert chips; the open task box keeps them, the line names the files', async () => {
    const said = `Hire a Claude Code agent on Haiku 5.5 with high effort. Task: deploy with ${ref(A)} and tag it.`;
    const start = said.indexOf('deploy');
    const interp: HireInterpretation = { ...FULL, sources: [said], task: { provenance: 'dictated', value: said.slice(start), span: { source: 0, start, end: said.length } } };
    const rv = setup();
    rv.open('floor', interp);
    await new Promise((r) => setTimeout(r, 0));
    const sum = document.querySelector('[data-section="task"] .rv-sum')!;
    expect(chips(sum)).toEqual([A]);
    const chip = sum.querySelector<HTMLElement>('.secret-chip')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.hasAttribute('tabindex')).toBe(false);
    expect(sum.textContent).not.toContain('herdr-world/secrets');
    const box = (rv as unknown as { composer: { getDraft(): PromptDraft } }).composer.getDraft();
    expect(box.doc.text).toBe(`deploy with ${ref(A)} and tag it.`);
    const line = document.querySelector<HTMLElement>('#review-task-refs')!;
    expect(line.hidden).toBe(false);
    expect(chips(line)).toEqual([A]);
    // An edit that drops it: the line goes.
    box.replace(0, box.doc.text.length, 'deploy and tag it.');
    expect(line.hidden).toBe(true);
    expect(chips(sum)).toEqual([]);
  });
});
