import type { CommandResult } from '../net/client';
import type { CommandArgs, HireAck } from '../net/protocol';
import { codexNotice } from '../world/codexServer';
import type { FailedImage, ResolveResult } from './composer/draft';
import { HIRE_PROMPT_MAX_BYTES, serializeErrorText } from './composer/model';
import { hiredToast } from './hiredToast';
import type { ToastKind } from './hud';
import { failureText } from './messages';

/**
 * #210: one hire from Hire to its outcome, shared by the hire dialog (and later the dictation flow): hold the desk, upload
 * the first task's images, send `worker.hire` once, let the desk go. It has no DOM: the caller hands it a snapshot of what
 * was reviewed when Hire was pressed, and reads the outcome.
 *
 * In the foreground the caller waits and says what happened (the dialog's status line, its toast, the go-to). In the
 * background the caller has already moved on, so the coordinator says it itself, once: "Agent spawned successfully." and
 * one beep, or a direct error. Never through the inbox, its pulses, desktop notifications or pings; never a go-to.
 *
 * A dropped connection or a timeout does not say whether the worker was hired (the bridge may have done it): that is an
 * unknown outcome, never a second `worker.hire`.
 */

/** The background success toast, word for word. */
export const SPAWNED_TEXT = 'Agent spawned successfully.';
/** A Codex fallback warning waits this long after the success toast (the HUD shows one toast at a time; an info one ~3.6 s). */
export const SPAWNED_NOTICE_GAP_MS = 3800;

export interface HireCoordinatorHost {
  send(t: 'worker.hire', args: CommandArgs['worker.hire']): Promise<CommandResult>;
  /** A hire is on its way to `desk` (its "+" goes); the returned function ends this hire's hold only. */
  reserve(session: string, desk: number): () => void;
  toast(msg: string, kind: ToastKind): void;
  /** The background success beep (under the master mute and volume). */
  beep(): void;
  /** The hired worker as the world has it by the ack (its name, and the desk it took). */
  workerView?(id: string): { name: string; desk: number } | null;
  /** The Codex warning's delay after the success toast (tests). */
  later?(fn: () => void, ms: number): void;
}

/** The first task to send: a composer draft, resolved (images uploaded) once the desk is held. */
export interface HirePrompt {
  resolve(o: { maxBytes?: number }): Promise<ResolveResult>;
}

/** What was reviewed when Hire was pressed. Later edits and setting changes never reach a hire on its way. */
export interface HireRequest {
  /** The submission: starting the same key again while it runs is the same operation (a second Enter). */
  key: string;
  session: string;
  desk: number;
  /** `prompt` here is the form's text; with `prompt` below it is replaced by the resolved text. */
  args: CommandArgs['worker.hire'];
  /** The worker's name as the form had it (its label, else the prepared name), for the messages. */
  who: string;
  /** The draft whose images go up first (null: `args.prompt` is sent as it is). */
  prompt: HirePrompt | null;
  /** Settings → Display "Hire in background", as it was when Hire was pressed. */
  background: boolean;
}

type NotResolved = Exclude<ResolveResult, { ok: true }>;

export type HireOutcome =
  /** Hired and the first task (if any) delivered. `revision`: the draft revision that was sent (null: no draft). */
  | { kind: 'hired'; ack: HireAck | undefined; revision: number | null }
  /** Hired, but the first task did not reach the worker (`prompted: false`): it is prompted by hand, never hired again. */
  | { kind: 'not_prompted'; ack: HireAck; revision: number | null }
  /** The first task could not be made (an image did not upload, too long, a held refusal): `worker.hire` was not sent. */
  | { kind: 'not_sent'; result: NotResolved; message: string }
  /** `worker.hire` was refused (or never sent: offline). Nobody was hired. */
  | { kind: 'failed'; code: string; message: string }
  /** No answer (timeout, dropped connection): it may have happened. */
  | { kind: 'unknown'; code: 'timeout' | 'disconnected'; message: string };

export type HirePhase = 'uploading' | 'hiring' | 'done';

export interface HireOperation {
  readonly request: Readonly<HireRequest>;
  readonly phase: HirePhase;
  readonly done: Promise<HireOutcome>;
}

export interface HireObserver {
  /** The images are up: `worker.hire` goes now. */
  hiring?(args: Readonly<CommandArgs['worker.hire']>): void;
}

/** Why a hire is held back by images that did not upload (each chip has its own reason and Retry). */
export function uploadFailedText(failed: FailedImage[], where = ''): string {
  const names = failed.map((f) => `image ${f.numbers.join(' and ') || '?'} (${f.name})`).join(', ');
  return `Nothing was hired${where}: ${names} did not upload (${failed[0]?.message ?? 'unknown error'}). Retry ${failed.length === 1 ? 'it' : 'them'} on the picture, or remove ${failed.length === 1 ? 'it' : 'them'}, then hire again. Your prompt is kept.`;
}

/** The first task that never reached a worker that is there (`prompted: false`). */
export function notPromptedText(ack: Pick<HireAck, 'prompt_error'>): string {
  return `The first task was not sent (${ack.prompt_error ?? 'no reason given'}): prompt them yourself (P); the text stays in this desk’s hire dialog.`;
}

class Operation implements HireOperation {
  phase: HirePhase = 'uploading';
  done!: Promise<HireOutcome>;
  constructor(readonly request: Readonly<HireRequest>) {}
}

export class HireCoordinator {
  private readonly running = new Map<string, Operation>();

  constructor(private readonly host: HireCoordinatorHost) {}

  /** Hires on their way. */
  get inFlight(): readonly HireOperation[] {
    return [...this.running.values()];
  }

  /**
   * Starts a hire: the desk is held before this returns, and the draft is read now (what is typed after this is not
   * sent). The same `key` while it runs is the operation already on its way.
   */
  start(req: HireRequest, on: HireObserver = {}): HireOperation {
    const had = this.running.get(req.key);
    if (had) return had;
    const snap: Readonly<HireRequest> = Object.freeze({ ...req, args: Object.freeze({ ...req.args }) });
    const op = new Operation(snap);
    this.running.set(snap.key, op);
    const release = this.host.reserve(snap.session, snap.desk);
    op.done = this.run(op, on).then(
      (o) => this.finish(op, release, o),
      (e: unknown) => this.finish(op, release, { kind: 'failed', code: 'internal', message: String(e) }),
    );
    return op;
  }

  private async run(op: Operation, on: HireObserver): Promise<HireOutcome> {
    const req = op.request;
    const args = { ...req.args };
    let revision: number | null = null;
    // The images go first: Drop Zone paths go into the text, so nothing is sent until every image is uploaded.
    // (`resolve` reads the draft as it is at this call, before its first await.)
    if (req.prompt && args.prompt) {
      const r = await req.prompt.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES });
      if (!r.ok) return { kind: 'not_sent', result: r, message: notSentText(r, req.background ? ` at Desk ${req.desk + 1}` : '') };
      args.prompt = r.text;
      revision = r.revision;
    }
    op.phase = 'hiring';
    on.hiring?.(args);
    const r = await this.host.send('worker.hire', args);
    if (r.ok) {
      const ack = r.data as HireAck | undefined;
      return ack?.prompted === false ? { kind: 'not_prompted', ack, revision } : { kind: 'hired', ack, revision };
    }
    if (r.code === 'timeout' || r.code === 'disconnected') return { kind: 'unknown', code: r.code, message: r.message };
    return { kind: 'failed', code: r.code, message: r.message };
  }

  private finish(op: Operation, release: () => void, o: HireOutcome): HireOutcome {
    op.phase = 'done';
    release();
    this.running.delete(op.request.key);
    if (op.request.background) this.notify(op.request, o);
    return o;
  }

  /** The background hire's one message (and the success's one beep). */
  private notify(req: Readonly<HireRequest>, o: HireOutcome): void {
    const desk = `Desk ${req.desk + 1}`;
    // Hires on their way end in any order: a message names its desk.
    const which = (msg: string) => (msg.includes(desk) ? msg : `${desk} of ${req.session} · ${msg}`);
    switch (o.kind) {
      case 'hired': {
        this.host.toast(SPAWNED_TEXT, 'info');
        this.host.beep();
        const fallback = codexNotice({ codex: o.ack?.codex });
        if (fallback) (this.host.later ?? ((fn, ms) => void setTimeout(fn, ms)))(() => this.host.toast(fallback.text, 'warn'), SPAWNED_NOTICE_GAP_MS);
        return;
      }
      case 'not_prompted': {
        const w = this.host.workerView?.(o.ack.id) ?? null;
        const t = hiredToast(`Hired ${w?.name ?? req.who} at Desk ${(w?.desk ?? req.desk) + 1}.`, o.ack, notPromptedText(o.ack));
        this.host.toast(t.text, t.kind);
        return;
      }
      case 'not_sent':
        this.host.toast(o.message ? which(o.message) : `Nothing was hired at ${desk}. Your prompt is kept in its hire dialog.`, 'error');
        return;
      case 'failed':
        this.host.toast(which(failureText('worker.hire', o.code, o.message, { floor: req.session, desk: req.desk + 1 })), 'error');
        return;
      case 'unknown':
        this.host.toast(
          `No answer about the hire at ${desk} of ${req.session}: ${o.code === 'timeout' ? 'herdr-world did not answer in time' : 'the connection dropped'}. It may still have gone through: look at the desk before you hire again. The task stays in its hire dialog.`,
          'warn',
        );
        return;
    }
  }
}

/** Why the first task was not sent ('' when the draft says it itself: a refusal the composer holds, a draft gone). */
function notSentText(r: NotResolved, where: string): string {
  if (r.reason === 'upload') return uploadFailedText(r.failed, where);
  if (r.reason === 'serialize') return serializeErrorText(r.error);
  if (r.reason === 'refused' && where) return `Nothing was hired${where}: ${r.message}`;
  return '';
}
