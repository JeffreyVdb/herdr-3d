/** #116: how long a new hire's go-to waits for the worker and its drop-in to finish. */
export const HIRE_GOTO_WAIT_MS = 6000;
/** #116: how often the wait looks again. */
export const HIRE_GOTO_POLL_MS = 100;

export interface HireGotoWait {
  /** What the world looks like now: `go` (ready), `wait` (not yet), `drop` (something else took over: forget it). */
  check(): 'go' | 'wait' | 'drop';
  /** Whether the player did anything since the wait began (moved, turned, sat, took a dialog or panel): once true, for good. */
  acted(): boolean;
  go(): void;
  /** Once, however the wait ended (went, dropped, acted on, timed out, cancelled). */
  end?(): void;
  now?(): number;
  schedule?(fn: () => void, ms: number): void;
}

/**
 * #116: the wait of a new hire's go-to: polls `check` until it says `go` (then `go()`), `drop`, the player acted, or
 * `HIRE_GOTO_WAIT_MS` ran out. The deadline and the player come first at every look, ready or not: a timer that ran late
 * (a throttled or resumed tab) never acts on a readiness that came after the time was up. Returns its cancel.
 */
export function waitForHire(w: HireGotoWait, ms = HIRE_GOTO_WAIT_MS): () => void {
  const now = w.now ?? (() => performance.now());
  const schedule = w.schedule ?? ((fn, t) => void setTimeout(fn, t));
  const until = now() + ms;
  let over = false;
  const finish = (): void => {
    if (over) return;
    over = true;
    w.end?.();
  };
  const look = (): void => {
    if (over) return;
    if (now() >= until || w.acted()) return finish();
    const r = w.check();
    if (r === 'wait') return schedule(look, HIRE_GOTO_POLL_MS);
    finish();
    if (r === 'go') w.go();
  };
  look();
  return finish;
}

/**
 * #116: calls `onAct` the moment the player does something the polls could miss between two looks: a key or a pointer
 * press (walking, a click, Esc closing a panel), a wheel turn, or any dialog taking `open` (a modal Settings or About that
 * is up and gone again within 100 ms). Returns its stop. A dialog *closing* is not an act: the hire dialog's own close
 * event comes after the ack that started the wait.
 */
export function onPlayerAct(onAct: () => void, doc: Document = document): () => void {
  const ac = new AbortController();
  for (const t of ['keydown', 'pointerdown', 'wheel'] as const) doc.addEventListener(t, onAct, { capture: true, passive: true, signal: ac.signal });
  // (Read from the records, not the dialog: one opened and closed again within the batch still says it was opened.)
  const mo = new MutationObserver((rs) => {
    for (const r of rs) if (r.target instanceof HTMLDialogElement && r.oldValue === null) return onAct();
  });
  mo.observe(doc, { subtree: true, attributes: true, attributeFilter: ['open'], attributeOldValue: true });
  return () => {
    ac.abort();
    mo.disconnect();
  };
}
