import type { CommandEntry } from '../net/protocol';
import type { Source } from '../ui/composer/complete';
import { rankByName, type Ranked } from '../ui/composer/rank';
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
 */

/** What the source reads: one worker's list (`WorkerCommandList`). */
export interface CommandList {
  readonly state: CommandsState;
  refresh(): Promise<void>;
  subscribe(f: () => void): () => void;
}

export type CommandItem = Ranked<CommandEntry>;

/**
 * Built-ins not offered, per harness (none yet): a command that only opens a dialog in the terminal (which the
 * transcript can neither show nor dismiss) would go here.
 */
const HIDDEN: Readonly<Record<string, ReadonlySet<string>>> = {};

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

export function commandSource(list: CommandList, harness: string): Source<CommandItem> {
  const hidden = HIDDEN[harness];
  const offered = (all: readonly CommandEntry[]) => (hidden ? all.filter((c) => !(c.kind === 'command' && hidden.has(c.name))) : all);
  const ranked = (q: string): CommandItem[] | null => {
    const all = list.state.commands;
    return all ? rankByName(offered(all), q, (c) => c.name) : null;
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
      const { description, argument_hint: hint, kind } = c.item;
      const desc = firstLine(description);
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
        h('span', { class: 'tx-cmd-kind' }, kind),
      );
    },
    insert(c, token, text) {
      // A space already after the word: the caret goes past it rather than a second one going in.
      return { text: `/${c.item.name} `, ...(text[token.end] === ' ' ? { end: token.end + 1 } : {}) };
    },
    footer() {
      const s = list.state;
      const notes: string[] = [];
      if (s.partial) notes.push('Partial list: only the built-in commands so far');
      if (s.failed && s.commands) notes.push('Could not refresh: the list may be out of date');
      if (harness === 'codex' && s.commands?.some((c) => c.kind === 'skill')) notes.push('Codex: skills are sent as $name');
      return notes.join(' · ') || null;
    },
  };
}
