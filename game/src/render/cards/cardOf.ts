import { answerable, choicesOf, questionAbout, questionLine } from '../../world/answer';
import { askLine, askOf, isSimple, optionLabel, quickReplyBlocker } from '../../world/ask';
import { taskLine } from '../../world/derive';
import type { WorkerView } from '../../world/store';
import { usageText } from '../../world/usage';
import type { CardData } from './types';
// M6: write-code crews.
import { withCrew } from './crewCard';
// #83: wrap-ups.
import { needsYouLine, WRAPPING_UP, wrapUpOf } from '../../world/wrapup';
import { BOX_TAPE } from '../palette';
// #90: follow-up questions.
import { followupLine, followupOf, questionsCount } from '../../world/followup';
// #157: a shared Codex worker's async questions.
import { askingText, asyncLine } from '../../world/codexQuestions';

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
  // #90: open questions in its final message: like an ask of several questions, answered at the laptop.
  const followup = v.display === 'needs_you' && !card.ask ? followupOf(v.worker) : null;
  if (followup) card.ask = { text: followupLine(followup), choices: [], about: [`${questionsCount(followup)}: answer at the laptop (E)`] };
  // #157: a Codex worker's async questions: it works on (its status stays), the card says what it asks.
  const asks = !card.ask && v.display !== 'asleep' ? (v.asks ?? 0) : 0;
  if (asks) card.ask = { text: asyncLine(v.worker), choices: [], about: [`Codex ${askingText(asks)} · answer at the laptop (E)`] };
  if (focus) {
    const u = usageText(v.worker.usage).line;
    if (u) card.usage = u;
  }
  if (v.crew) withCrew(card, v.crew, focus, !!v.worker.title?.trim());
  // #83: wrapping up, the cardboard tape; a wrap-up that needs you says why (a question of its agent goes first).
  const wrap = wrapUpOf(v.worker);
  if (wrap?.state === 'armed' && v.display !== 'needs_you' && v.display !== 'asleep') card.tape = { text: WRAPPING_UP, color: BOX_TAPE, box: true };
  else if (wrap?.state === 'needs_you' && !card.ask) card.task = needsYouLine(wrap);
  return card;
}
