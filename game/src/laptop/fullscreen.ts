import type { ZoomInfo } from '../net/protocol';

/**
 * #74: what the seat's zoom chip says about the pane you sit at. A split herdr pane shows at its own size (60 columns
 * next to another pane, say); herdr's zoom gives the pane the whole tab. The chip states the fact and is the switch.
 * #176: it shows only while the terminal is watched read only (another client owns the pane): while the seat owns it,
 * the PTY is the window's size. It is called "Zoom herdr tab", never fullscreen: the workspace already fills the
 * window, and the chip changes what herdr's own screen shows. Pure: the logic is tested without a DOM.
 */
export interface FullscreenChip {
  /** The chip's text. */
  label: string;
  /** `aria-pressed`: the pane fills the tab. */
  pressed: boolean;
  /** `aria-disabled`: it shows a fact but does nothing (it stays focusable, so a keyboard user can read why). */
  disabled: boolean;
  /** The accessible name (the label alone does not say what the click does). */
  aria: string;
  /** The tooltip: what the state means and what a click does. */
  title: string;
  /** What a click asks the bridge for (null: nothing). */
  action: 'zoom' | 'unzoom' | null;
}

/**
 * The chip for a watch's zoom state at its terminal size, or null when there is nothing to say: no zoom info (a bridge
 * before #74, or a command it does not know) and a tab with a single pane (the pane has the whole tab already).
 */
export function fullscreenChip(zoom: ZoomInfo | null | undefined, size: { cols: number; rows: number } | null): FullscreenChip | null {
  if (!zoom || zoom.state === 'single') return null;
  if (zoom.state === 'zoomed' && zoom.headless) {
    return {
      label: 'Zoom unavailable',
      pressed: false,
      disabled: true,
      aria: 'Zoom herdr tab, unavailable',
      title: 'herdr zoomed this pane, but no herdr screen is attached to the session, so the terminal keeps its own size. Open herdr on this session to get a wider screen.',
      action: null,
    };
  }
  if (zoom.state === 'zoomed') {
    return {
      label: 'herdr tab zoomed',
      pressed: true,
      disabled: false,
      aria: 'Zoom herdr tab, on',
      title: 'This pane fills its herdr tab. Click to go back to the split layout.',
      action: 'unzoom',
    };
  }
  const fact = size ? `Split pane ${size.cols}×${size.rows}` : 'Split pane';
  return {
    label: size ? `Zoom herdr tab (split ${size.cols}×${size.rows})` : 'Zoom herdr tab (split)',
    pressed: false,
    disabled: false,
    aria: `Zoom herdr tab, off. ${fact.replace('×', ' by ')}`,
    title: 'This pane shares its herdr tab with others, so it shows at its own size. Click to zoom it to the whole tab (it goes back when you stand up).',
    action: 'zoom',
  };
}
