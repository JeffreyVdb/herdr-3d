/**
 * Frame-rate policy (docs/decisions.md): 120 Hz while interacting or moving,
 * 30–60 Hz when idle, paused when hidden, plus a battery-saver toggle.
 * #143: a full-screen layer over the scene caps it (the overview page, the whiteboard).
 */

/** What covers the whole viewport: nothing, a see-through scrim (the whiteboard), an opaque page (the overview). */
export type Coverage = 'none' | 'scrim' | 'opaque';

export interface FrameInputs {
  hidden: boolean;
  batterySaver: boolean;
  /** ms since the last input, camera move or scene transition. */
  sinceActivity: number;
  /** #143: default 'none'. */
  covered?: Coverage;
}

/**
 * #143: under the opaque overview page. Low enough that the hidden scene costs next to nothing, high enough that
 * `step()` still ticks the page's refresh (its 250 ms gate), the wall screen, the departures and the rack: with
 * `shouldRender`'s slack this is a frame every 200 ms on a 60 Hz display (5/s), every ~192 ms on a 120 Hz one.
 */
export const OPAQUE_HZ = 4;
/** #143: under the whiteboard's 88–92 % scrim, where the scene's motion barely reads. */
export const SCRIM_HZ = 20;

/** How long after the last input the game still counts as "interacting". */
export const ACTIVE_WINDOW_MS = 1500;

export function targetHz(i: FrameInputs): number {
  if (i.hidden) return 0;
  const active = i.sinceActivity < ACTIVE_WINDOW_MS;
  const hz = i.batterySaver ? (active ? 60 : 30) : active ? 120 : 60;
  return i.covered === 'opaque' ? Math.min(hz, OPAQUE_HZ) : i.covered === 'scrim' ? Math.min(hz, SCRIM_HZ) : hz;
}

/**
 * Whether a display frame at `now` should render, given the last rendered
 * frame. Allows a quarter-frame of slack so a 120 Hz display renders every
 * vsync at 120 and every other vsync at 60.
 */
export function shouldRender(now: number, lastRender: number, hz: number): boolean {
  if (hz <= 0) return false;
  return now - lastRender >= (1000 / hz) * 0.75;
}
