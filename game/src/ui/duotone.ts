import './duotone.css';

/**
 * #216: the seat's duotone line icons. The `ui/dom.ts` ICON family (24 grid, 2 px strokes, round caps and joins,
 * currentColor) with at most one accent element: class `ac` (stroked) or `acf` (filled) takes `--accent-text`, and
 * `--on-action` on an action-filled control (duotone.css). Small controls (chevrons, x, plus, the bare folder) carry no
 * accent: one colour reads better at 10–15 px. The authored pairs are the locked comp's (seat redesign, mock/parts.js);
 * the rest port the seat's existing icons with one meaningful part picked out as the accent.
 */
export type DuotoneName =
  | 'terminal' | 'chat' | 'image' | 'play' | 'files' | 'server' | 'bell' | 'stop' | 'reply' | 'panel' | 'door' | 'question'
  | 'copy' | 'trash' | 'pencil' | 'x' | 'check' | 'expand' | 'search' | 'chevronDown' | 'chevronRight' | 'chevronLeft'
  | 'chevronUp' | 'bolt' | 'folder' | 'file' | 'split' | 'gear'
  // The seat's other icons today (secrets, the request card, history, composer, transcript tool rows, questions).
  | 'lock' | 'alert' | 'refresh' | 'plus' | 'repo' | 'down' | 'up' | 'clock' | 'hire' | 'fileText' | 'globe' | 'agent'
  | 'list' | 'tool' | 'brain' | 'urgent' | 'ask' | 'sparkle' | 'branch' | 'eye'
  // Run elsewhere: one message, two runs.
  | 'fork';

/** [base paths in currentColor, accent paths]; accent elements carry class "ac" (stroke) or "acf" (fill). */
export const DUOTONE: Record<DuotoneName, readonly [string, string]> = {
  terminal: ['<rect x="3.5" y="5" width="17" height="14" rx="2"/>', '<path class="ac" d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>'],
  chat: ['<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4 3.5v-3.5h-1.5a2 2 0 0 1-2-2z"/>', '<path class="ac" d="M8.5 10h.01M12 10h.01M15.5 10h.01" stroke-width="2.6"/>'],
  image: ['<rect x="4" y="5" width="16" height="14" rx="2"/><path d="m5 17 4.5-4.5 3.5 3.5 2.5-2.5L19 17"/>', '<circle class="acf" cx="15" cy="9.5" r="1.9"/>'],
  play: ['<rect x="3.5" y="5" width="17" height="14" rx="2"/>', '<path class="acf" d="M10 9.2v5.6l4.6-2.8z"/>'],
  files: ['<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>', '<path class="ac" d="M8 11v5h4"/><circle class="acf" cx="8" cy="11" r="1.4"/>'],
  server: ['<rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/>', '<path class="ac" d="M7 7.5h.01M7 16.5h.01" stroke-width="2.6"/>'],
  bell: ['<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14z"/><path d="M10 20.5h4"/>', '<circle class="acf" cx="17.5" cy="6.5" r="3"/>'],
  stop: ['<circle cx="12" cy="12" r="8.5"/>', '<rect class="acf" x="9" y="9" width="6" height="6" rx="1"/>'],
  reply: ['<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4 3.5v-3.5h-1.5a2 2 0 0 1-2-2z"/>', '<path class="ac" d="M10.5 7.5 8 10l2.5 2.5M8 10h5.5a2.5 2.5 0 0 1 2.5 2.5"/>'],
  panel: ['<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9.5 5v14"/>', '<path class="ac" d="M16.5 10l-2 2 2 2"/>'],
  door: ['<path d="M4.5 4.5h9v15h-9z"/><path d="M11 12h.01"/>', '<path class="ac" d="M15.5 12h5m-2-2.5 2 2.5-2 2.5"/>'],
  question: ['<circle cx="12" cy="12" r="8.5"/>', '<path class="ac" d="M9.5 9.7a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 1.8"/><path class="ac" d="M12 16.6h.01" stroke-width="2.6"/>'],
  copy: ['<path d="M5.5 15.5v-9a2 2 0 0 1 2-2h9"/>', '<rect class="ac" x="8.5" y="8.5" width="11" height="11" rx="2"/>'],
  trash: ['<path d="M7 7l.8 12.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L17 7"/>', '<path class="ac" d="M5 7h14M10 7V5h4v2"/>'],
  pencil: ['<path d="M5 19l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18z"/>', '<path class="ac" d="M13.8 7l3.2 3.2"/>'],
  x: ['<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', ''],
  check: ['', '<path class="ac" d="M5 12.5l4.5 4.5L19 7.5"/>'],
  expand: ['<path d="M19.5 4.5 13.5 10.5M4.5 19.5l6-6"/>', '<path class="ac" d="M14 4.5h5.5V10M10 19.5H4.5V14"/>'],
  search: ['<circle cx="11" cy="11" r="6"/>', '<path class="ac" d="m20 20-4.5-4.5"/>'],
  chevronDown: ['<path d="M7 9.5l5 5 5-5"/>', ''],
  chevronRight: ['<path d="M9.5 7l5 5-5 5"/>', ''],
  chevronLeft: ['<path d="M14.5 7l-5 5 5 5"/>', ''],
  chevronUp: ['<path d="M7 14.5l5-5 5 5"/>', ''],
  bolt: ['', '<path class="acf" d="M13 3.5 5.5 13.5h6l-.5 7 7.5-10h-6z"/>'],
  folder: ['<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>', ''],
  file: ['<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/>', '<path class="ac" d="M14 3.5V8h4.5"/>'],
  split: ['<rect x="3.5" y="5" width="17" height="14" rx="2"/>', '<path class="ac" d="M12 5v14"/>'],
  gear: ['<path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>', '<circle class="ac" cx="12" cy="12" r="3"/>'],
  lock: ['<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', '<path class="ac" d="M12 14.2v2.4"/>'],
  alert: ['<path d="M10.3 4.6 3.2 17.3A2 2 0 0 0 5 20.3h14a2 2 0 0 0 1.8-3L13.7 4.6a2 2 0 0 0-3.4 0z"/>', '<path class="ac" d="M12 9.5v4.2"/><path class="ac" d="M12 17h.01" stroke-width="2.6"/>'],
  refresh: ['<path d="M19 12a7 7 0 1 1-2.1-5"/>', '<path class="ac" d="M19.2 4.6v3.9h-3.9"/>'],
  plus: ['<path d="M12 5.5v13M5.5 12h13"/>', ''],
  repo: ['<path d="M5.5 18V5.5a2 2 0 0 1 2-2h11v13h-11a2 2 0 0 0-2 2 2 2 0 0 0 2 2h11v-3.5"/>', '<path class="ac" d="M9 20.5v2l1.5-1 1.5 1v-2"/>'],
  down: ['<path d="M12 5v13"/>', '<path class="ac" d="M6.5 13.5 12 19l5.5-5.5"/>'],
  up: ['<path d="M12 19V6"/>', '<path class="ac" d="M6.5 10.5 12 5l5.5 5.5"/>'],
  clock: ['<circle cx="12" cy="12" r="8.5"/>', '<path class="ac" d="M12 7.5V12l3 2"/>'],
  hire: ['<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c.8-3.4 3.4-5.2 6.5-5.2s5.7 1.8 6.5 5.2"/>', '<path class="ac" d="M18.5 7.5v6M15.5 10.5h6"/>'],
  fileText: ['<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>', '<path class="ac" d="M9.5 12h6M9.5 15.5h6"/>'],
  globe: ['<circle cx="12" cy="12" r="8"/>', '<path class="ac" d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>'],
  agent: ['<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>', '<circle class="ac" cx="17" cy="8" r="2.3"/><path class="ac" d="M16 13.2c2.6-.3 4.2 1.2 4.6 4"/>'],
  list: ['<path d="M9 7h11M9 12h11M9 17h11"/>', '<path class="ac" d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" stroke-width="2.6"/>'],
  tool: ['<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16v4h4l5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>', '<circle class="acf" cx="6.4" cy="17.6" r="1.1"/>'],
  brain: ['<path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 9 18.5V5zM15 5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3A3 3 0 0 1 15 18.5V5z"/>', '<path class="ac" d="M6.5 10.5h2.5M17.5 13.5H15"/>'],
  urgent: ['<path d="M8.4 3.5h7.2l4.9 4.9v7.2l-4.9 4.9H8.4l-4.9-4.9V8.4z"/>', '<path class="ac" d="M12 7.8v4.9"/><path class="ac" d="M12 16.2v.1" stroke-width="2.6"/>'],
  ask: ['<path d="M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5h-6.5l-4.5 3.5v-3.5H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z"/>', '<path class="ac" d="M10 9.4a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.3"/><path class="ac" d="M12 14.6v.1" stroke-width="2.6"/>'],
  sparkle: ['', '<path class="acf" d="M12 2.5c.75 5.2 4.3 8.75 9.5 9.5-5.2.75-8.75 4.3-9.5 9.5-.75-5.2-4.3-8.75-9.5-9.5 5.2-.75 8.75-4.3 9.5-9.5z"/>'],
  branch: ['<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><path d="M7 8v8M17 11a5 5 0 0 1-5 5H9"/>', '<circle class="ac" cx="17" cy="9" r="2"/>'],
  eye: ['<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/>', '<circle class="acf" cx="12" cy="12" r="2.6"/>'],
  fork: ['<path d="M3.5 12H9c4 0 4-5.5 8.5-5.5M15 4l2.5 2.5L15 9"/>', '<path class="ac" d="M9 12c4 0 4 5.5 8.5 5.5M15 15l2.5 2.5L15 20"/>'],
};

export const DUOTONE_NAMES = Object.keys(DUOTONE) as DuotoneName[];

/**
 * `<svg class="dt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
 * stroke-linejoin="round" aria-hidden="true" focusable="false">` + base + accent; `cls` adds classes (space-separated).
 * `data-icon` names it (tests, audits).
 */
export function duotone(name: DuotoneName, cls?: string): SVGSVGElement {
  const [base, accent] = DUOTONE[name];
  const t = document.createElement('template');
  t.innerHTML = `<svg class="dt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${base}${accent}</svg>`;
  const svg = t.content.firstElementChild as SVGSVGElement;
  if (cls) svg.classList.add(...cls.split(/\s+/).filter(Boolean));
  svg.dataset.icon = name;
  return svg;
}
