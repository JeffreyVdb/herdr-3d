/**
 * Frame-rate policy (docs/decisions.md): 120 Hz while interacting or moving,
 * 30–60 Hz when idle, paused when hidden, plus a battery-saver toggle.
 */

export interface FrameInputs {
  hidden: boolean;
  batterySaver: boolean;
  /**
   * ms since the last activity: input, a camera move or a scene transition (0 while something animates: walking, a
   * camera tween, the doors, arrivals, busy boards). #142: a world event or a board push is not activity; idle draws it.
   */
  sinceActivity: number;
}

/** How long after the last activity (`sinceActivity`) the game still counts as "interacting". */
export const ACTIVE_WINDOW_MS = 1500;

export function targetHz(i: FrameInputs): number {
  if (i.hidden) return 0;
  const active = i.sinceActivity < ACTIVE_WINDOW_MS;
  if (i.batterySaver) return active ? 60 : 30;
  return active ? 120 : 60;
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
