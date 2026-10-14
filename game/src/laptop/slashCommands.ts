import './completionRows.css';
import type { CommandEntry } from '../net/protocol';
import type { Source } from '../ui/composer/complete';
import { rankByName, type Ranked } from '../world/rank';
import { h } from '../ui/dom';
import type { CommandsState } from './commandCatalog';

/**
 * #140: the transcript composer's `/` source: the worker's slash commands and skills (`commandCatalog.ts`), ranked by
 * name as you type (`rank.ts`). A row is `/name` with the matched characters marked, the argument hint, the first line
 * of the description and the kind; a pick puts `/name ` in as plain text (the bridge rewrites a Codex skill to `$name`
 * when the prompt goes, #138, so it is offered as `/name` too, and the footer says so).
 *
 * The popup's states follow the list: the cached one at once (the popup's opening asks again, and the rows follow the
 * answer), "Loading…" while the first ask is out, a failed first ask an error (the next popup asks again), a failed
 * refresh the old rows and a note, a partial list its built-ins and a note, and a worker the bridge has no list for
 * (no Claude or Codex agent) no popup at all.
 *
 * #140: a built-in whose output or dialog shows only in the worker's terminal (the bridge's `terminal` mark) has a
 * "terminal" badge; sending one switches the seat to the terminal (`TranscriptMode`, on the prompt's ack).
 *
 * #39: also the Hire, Start run and Prompt dialogs' `/` (`ui/dialogCompletion.ts`), over a list of the hire's context
 * (its harness may change: `harness` can be read live). The first ask says "Loading skills…" (a probe of the harness can
 * take seconds; only this popup waits for it); a failed one names why and offers "Try again". `/` is the catalog only
 * (the skills the harness finds, global ones too) and the footer says files are `@`'s: a skill's own file is not one.
 */

/** What the source reads: one worker's list (`WorkerCommandList`). */
export interface CommandList {
  readonly state: CommandsState;
  refresh(): Promise<void>;
  subscribe(f: () => void): () => void;
}

export type CommandItem = Ranked<CommandEntry>;

const firstLine = (s: string): string => s.split('\n', 1)[0]?.trim() ?? '';

/** `/name`, the matched characters in their own spans. */
function nameOf(c: CommandItem): HTMLElement {
  const n = c.item.name;
  const hit = new Set(c.hits);
  const el = h('span', { class: 'tx-cmd-name' }, '/');
  let run = '';
  let on = false;
  const flush = () => {
    if (run) el.append(on ? h('span', { class: 'tx-cmd-hit' }, run) : run);
    run = '';
  };
  for (let i = 0; i < n.length; i++) {
    if (hit.has(i) !== on) {
      flush();
      on = !on;
    }
    run += n[i];
  }
  flush();
  return el;
}

export const SKILLS_HINT = 'Skills and commands · type @ for files';

export function commandSource(list: CommandList, harnessOf: string | (() => string)): Source<CommandItem> {
  const harness = () => (typeof harnessOf === 'string' ? harnessOf : harnessOf());
  const ranked = (q: string): CommandItem[] | null => {
    const all = list.state.commands;
    return all ? rankByName(all, q, (c) => c.name) : null;
  };
  return {
    trigger: '/',
    label: 'Commands and skills',
    available: () => !list.state.unavailable,
    opening: () => void list.refresh(),
    subscribe: (f) => list.subscribe(f),
    key: (c) => `${c.item.kind}:${c.item.name}`,
    items(q) {
      const now = ranked(q);
      if (now) return now;
      if (!list.state.loading) return Promise.reject(new Error('no list'));
      // The first ask is out: its answer (the popup drops it if the query moved on meanwhile).
      return list.refresh().then(() => {
        const r = ranked(q);
        if (!r) throw new Error('no list');
        return r;
      });
    },
    render(c) {
      const { description, argument_hint: hint, kind, terminal } = c.item;
      const desc = firstLine(description);
      // #140: its output or dialog shows only in the worker's terminal (the view switches there once it is sent).
      const where = terminal === 'always' ? 'Shows in the worker’s terminal, not in the conversation' : terminal === 'bare' ? `/${c.item.name} alone shows in the worker’s terminal; with arguments it runs here` : '';
      return h(
        'span',
        { class: 'tx-cmd', 'data-kind': kind, title: description ? `/${c.item.name}: ${description}` : `/${c.item.name}` },
        nameOf(c),
        // Spaces between the parts, for the option's accessible name (a flex row draws none).
        hint ? ' ' : null,
        hint ? h('span', { class: 'tx-cmd-arg' }, hint) : null,
        ' ',
        h('span', { class: 'tx-cmd-desc' }, desc),
        ' ',
        where ? h('span', { class: 'tx-cmd-term', title: where }, 'terminal') : null,
        // Said with the row (the badge's tooltip is for the pointer only).
        where ? h('span', { class: 'tx-cmd-sr' }, `: ${where.charAt(0).toLowerCase()}${where.slice(1)}`) : null,
        where ? ' ' : null,
        h('span', { class: 'tx-cmd-kind' }, kind),
      );
    },
    insert(c, token, text) {
      // A space already after the word: the caret goes past it rather than a second one going in.
      return { text: `/${c.item.name} `, ...(text[token.end] === ' ' ? { end: token.end + 1 } : {}) };
    },
    loading: () => 'Loading skills…',
    failure: () => {
      const why = list.state.error?.trim().replace(/\.$/, '');
      return why ? `Could not load skills: ${why}.` : 'Could not load skills.';
    },
    retry: () => void list.refresh(),
    footer() {
      const s = list.state;
      const notes: string[] = [];
      if (s.partial) notes.push('Partial list: only the built-in commands so far');
      if (s.failed && s.commands) notes.push('Could not refresh: the list may be out of date');
      if (harness() === 'codex' && s.commands?.some((c) => c.kind === 'skill')) notes.push('Codex: skills are sent as $name');
      return notes.join(' · ') || SKILLS_HINT;
    },
  };
}
