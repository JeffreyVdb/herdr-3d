import { answerable, choicesOf, questionLine } from '../../world/answer';
import { taskLine } from '../../world/derive';
import type { WorkerView } from '../../world/store';
import { usageText } from '../../world/usage';
import type { CardData } from './types';

/**
 * What a worker's speech bubble says: its name, status and task; M5: a
 * blocked worker's question and numbered choices, and (`focus`: you look at
 * it) its usage line.
 */
export function cardOf(v: WorkerView, focus = false): CardData {
  const card: CardData = { name: v.name, display: v.display, task: taskLine(v.worker) };
  const q = v.display === 'needs_you' ? answerable(v.worker.question) : null;
  if (q) {
    const text = questionLine(q);
    const choices = choicesOf(q).map((c) => ({ n: c.n, label: c.label }));
    if (text || choices.length) card.ask = { text, choices, selected: q.selected };
  }
  if (focus) {
    const u = usageText(v.worker.usage).line;
    if (u) card.usage = u;
  }
  return card;
}
