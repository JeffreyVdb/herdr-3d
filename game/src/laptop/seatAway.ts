/**
 * #187: why the worker you sit at cannot be reached right now, or null when it can. You are never stood up for it: the
 * view, its draft and its images stay, the seat bar says so, nothing is sent and no watch is asked for until it is back
 * (a woken floor, a new pane). Pure: the frame loop reads it, the tests pin it down.
 */
export interface AwayView {
  worker: { session: string; pane_id?: string | null };
}

export function whyAway(name: string, v: AwayView | null, session: string, asleep: boolean): string | null {
  if (!v || v.worker.session !== session) return `${name} is no longer on the floor.`;
  if (asleep) return `${name}’s floor is asleep.`;
  if (!v.worker.pane_id) return `${name} has no terminal right now.`;
  return null;
}

/** The seat bar's line while away: the reason, and what that means for what you type. */
export function awayNote(why: string): string {
  return `${why} Nothing you type is sent.`;
}
