// M5 panels: the simulated bridge's `worker.prompt`, `worker.answer` and
// `worker.changes`, and periodic `worker.usage`, for the fixture server's
// `sim=1` (tools/fixture-sim.ts hands these commands over). Rules:
//
// - worker.prompt: an idle / done agent starts `working` one step later (the
//   ack follows), then is `done` three steps after that; a `working` one gets
//   the ack at once with `queued: true` and takes the prompt when its turn
//   ends. A `blocked` one or one with an `ask` (answer its question first), a plain shell (no
//   `agent_kind`) or an asleep floor is `invalid_state`. `simfail=prompt_failed` fails the next prompt
//   (`prompt_failed`), `simfail=prompt_retried` acks it `retried: true`. #58: with `simecho=<ms>` the prompt's
//   `user` item reaches the worker's transcript watch that long after its turn starts, or, queued, after the ack (both
//   CLIs take a queued prompt mid-turn); without it, never.
// - worker.answer: needs the question's hash (else `stale`, after a
//   worker.upsert with the current question, as the bridge re-reads the
//   screen); a "No" choice, a cancel or trusting a folder (the agent then
//   waits for its first prompt, as Claude Code does) leaves the agent `idle`,
//   any other choice sets it `working` and `done` three steps later. The keys sent are
//   the digit, or for a trust dialog (no digits) arrows from the cursor and
//   Enter, like the bridge.
//   `simfail=answer_unresolved`: the next answer is acked `resolved: false`.
// - worker.changes: a cwd with `/scratch` in it is `not_a_repo` (M4's "no git
//   repo" rule); a `working` worker has a staged, two unstaged and an
//   untracked file on top of its 2 unpushed commits, a `blocked` one its 1
//   unpushed commit, a `done` one pushed commits, anyone else a clean tree; a
//   worker whose label starts with `perf` has a ~1.6 MiB diff (profile
//   traces), cut at 256 KiB. `simfail=changes_failed` fails the next one.
// - worker.commands (#136): a Claude or Codex worker's commands, skills and
//   custom commands (simCommands), `partial: false`, half a step later; a
//   plain shell (no harness) is `invalid_state`.
// - worker.usage: every `usageMs` (default 5000, 0: off) each working agent
//   with usage uses more tokens.
import type { ChangeFile, Changes, CommandEntry, Floor, Question, Usage, Worker, WorkerCommands } from '../src/net/protocol.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;

export interface PanelsHost {
  readonly workers: Worker[];
  readonly floors: Map<string, Floor>;
  readonly stepMs: number;
  emit(send: Send, m: Msg): void;
  /** Runs `fn` after `ms` (cleared when the connection closes). */
  after(ms: number, fn: () => void): void;
  now(): number;
  /** True (once) when `simfail` asked for this failure. */
  takeFail(code: string): boolean;
  error(code: string, message: string): Error;
  /** #58: the agent took a prompt: its `user` item goes to the transcript (`simecho`). */
  echo?(w: Worker, text: string): void;
}

/** The bridge's cap on `diff` (docs: 256 KiB). */
export const SIM_DIFF_CAP = 256 * 1024;
/** Steps of a simulated turn: working → done. */
const TURN_STEPS = 3;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

export class PanelsSim {
  /** Prompts sent while the agent was working: taken when its turn ends. */
  private readonly queued = new Map<string, string[]>();
  /** Workers in a simulated turn (a timer will set them done). */
  private readonly turns = new Map<string, number>();

  private readonly h: PanelsHost;

  constructor(host: PanelsHost) {
    this.h = host;
  }

  private bad(m: string): Error {
    return this.h.error('bad_request', `bad args: ${m}`);
  }

  private worker(a: Obj): Worker {
    const id = a.id;
    if (typeof id !== 'string') throw this.bad('id must be a string');
    const w = this.h.workers.find((x) => x.id === id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${id}"`);
    const f = this.h.floors.get(w.session);
    if (!f || f.state !== 'running' || f.transition) throw this.h.error('invalid_state', `invalid state: ${w.session} is ${f?.transition ?? 'asleep'}`);
    return w;
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  // ---- status ----------------------------------------------------------------

  private setStatus(send: Send, w: Worker, status: string, title?: string): void {
    const prev = w.status;
    const hadQuestion = !!w.question;
    w.status = status;
    w.status_since = this.h.now();
    if (title !== undefined) w.title = title;
    if (status !== 'blocked') delete w.question;
    if (hadQuestion && !w.question) {
      this.h.emit(send, { t: 'worker.upsert', worker: w });
      return;
    }
    const ev: Msg = { t: 'worker.status', id: w.id, session: w.session, workspace_id: w.workspace_id, status, prev_status: prev, status_since: w.status_since };
    if (title !== undefined) ev.title = title;
    this.h.emit(send, ev);
  }

  /** A turn: working now, done after TURN_STEPS steps, then the next queued prompt. */
  private startTurn(send: Send, w: Worker, title: string): void {
    this.setStatus(send, w, 'working', title);
    const turn = (this.turns.get(w.id) ?? 0) + 1;
    this.turns.set(w.id, turn);
    this.h.after(this.h.stepMs * TURN_STEPS, () => {
      if (this.turns.get(w.id) !== turn || !this.h.workers.includes(w) || w.status !== 'working') return;
      this.turns.delete(w.id);
      this.use(w, 2400, 0.012);
      if (w.usage) this.h.emit(send, { t: 'worker.usage', id: w.id, session: w.session, usage: w.usage });
      this.setStatus(send, w, 'done');
      const next = this.queued.get(w.id)?.shift();
      if (next !== undefined) this.startTurn(send, w, firstLine(next));
    });
  }

  /** #57: a turn on a prompt that came another way (a dismissed ask's prompt). */
  work(send: Send, w: Worker, title: string): void {
    this.startTurn(send, w, title);
  }

  // ---- worker.prompt -----------------------------------------------------------

  prompt(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    this.only(a, ['id', 'text']);
    const text = a.text;
    if (typeof text !== 'string') throw this.bad('text must be a string');
    const w = this.worker(a);
    if (!w.agent_kind) throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} is a plain shell (use worker.keys)`);
    if (w.status === 'blocked') throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} is blocked (answer its question with worker.answer)`);
    if (w.ask) throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} waits on its question: answer it first (worker.answer_ask)`);
    if (!text || bytes(text) > 16 * 1024 || text.includes('\0')) throw this.bad('text must be 1 byte to 16 KiB, without NUL');
    if (this.h.takeFail('prompt_failed')) {
      this.h.after(this.h.stepMs, () => fail(this.h.error('prompt_failed', `prompt_failed: ${w.name ?? 'the agent'} did not start working, even after one more Enter (simulated)`)));
      return;
    }
    if (w.status === 'working') {
      const q = this.queued.get(w.id) ?? [];
      q.push(text);
      this.queued.set(w.id, q);
      ack({ queued: true, retried: false });
      this.h.echo?.(w, text);
      return;
    }
    const retried = this.h.takeFail('prompt_retried');
    this.h.after(this.h.stepMs, () => {
      if (!this.h.workers.includes(w)) return fail(this.h.error('unknown_worker', `unknown worker: "${w.id}"`));
      this.startTurn(send, w, firstLine(text));
      ack({ queued: false, retried });
      this.h.echo?.(w, text);
    });
  }

  // ---- worker.answer -----------------------------------------------------------

  answer(a: Obj, send: Send, ack: (d?: unknown) => void): void {
    this.only(a, ['id', 'hash', 'choice', 'cancel']);
    const w = this.worker(a);
    if (typeof a.hash !== 'string') throw this.bad('hash must be a string');
    const hasChoice = a.choice !== undefined;
    const cancel = a.cancel === true;
    if (hasChoice === cancel) throw this.bad('exactly one of choice or cancel');
    if (hasChoice && (typeof a.choice !== 'number' || !Number.isInteger(a.choice) || a.choice < 1 || a.choice > 9)) throw this.bad('choice must be 1-9');
    if (w.status !== 'blocked') throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} is not blocked`);
    const q = w.question;
    if (!q || q.hash !== a.hash) {
      // The bridge re-read the screen: the current question goes out first.
      this.h.emit(send, { t: 'worker.upsert', worker: w });
      throw this.h.error('stale', `stale: ${w.name ?? w.id}'s question changed`);
    }
    const choice = hasChoice ? q.choices.find((c) => c.n === a.choice) : undefined;
    if (hasChoice && !choice) throw this.bad(`choice ${String(a.choice)} is not one of the question's`);
    const sent = !choice ? ['esc'] : q.kind === 'trust' ? [...arrows(q.selected ?? 1, choice.n), 'enter'] : [String(choice.n)];
    if (this.h.takeFail('answer_unresolved')) {
      ack({ sent, resolved: false });
      return;
    }
    const no = !choice || /^\s*no\b/i.test(choice.label);
    if (no || q.kind === 'trust') this.setStatus(send, w, 'idle');
    else this.startTurn(send, w, w.title ?? '');
    ack({ sent, resolved: true });
  }

  // ---- worker.changes ------------------------------------------------------------

  changes(a: Obj, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    this.only(a, ['id']);
    const w = this.worker(a);
    const cwd = w.cwd ?? '';
    if (!cwd || cwd.includes('/scratch')) throw this.h.error('not_a_repo', `not_a_repo: ${cwd || 'no folder'} is not a git work tree`);
    if (this.h.takeFail('changes_failed')) {
      this.h.after(this.h.stepMs, () => fail(this.h.error('changes_failed', 'changes_failed: git status took longer than 10s (simulated)')));
      return;
    }
    const data = simChanges(w);
    // Read-only git takes a moment.
    this.h.after(Math.round(this.h.stepMs / 2), () => ack(data));
  }

  // ---- worker.commands (#136) ------------------------------------------------------

  commands(a: Obj, ack: (d?: unknown) => void): void {
    this.only(a, ['id']);
    const w = this.worker(a);
    const data = simCommands(w.harness ?? w.agent_kind ?? '');
    if (!data) throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} runs no Claude or Codex agent`);
    // A cached catalog: answered at once, after the round trip.
    this.h.after(Math.round(this.h.stepMs / 2), () => ack(data));
  }

  // ---- worker.usage ----------------------------------------------------------------

  /** Starts the periodic usage of working agents on a connection. */
  start(send: Send, everyMs: number): void {
    if (!(everyMs > 0)) return;
    const tick = () => {
      for (const w of this.h.workers) {
        const f = this.h.floors.get(w.session);
        if (w.status !== 'working' || !w.usage || f?.state !== 'running') continue;
        this.use(w, 1800, 0.006);
        this.h.emit(send, { t: 'worker.usage', id: w.id, session: w.session, usage: w.usage });
      }
      this.h.after(everyMs, tick);
    };
    this.h.after(everyMs, tick);
  }

  /** A turn's worth of tokens: the headline count, the split, the estimate and the context share. */
  private use(w: Worker, tokens: number, usd: number): void {
    const u = w.usage;
    if (!u) return;
    const next: Usage = {
      ...u,
      tokens: u.tokens + tokens,
      input: (u.input ?? 0) + Math.round(tokens * 0.05),
      output: (u.output ?? 0) + Math.round(tokens * 0.25),
      cache_read: (u.cache_read ?? 0) + tokens * 12,
      cost_usd_est: Math.round((u.cost_usd_est + (u.priced === 'none' ? 0 : usd)) * 10_000) / 10_000,
      updated_at: this.h.now(),
    };
    if (typeof u.context_pct === 'number') next.context_pct = Math.min(99, Math.round((u.context_pct + (tokens / (u.context_window ?? 200_000)) * 100) * 10) / 10);
    if (typeof u.context_tokens === 'number') next.context_tokens = u.context_tokens + tokens; // #101: the meter's count grows with it
    w.usage = next;
  }
}

const firstLine = (s: string) => s.split('\n')[0]?.trim().slice(0, 80) ?? '';

/** Arrow keys from the menu's cursor to choice `n`. */
const arrows = (from: number, n: number) => Array.from({ length: Math.abs(n - from) }, () => (n > from ? 'down' : 'up'));

// ---- canned git ---------------------------------------------------------------------

interface SimFile {
  file: ChangeFile;
  diff: string;
}

/** A new file's diff. */
function added(path: string, lines: string[], st: Partial<ChangeFile> = {}): SimFile {
  const body = lines.map((l) => `+${l}`).join('\n');
  return {
    file: { path, insertions: lines.length, deletions: 0, binary: false, ...st },
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${sha(path).slice(0, 7)}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
  };
}

/** A changed file's diff from hunks of prefixed lines (' ', '-', '+'), each starting at an old line number. */
function changed(path: string, hunks: Array<{ at: number; head?: string; lines: string[] }>, st: Partial<ChangeFile> = {}): SimFile {
  let ins = 0;
  let del = 0;
  let shift = 0;
  const parts = hunks.map((h) => {
    const o = h.lines.filter((l) => !l.startsWith('+')).length;
    const n = h.lines.filter((l) => !l.startsWith('-')).length;
    ins += n - h.lines.filter((l) => l.startsWith(' ')).length;
    del += o - h.lines.filter((l) => l.startsWith(' ')).length;
    const s = `@@ -${h.at},${o} +${h.at + shift},${n} @@${h.head ? ` ${h.head}` : ''}\n${h.lines.join('\n')}\n`;
    shift += n - o;
    return s;
  });
  return {
    file: { path, insertions: ins, deletions: del, binary: false, ...st },
    diff: `diff --git a/${path} b/${path}\nindex ${sha(`${path}-`).slice(0, 7)}..${sha(path).slice(0, 7)} 100644\n--- a/${path}\n+++ b/${path}\n${parts.join('')}`,
  };
}

function binary(path: string, st: Partial<ChangeFile> = {}): SimFile {
  return {
    file: { path, insertions: 0, deletions: 0, binary: true, ...st },
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${sha(path).slice(0, 7)}\nBinary files /dev/null and b/${path} differ\n`,
  };
}

function sha(s: string): string {
  let h = 2166136261;
  let out = '';
  for (let k = 0; out.length < 40; k++) {
    for (const c of `${s}#${k}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

const STAGED = { index: 'A', worktree: '.' };
const UNSTAGED = { index: '.', worktree: 'M' };
const COMMITTED = { index: '.', worktree: '.' };

/** Files of a repo like herdr-3d (a game/ and docs/), else of a small project. */
function repoFiles(game: boolean) {
  if (game) {
    return {
      staged: [
        added(
          'game/src/world/next.ts',
          [
            "import type { Display } from './derive';",
            '',
            '/** Who needs you, oldest first. */',
            'export function needQueue(ws: Array<{ id: string; display: Display; since: number }>) {',
            "  return ws.filter((w) => w.display === 'needs_you').sort((a, b) => a.since - b.since);",
            '}',
          ],
          STAGED,
        ),
        binary('docs/img/m5-prompt.png', STAGED),
      ],
      unstaged: [
        changed(
          'game/src/app.ts',
          [
            { at: 212, head: 'constructor(o: AppOptions) {', lines: ["    this.hud.on('prs', () => this.openBoard('Pull requests'));", '-    this.bindInput();', '+    // M5: the prompt overlay and the Changes panel.', '+    this.prompt = new PromptOverlay(o.host, dialogHost);', '+    this.bindInput();', '     this.resize();'] },
            { at: 780, head: 'private onKey(e: KeyboardEvent, down: boolean): void {', lines: ['     } else if (e.code === \'KeyL\' && this.mode === \'floor\') {', '-      this.openElevator();', '+      this.openElevator(); // from anywhere on the floor', '     }'] },
          ],
          UNSTAGED,
        ),
        changed('game/src/ui/hud.ts', [{ at: 88, head: 'const KEYS: Array<[string, string, boolean]> = [', lines: ["   ['E', 'Laptop', false],", "-  ['C', 'Changes', false],", "-  ['P', 'Prompt', false],", "+  ['C', 'Changes', true],", "+  ['P', 'Prompt', true],", "   ['H', 'Handoff', false],"] }], UNSTAGED),
      ],
      untracked: [added('notes/todo.md', ['# M5', '', '- [x] P prompt overlay', '- [ ] C changes: keyboard only', '- [ ] N across floors', '- [ ] screenshots'], { untracked: true })],
      committed: [
        added('game/src/world/usage.ts', ['/** `≈$0.09 · 37k tokens · ctx 4%`. */', 'export function costText(usd: number): string {', '  return `≈$${usd.toFixed(2)}`;', '}'], COMMITTED),
        changed('docs/protocol.md', [{ at: 402, head: '## Laptops', lines: [' Every command takes the bridge’s worker id.', '-The game shows cost as `$`.', '+The game shows cost as `≈$`: it is an estimate.', '+Unknown models are flagged with a `*`.', ' '] }], COMMITTED),
      ],
    };
  }
  return {
    staged: [added('src/scale.ts', ['export function scale(grams: number, factor: number): number {', '  return Math.round(grams * factor);', '}'], STAGED)],
    unstaged: [
      changed('recipes/levain.md', [{ at: 12, head: '## Feeding', lines: [' Feed the starter at 9:00.', '-Use 50 g flour and 50 g water.', '+Use 100 g flour and 100 g water:', '+the dough is 2 kg this week.', ' '] }], UNSTAGED),
      changed('src/timers.ts', [{ at: 30, lines: ['   const ms = minutes * 60_000;', '-  setTimeout(ring, ms);', '+  return setTimeout(ring, ms);'] }], UNSTAGED),
    ],
    untracked: [added('notes.txt', ['levain peaks around 6 h at 24 °C', 'try 5 % rye next time'], { untracked: true })],
    committed: [added('src/units.ts', ["export type Unit = 'g' | 'ml' | 'tsp';"], COMMITTED), changed('README.md', [{ at: 1, lines: [' # pastry', '+', '+Recipes, timers and the bread maths.'] }], COMMITTED)],
  };
}

/** A big generated file (a recorded fixture) and the profile traces that go over the cap. */
function perfFiles(): SimFile[] {
  const rows = Array.from({ length: 2900 }, (_, i) => `{"t":"worker.status","seq":${1043 + i},"id":"w${(i * 7919) % 240}","status":"${['working', 'idle', 'done', 'blocked'][i % 4]}","ms":${(i * 37) % 1000}}`);
  const trace = (path: string, n: number) => added(path, Array.from({ length: n }, (_, i) => `{"name":"frame","ph":"X","ts":${i * 8333},"dur":${4100 + ((i * 131) % 900)},"args":{"draws":${40 + (i % 9)}}}`), STAGED);
  return [
    changed('game/src/render/city.ts', [{ at: 120, head: 'frame(t: number, camera: THREE.Camera): void {', lines: ['     this.badges.update(camera);', '-    this.cards.update(camera);', '+    if (this.cardsDirty) this.cards.update(camera);', '+    this.cardsDirty = false;'] }], UNSTAGED),
    added('game/fixtures/perf-city240-replay.jsonl', rows, STAGED),
    added('docs/perf.md', ['# Perf notes', '', 'city240: 4.1 ms/frame on Metal, 6.8 ms on WebGL2.'], { untracked: true }),
    trace('perf/trace-city240.json', 14_000),
    trace('perf/trace-floor96.json', 7_000),
  ];
}

/** The simulated `worker.changes` ack for a worker (see the rules at the top). */
export function simChanges(w: Worker): Changes {
  const cwd = w.cwd ?? '';
  const root = w.worktree?.repo_root ?? cwd.replace(/-wt\/[^/]+$/, '');
  const set = repoFiles(root.endsWith('/herdr-3d'));
  let files: SimFile[] = [];
  let ahead = 0;
  if (w.label.startsWith('perf')) {
    files = perfFiles();
    ahead = 1;
  } else if (w.status === 'working') {
    files = [...set.staged, ...set.unstaged, ...set.untracked, ...set.committed];
    ahead = 2;
  } else if (w.status === 'blocked') {
    files = set.committed.slice(0, 1);
    ahead = 1;
  } else if (w.status === 'done') {
    files = set.committed;
  }
  // The diff: whole files in order until the cap; the rest omitted.
  let size = 0;
  let cut = false;
  const kept: string[] = [];
  const omitted: string[] = [];
  let all = 0;
  for (const f of files) {
    const b = bytes(f.diff);
    all += b;
    if (!cut && size + b <= SIM_DIFF_CAP) {
      kept.push(f.diff);
      size += b;
    } else {
      cut = true;
      omitted.push(f.file.path);
    }
  }
  const tracked = files.filter((f) => !f.file.untracked);
  const branch = w.branch ?? (w.worktree?.linked ? null : 'main');
  return {
    cwd,
    branch,
    head: sha(`${w.id}:head`),
    upstream: branch ? `origin/${branch}` : null,
    ahead,
    behind: w.status === 'done' ? 3 : 0,
    base: { ref: 'origin/main', sha: sha(`${root}:base`) },
    files: files.map((f) => f.file),
    stat: { files: tracked.length, insertions: tracked.reduce((s, f) => s + f.file.insertions, 0), deletions: tracked.reduce((s, f) => s + f.file.deletions, 0) },
    diff: kept.join(''),
    diff_bytes: all,
    truncated: omitted.length > 0,
    omitted,
  };
}

/** A question as the bridge reads it (tests and the fixture generator build theirs the same way). */
export function simQuestion(kind: string, text: string, choices: string[], excerpt: string[] = [text], selected = choices.length ? 1 : undefined): Question {
  const q: Question = { kind, text, excerpt, choices: choices.map((label, i) => ({ n: i + 1, label })), hash: sha(`${kind}|${text}|${choices.join('|')}`).slice(0, 16) };
  if (selected !== undefined) q.selected = selected;
  return q;
}

const cmd = (name: string, description: string, argument_hint = ''): CommandEntry => ({ name, description, argument_hint, kind: 'command' });
const skill = (name: string, description: string, argument_hint = ''): CommandEntry => ({ name, description, argument_hint, kind: 'skill' });
const custom = (name: string, description: string, argument_hint = ''): CommandEntry => ({ name, description, argument_hint, kind: 'custom' });

/** #136: the simulated `worker.commands` ack of a harness (null: not Claude or Codex). */
export function simCommands(harness: string): WorkerCommands | null {
  if (harness === 'claude') {
    return {
      partial: false,
      commands: [
        cmd('compact', 'Free up context by summarizing the conversation so far', '<optional custom summarization instructions>'),
        cmd('review', 'Review a pull request'),
        cmd('usage', "Show session cost, plan usage, and what's contributing to your limits"),
        skill('caveman:caveman-commit', '(caveman) Ultra-compressed commit message generator.'),
        skill('handoff', 'Compact the current conversation into a handoff document for another agent to pick up. (user)', 'What will the next session be used for?'),
        custom('deploy', 'Deploy the bridge to the test host (project)', '<host>'),
        custom('release:notes', 'Draft the release notes (project)'),
      ],
    };
  }
  if (harness === 'codex') {
    return {
      partial: false,
      commands: [
        skill('humanizer:humanizer', 'Remove AI writing patterns from prose'),
        skill('imagegen', 'Generate or edit images for websites, games, and more'),
        cmd('init', 'create an AGENTS.md file with instructions for Codex'),
        cmd('compact', 'summarize conversation to prevent hitting the context limit'),
        cmd('review', 'review my current changes and find issues', '<instructions>'),
        cmd('mcp', 'list configured MCP tools; use /mcp verbose for details', '[verbose]'),
      ],
    };
  }
  return null;
}
