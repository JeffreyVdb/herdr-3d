import type { RunAttention } from '../world/manualProcess';
import { attentionAction, attentionCount, attentionDetail, attentionLabel, shortCommand } from '../world/manualProcess';
import { h, icon, ICON } from './dom';
import './manualAttention.css';

export interface AttentionChipHost {
  /** The run's password dialog (a credential episode), from anywhere. */
  respond(id: string, from: HTMLElement): void;
  /** The run's terminal (an input episode). */
  terminal(id: string, from: HTMLElement): void;
  /** Several runs: their list. */
  list(from: HTMLElement): void;
}

/** "Respond to the password request of “sudo id” (Zippy)", "Open the terminal of “make” (Zippy)": a control names its run. */
export function attentionActionName(r: RunAttention): string {
  const what = `“${shortCommand(r.process)}” (${r.process.worker_name || r.process.worker})`;
  return r.attention.kind === 'credential' ? `Respond to the password request of ${what}` : `Open the terminal of ${what}`;
}

/**
 * #213: a manual run asks for you, in the game's chip style: the warning tape with what it is (filled when it is sure, an
 * outline when it may be), whose run and which command, and the direct action (Respond opens the password dialog, Open
 * terminal the run's terminal). Several runs: one count that opens their list. Hidden while no run asks. Mounted in the
 * top bar (every run, from anywhere) and twice in the seat's bar: beside the manual-process control (the seated worker's
 * runs, `names: false`) and for the other workers' runs. Never a password prompt's text: the bridge's codes in words.
 */
export class AttentionChip {
  readonly el: HTMLElement;
  private key = '';
  constructor(private readonly host: AttentionChipHost, private readonly o: { names: boolean; label: string; cls?: string }) {
    this.el = h('div', { class: `mpa${o.cls ? ` ${o.cls}` : ''}`, role: 'group', 'aria-label': o.label, 'data-hook': 'manual-attention' });
    this.el.hidden = true;
  }
  get shown(): boolean { return !this.el.hidden; }
  set(list: readonly RunAttention[]): void {
    const key = JSON.stringify(list.map((r) => [r.attention.id, r.attention.kind, r.attention.confidence, r.attention.reason, r.process.id, r.process.worker_name, r.process.command]));
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !list.length;
    const had = this.el.contains(document.activeElement);
    if (!list.length) { this.el.replaceChildren(); return; }
    if (list.length > 1) {
      const sure = list.some((r) => r.attention.confidence !== 'uncertain');
      const text = attentionCount(list);
      const b: HTMLButtonElement = h('button', { class: 'mpa-count', 'aria-haspopup': 'dialog', 'aria-label': `Manual runs: ${text}. Open the list`, title: list.map((r) => `${attentionLabel(r.attention)}: ${r.process.worker_name} · ${shortCommand(r.process)}`).join('\n'), onclick: () => this.host.list(b) },
        h('span', { class: `mpa-tape${sure ? '' : ' mpa-tape--maybe'}` }, icon(ICON.terminal), h('span', {}, text)), icon(ICON.chevron));
      this.el.dataset.kind = sure ? 'sure' : 'maybe';
      this.el.replaceChildren(b);
      if (had) b.focus({ preventScroll: true });
      return;
    }
    const r = list[0]!;
    const a = r.attention;
    const sure = a.confidence !== 'uncertain';
    const detail = attentionDetail(a);
    const action = attentionAction(a);
    const act: HTMLButtonElement = h('button', { class: 'mpa-act', 'aria-haspopup': 'dialog', 'aria-label': attentionActionName(r), 'data-process': r.process.id, onclick: () => (a.kind === 'credential' ? this.host.respond(r.process.id, act) : this.host.terminal(r.process.id, act)) }, action);
    const what = this.o.names ? `${r.process.worker_name || r.process.worker} · ${shortCommand(r.process)}` : shortCommand(r.process);
    this.el.dataset.kind = sure ? 'sure' : 'maybe';
    this.el.title = [`${attentionLabel(a)}: ${r.process.worker_name} · ${r.process.host}`, shortCommand(r.process, 120), detail].filter(Boolean).join('\n');
    this.el.replaceChildren(h('span', { class: `mpa-tape${sure ? '' : ' mpa-tape--maybe'}` }, icon(a.kind === 'credential' ? ICON.lock : ICON.terminal), h('span', {}, attentionLabel(a))), h('span', { class: 'mpa-what' }, what), act);
    if (had) act.focus({ preventScroll: true });
  }
}
