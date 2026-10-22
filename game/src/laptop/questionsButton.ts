import { h, icon } from '../ui/dom';
import { questionWord } from '../world/codexQuestions';
import './questionsButton.css';

export interface QuestionsState {
  /** Mandatory questions pending (an ask's question count; a screen-detected BlockedQuestion counts 1). */
  urgent: number;
  /** Optional lanes. */
  followup: number; // "Open questions"
  asyncq: number; // "Codex asked"
  /** The sheet is open now (aria-expanded). */
  open: boolean;
}

type Lane = 'urgent' | 'optional';

/** A stop sign with an exclamation: the agent cannot go on. */
const STOP = '<path d="M8.4 3.5h7.2l4.9 4.9v7.2l-4.9 4.9H8.4l-4.9-4.9V8.4z"/><path d="M12 7.8v4.9"/><path d="M12 16.2v.1"/>';
/** A speech bubble with a question mark: something was asked, nothing waits on it. */
const BUBBLE = '<path d="M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5h-6.5l-4.5 3.5v-3.5H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z"/><path d="M10 9.4a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.3"/><path d="M12 14.6v.1"/>';

/** What the button shows and says for a state with questions: its lane, label, count, name and announcement. */
function describe(s: QuestionsState): { lane: Lane; label: string; count: number; name: string; say: string } {
  if (s.urgent > 0) {
    const optional = s.followup + s.asyncq;
    const also = optional > 0 ? ` (${optional} optional ${optional === 1 ? 'question waits' : 'questions wait'} too)` : '';
    return {
      lane: 'urgent',
      label: 'Answer to continue',
      count: s.urgent,
      name: `Answer to continue: ${questionWord(s.urgent)}${also}`,
      say: `The agent is waiting for your answer: ${questionWord(s.urgent)}`,
    };
  }
  const total = s.followup + s.asyncq;
  const [label, name] =
    s.followup && s.asyncq
      ? ['Questions', `Questions: ${s.followup} open, ${s.asyncq} from Codex`]
      : s.followup
        ? ['Open questions', `Open questions: ${s.followup}`]
        : ['Codex asked', `Codex asked ${questionWord(s.asyncq)}`];
  return { lane: 'optional', label, count: total, name, say: name };
}

/**
 * #187: the questions button, where the pinned cards were. It shows while questions wait and opens the questions sheet.
 * Two lanes, told apart by label and icon as well as colour (WCAG 1.4.1): urgent (the agent is blocked: an ask or a
 * terminal prompt) is red, a stop sign and "Answer to continue", and its ring pulses; optional (follow-ups, Codex's async
 * asks) is a calm slate cyan, a speech bubble and its lane's name, and its ring stays still. Urgent wins when both wait.
 * The pulse stops under reduced motion and while the page is hidden (`.tx[data-page-hidden]`).
 *
 * `live` (mounted by the caller inside `.tx`) says it when the button appears and when the lane changes, not when a
 * count changes within a lane: an announcement per answered question would talk over the screen reader's own reading.
 */
export class QuestionsButton {
  readonly el: HTMLButtonElement;
  readonly live: HTMLElement;
  private readonly labelEl = h('span', { class: 'tx-qbtn-label' });
  private readonly countEl = h('span', { class: 'tx-qbtn-count', 'aria-hidden': 'true' });
  private iconLane: Lane | null = null;
  private lane: Lane | null = null;

  constructor(opts: { onOpen: () => void; controls?: string /* the sheet's id for aria-controls */ }) {
    this.el = h('button', { class: 'tx-qbtn', hidden: true, 'aria-expanded': 'false', 'aria-controls': opts.controls, onclick: () => opts.onOpen() }, this.labelEl, this.countEl);
    this.live = h('div', { class: 'tx-qbtn-live', role: 'status', 'aria-live': 'polite' });
  }

  set(s: QuestionsState): void {
    this.el.setAttribute('aria-expanded', String(s.open));
    if (s.urgent + s.followup + s.asyncq <= 0) {
      this.el.hidden = true;
      this.lane = null;
      return;
    }
    const d = describe(s);
    this.el.hidden = false;
    this.el.dataset.lane = d.lane;
    this.el.setAttribute('aria-label', d.name);
    this.el.title = d.name;
    this.labelEl.textContent = d.label;
    this.countEl.textContent = String(d.count);
    if (this.iconLane !== d.lane) {
      const svg = icon(d.lane === 'urgent' ? STOP : BUBBLE);
      svg.dataset.icon = d.lane === 'urgent' ? 'stop' : 'bubble';
      svg.classList.add('tx-qbtn-icon');
      this.el.querySelector('svg')?.remove();
      this.el.prepend(svg);
      this.iconLane = d.lane;
    }
    if (this.lane !== d.lane) this.say(d.say);
    this.lane = d.lane;
  }

  destroy(): void {
    this.el.remove();
    this.live.remove();
  }

  private say(text: string): void {
    // Emptied first, so the same words twice are announced twice.
    this.live.textContent = '';
    queueMicrotask(() => (this.live.textContent = text));
  }
}
