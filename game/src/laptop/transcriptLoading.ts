import './transcriptLoading.css';
import { h } from '../ui/dom';

/**
 * #126: the conversation opening, before there is anything to read: the render module loading, the watch's answer on
 * its way, the first rows being built. A still outline of a conversation (lines of the agent's, a tool call, your
 * bubble), its newest rows at the bottom, where the conversation opens; they brighten in turn from the bottom up, the
 * order the rows arrive in. Opacity only, so the compositor keeps it moving while the page builds; still under reduced
 * motion. In the main bundle (the render module's stylesheet comes with that module): the overlay shows it while the
 * module loads, and the view in its timeline until the watch answers.
 */

/** The outline's rows, top to bottom: the agent's lines (widths in %), a tool call's row, your bubble. */
const SHAPE: ReadonlyArray<{ said: readonly number[] } | { tool: number } | { you: number }> = [
  { said: [86, 64] },
  { tool: 42 },
  { you: 46 },
  { said: [94, 88, 52] },
  { tool: 34 },
  { tool: 50 },
  { said: [78, 36] },
];

/** The words it says (`who`: whose conversation; none: the conversation). */
export const loadingText = (who?: string | null): string => (who ? `Opening ${who}’s conversation…` : 'Opening the conversation…');

/** The outline, for the timeline's place (`.txl`; the view hides it once its rows are there). */
export function loadingOutline(who?: string | null): HTMLElement {
  const rows = SHAPE.map((s, i) => {
    // The wave starts at the bottom row: its delay is its distance from it.
    const style = `--txl-i: ${SHAPE.length - 1 - i}`;
    if ('said' in s) return h('div', { class: 'txl-row txl-said', style }, ...s.said.map((w) => h('span', { class: 'txl-line', style: `width: ${w}%` })));
    if ('tool' in s) return h('div', { class: 'txl-row txl-tool', style }, h('span', { class: 'txl-icon' }), h('span', { class: 'txl-line', style: `width: ${s.tool}%` }));
    return h('div', { class: 'txl-row txl-you', style }, h('span', { class: 'txl-bubble', style: `width: ${s.you}%` }));
  });
  return h('div', { class: 'txl', role: 'status' }, h('div', { class: 'txl-rows', 'aria-hidden': 'true' }, ...rows), h('p', { class: 'txl-text' }, loadingText(who)));
}

/** The whole screen's stand-in while the render module loads: the view's strip, the outline and the prompt box's place. */
export function loadingScreen(who?: string | null): HTMLElement {
  return h('div', { class: 'txl-screen' }, h('div', { class: 'txl-bar' }), h('div', { class: 'txl-main' }, loadingOutline(who)), h('div', { class: 'txl-foot' }));
}
