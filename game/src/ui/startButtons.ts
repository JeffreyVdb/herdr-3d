import type { Hud } from './hud';
import { RUN_ICON } from './deskTabs';
import { h, icon } from './dom';

/**
 * M6 start: the top bar's Run (on an office floor: start a run at its first
 * free desk) and Team presets (in the city, next to Buildings). Against an
 * older bridge Run stays, disabled, with the reason as its tooltip.
 */

export interface M6StartButtons {
  readonly run: HTMLButtonElement;
  readonly presets: HTMLButtonElement;
  /** Re-reads whether the bridge can start runs. */
  sync(): void;
}

const TEAM_ICON = '<circle cx="8.5" cy="8.5" r="2.7"/><circle cx="15.8" cy="9.5" r="2.2"/><path d="M3.8 18.5c.5-3 2.4-4.7 4.7-4.7s4.2 1.7 4.7 4.7"/><path d="M14 14.2c.6-.3 1.2-.4 1.8-.4 2 0 3.6 1.5 4 4.2"/>';
const RUN_TITLE = 'Start a run: hire an orchestrator with a team preset at the first free desk (or pick Hire orchestrator at a desk’s +)';

export function m6StartButtons(hud: Hud, o: { run(): void; presets(from: HTMLElement): void; off(): string | null }): M6StartButtons {
  const run = h('button', { class: 'btn btn--run', 'data-action': 'run', title: RUN_TITLE }, icon(RUN_ICON), h('span', {}, 'Run'));
  const presets = h('button', { class: 'btn', 'data-action': 'presets', title: 'Team presets: who a run hires for each role' }, icon(TEAM_ICON), h('span', {}, 'Presets'));
  // Off on an older bridge (aria-disabled, the reason as its tooltip), yet focusable: a click opens the dialog, which says why.
  run.addEventListener('click', () => o.run());
  presets.addEventListener('click', () => o.presets(presets));
  hud.addTopbarButton(run, 'hire', (mode, area) => mode === 'floor' && area === 'floor');
  hud.addTopbarButton(presets, 'buildings', (mode) => mode === 'city');
  const sync = () => {
    const why = o.off();
    run.setAttribute('aria-disabled', why ? 'true' : 'false');
    run.title = why ?? RUN_TITLE;
    presets.title = why ? `Team presets: ${why}` : 'Team presets: who a run hires for each role';
  };
  sync();
  return { run, presets, sync };
}
