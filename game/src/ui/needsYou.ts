import type { RunAttention } from '../world/manualProcess';
import { shortCommand } from '../world/manualProcess';
import { h } from './dom';
import { duotone } from './duotone';
import { attentionActionName } from './manualAttention';

export interface NeedsYouHost {
  /** The run's password dialog (a credential episode): the app's Respond. */
  respond(id: string, from: HTMLElement): void;
  /** The Runs view on that run, its terminal with the keyboard. */
  terminal(id: string): void;
  /** Several runs: the Runs view. */
  more(): void;
  /** The line went while it had the keyboard (answered, ended): where the keyboard goes now. */
  refocus(): void;
}

/** "00:00:41": how long the run has waited (hours grow past 99). */
export function waited(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** "Pesto’s run asks for your password", "… is waiting for input", "… may be waiting for input": never "password" for input. */
export function needsYouText(r: RunAttention): string {
  const who = `${r.process.worker_name || r.process.worker}’s run`;
  if (r.attention.kind === 'credential') return `${who} asks for your password`;
  return r.attention.confidence === 'confirmed' ? `${who} is waiting for input` : `${who} may be waiting for input`;
}

/**
 * #216: the needs-you line, in the seat's notices row in every view while one of the seated worker's runs waits for you:
 * a bell, who asks and for what, the command (its first line, mono), the host and how long it has waited, and the
 * direct actions. A password request: Respond (the request's own password dialog) and Open terminal; input: Open
 * terminal alone (it is the answer). Several: the oldest, and "+N more" for the Runs view. It never takes the keyboard by
 * itself; one that goes while it has it hands it back (`refocus`).
 */
export class NeedsYouLine {
  readonly el: HTMLElement;
  private key = '';
  private since = 0;
  private clock: HTMLElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: NeedsYouHost, private readonly now: () => number = Date.now) {
    this.el = h('div', { class: 'seat-needs', role: 'group', 'aria-label': 'Needs you', 'data-hook': 'needs-you' });
    this.el.hidden = true;
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** The seated worker's runs asking for you, oldest first (empty: the line goes). */
  set(list: readonly RunAttention[]): void {
    const r = list[0];
    const key = r ? JSON.stringify([list.length, r.attention.id, r.attention.kind, r.attention.confidence, r.process.id, r.process.worker_name, r.process.command, r.process.host]) : '';
    if (key === this.key) return;
    this.key = key;
    const had = this.el.contains(document.activeElement);
    if (!r) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.stop();
      if (had) this.host.refocus();
      return;
    }
    const a = r.attention;
    const p = r.process;
    this.since = a.since > 0 ? a.since : p.started_at || p.created_at;
    this.clock = h('span', { class: 'seat-needs-time' });
    const text = needsYouText(r);
    const acts = h('span', { class: 'seat-needs-acts' });
    const open: HTMLButtonElement = h(
      'button',
      { class: a.kind === 'credential' ? 'btn seat-needs-btn' : 'btn btn--primary seat-needs-btn', 'data-key': `needs-open:${p.id}`, 'aria-label': attentionActionName({ process: p, attention: { ...a, kind: 'input' } }), onclick: () => this.host.terminal(p.id) },
      duotone('terminal'),
      h('span', {}, 'Open terminal'),
    );
    if (a.kind === 'credential') {
      const respond: HTMLButtonElement = h(
        'button',
        { class: 'btn btn--primary seat-needs-btn', 'data-key': `needs-respond:${p.id}`, 'aria-haspopup': 'dialog', 'aria-label': attentionActionName(r), onclick: () => this.host.respond(p.id, respond) },
        duotone('reply'),
        h('span', {}, 'Respond'),
      );
      acts.append(respond);
    }
    acts.append(open);
    const more = list.length > 1 ? h('button', { class: 'seat-needs-more', 'aria-label': `${list.length - 1} more of this worker’s runs ask for you: show the runs`, onclick: () => this.host.more() }, `+${list.length - 1} more`) : null;
    this.el.dataset.kind = a.kind === 'credential' || a.confidence === 'confirmed' ? 'sure' : 'maybe';
    this.el.title = [text, shortCommand(p, 200), p.host].filter(Boolean).join('\n');
    this.el.replaceChildren(
      duotone('bell', 'seat-needs-ic'),
      h('span', { class: 'seat-needs-who' }, text),
      h('span', { class: 'seat-needs-cmd', translate: 'no' }, shortCommand(p, 200)),
      h('span', { class: 'seat-needs-where' }, p.host ? `${p.host} · ` : '', this.clock),
      ...(more ? [more] : []),
      acts,
    );
    this.el.hidden = false;
    this.tick();
    this.timer ??= setInterval(() => this.tick(), 1000);
    if (had) (acts.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private tick(): void {
    if (this.clock) this.clock.textContent = waited(this.now() - this.since);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clock = null;
  }

  /** What it says (test hook; null: hidden). */
  summary(): string | null {
    return this.el.hidden ? null : (this.el.textContent ?? '');
  }

  dispose(): void {
    this.stop();
  }
}
