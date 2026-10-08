import './crew.css';
import { crewAsk, crewTag } from '../render/cards/crewCard';
import { passWords, type CrewView } from '../world/crew';
import type { WorkerView } from '../world/store';
import { h } from './dom';

/**
 * M6: the look-at prompt bar's crew line for a write-code crew member: its
 * role tag in the run's colour, the issue (`owner/repo#n`) and run, and
 * then its phase and pass (an orchestrator) or what its report says (a
 * reviewer's verdict stamp, the `input_required` question, the summary).
 */

/** What the line shows, so the bar redraws when any of it changes. */
export function crewBarKey(w: WorkerView): string[] {
  const c = w.crew;
  if (!c) return [];
  return [crewTag(c).text, crewTag(c).color, c.issue ?? '', c.run ?? '', c.stamp?.text ?? '', crewAsk(c)?.text ?? '', c.summary ?? '', c.life ?? ''];
}

function report(c: CrewView): { text: string; cls: string } | null {
  const ask = crewAsk(c);
  if (ask) return { text: ask.text, cls: 'crew-ask' };
  if (c.role === 'orch') {
    const p = [c.phase, passWords(c.pass ?? undefined)].filter(Boolean).join(' · ');
    return p ? { text: p, cls: 'crew-phase' } : null;
  }
  if (c.summary) return { text: c.summary.replace(/\s+/g, ' '), cls: 'crew-summary' };
  return null;
}

/** The crew line, null for everyone else. */
export function crewLine(w: WorkerView): HTMLElement | null {
  const c = w.crew;
  if (!c) return null;
  const tag = crewTag(c);
  // Its own label for screen readers (the bar's label names the worker, its status and task).
  const line = h('div', { class: 'prompt-crew', role: 'group', 'aria-label': crewAria(w) }, h('span', { class: 'crew-tag', style: `--run: ${tag.color}` }, tag.text));
  if (c.issue) line.append(h('span', { class: 'crew-issue', title: c.issue.includes('#') ? `GitHub issue ${c.issue}` : `Task ${c.issue}` }, c.issue));
  else if (c.ticket) line.append(h('span', { class: 'crew-issue' }, `ticket ${c.ticket}`));
  if (c.run) line.append(h('span', { class: 'crew-run', title: `write-code run ${c.run}` }, `run ${c.run}`));
  if (c.stamp) line.append(h('span', { class: `crew-stamp crew-stamp--${c.stamp.tone}` }, c.stamp.text));
  const r = report(c);
  if (r) line.append(h('span', { class: r.cls, title: r.text }, r.text));
  return line;
}

/** The same for screen readers: the crew line's label. */
export function crewAria(w: WorkerView): string {
  const c = w.crew;
  if (!c) return '';
  const r = report(c);
  return [crewTag(c).text, c.issue ?? (c.ticket ? `ticket ${c.ticket}` : null), c.run ? `run ${c.run}` : null, c.stamp?.text, r?.text].filter(Boolean).join(' · ');
}
