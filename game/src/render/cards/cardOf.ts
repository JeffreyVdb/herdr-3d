import { answerable, choicesOf, questionAbout, questionLine } from '../../world/answer';
import { askLine, askOf, isSimple, optionLabel, quickReplyBlocker } from '../../world/ask';
import { taskLine } from '../../world/derive';
import type { WorkerView } from '../../world/store';
import { usageText } from '../../world/usage';
import type { CardData } from './types';
// M6: write-code crews.
import { withCrew } from './crewCard';

/**
 * What a worker's speech bubble says: its name, status and task; M5: a
 * blocked worker's question, what it is about (the command, file or folder)
 * and its numbered choices, and (`focus`: you look at it) its usage line.
 */
export function cardOf(v: WorkerView, focus = false): CardData {
  const card: CardData = { name: v.name, display: v.display, task: taskLine(v.worker) };
  // #57: an agent's structured question wins over what its screen shows: its digits when one pick answers it, else
  // where to answer it.
  const ask = v.display === 'needs_you' ? askOf(v.worker) : null;
  const q = v.display === 'needs_you' && !ask ? answerable(v.worker.question) : null;
  if (ask) {
    const q0 = ask.questions[0] as NonNullable<(typeof ask.questions)[0]>;
    card.ask = isSimple(ask)
      ? { text: q0.question.replace(/\s+/g, ' ').trim(), choices: q0.options.map((o, i) => ({ n: i + 1, label: optionLabel(o.label).text })), ...(q0.header ? { about: [q0.header] } : {}) }
      : { text: askLine(ask), choices: [], about: [`${quickReplyBlocker(ask)}: answer at the laptop (E)`] };
  } else if (q) {
    const text = questionLine(q);
    const choices = choicesOf(q).map((c) => ({ n: c.n, label: c.label }));
    const about = questionAbout(q);
    if (text || choices.length) card.ask = { text, choices, selected: q.selected, ...(about.length ? { about } : {}) };
  }
  if (focus) {
    const u = usageText(v.worker.usage).line;
    if (u) card.usage = u;
  }
  if (v.crew) withCrew(card, v.crew, focus, !!v.worker.title?.trim());
  return card;
}
