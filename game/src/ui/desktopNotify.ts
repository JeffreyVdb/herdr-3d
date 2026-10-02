/**
 * #100: the inbox's desktop notifications, for when the game is not in front
 * (in front, the inbox chip pulses and a toast says it instead). The page's
 * own `Notification`, no service worker: there is none while the game is
 * closed (the inbox has it all when you are back). Never asks for the
 * permission itself (Settings does); where there is no API, it is not
 * granted, or the constructor refuses (Android Chrome wants a service
 * worker), nothing shows.
 */

import type { PingEntry, PingKind } from '../world/inboxPings';

interface NotificationLike {
  onclick: ((ev: Event) => unknown) | null;
  onclose: ((ev: Event) => unknown) | null;
  close(): void;
}

export interface NotificationApi {
  readonly permission: NotificationPermission;
  new (title: string, options?: NotificationOptions & { renotify?: boolean }): NotificationLike;
}

export interface NotifyEnv {
  /** The page's `Notification`; undefined where there is none. */
  api(): NotificationApi | undefined;
  /** The window is in front. */
  focused(): boolean;
  focusWindow(): void;
}

export const browserEnv: NotifyEnv = {
  api: () => (typeof Notification === 'undefined' ? undefined : (Notification as unknown as NotificationApi)),
  focused: () => !document.hidden && document.hasFocus(),
  focusWindow: () => window.focus(),
};

export interface Note {
  title: string;
  body: string;
  /** One notification per tag: a worker's id, or BURST_TAG. */
  tag: string;
  /** After the window was focused and the notification closed. */
  onClick(): void;
}

/** A collapsed burst's tag. */
export const BURST_TAG = 'h3d-inbox';

/** 'focused': not shown, the window is in front (say it in the game); 'off': not shown (switched off, no permission, no API). */
export type NotifyResult = 'shown' | 'focused' | 'off';

export class DesktopNotify {
  private readonly open = new Map<string, NotificationLike>();

  constructor(private readonly env: NotifyEnv = browserEnv) {}

  /** `enabled`: the inbox's desktop setting. */
  show(n: Note, enabled: boolean): NotifyResult {
    if (this.env.focused()) return 'focused';
    const api = this.env.api();
    if (!enabled || !api || api.permission !== 'granted') return 'off';
    let note: NotificationLike;
    try {
      note = new api(n.title, { body: n.body, tag: n.tag, renotify: false });
    } catch {
      return 'off';
    }
    this.open.set(n.tag, note);
    note.onclick = () => {
      this.env.focusWindow();
      note.close();
      n.onClick();
    };
    note.onclose = () => {
      if (this.open.get(n.tag) === note) this.open.delete(n.tag);
    };
    return 'shown';
  }

  /** Closes the ones still up of these tags (a burst's first pings, once it collapses). */
  close(tags: Iterable<string>): void {
    for (const t of tags) {
      this.open.get(t)?.close();
      this.open.delete(t);
    }
  }
}

/** "Chirp needs you", "Nutmeg finished". */
export const pingTitle = (kind: PingKind, name: string): string => (kind === 'needs' ? `${name} needs you` : `${name} finished`);

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/** A collapsed burst: "4 agents need you" (any of them does) or "4 agents finished", and their names. */
export function burstText(entries: readonly PingEntry[], needs: number): { title: string; body: string } {
  const n = entries.length;
  const names = entries.slice(0, 3).map((e) => e.name);
  const body = n > 3 ? `${names.join(', ')} and ${n - 3} more` : names.join(', ');
  return { title: needs ? `${agents(n)} need${n === 1 ? 's' : ''} you` : `${agents(n)} finished`, body };
}

/** A snapshot's new entries: "While you were away: 3 finished, 1 needs you". */
export function awayText(needs: number, finished: number): string {
  const parts: string[] = [];
  if (finished) parts.push(`${finished} finished`);
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  return `While you were away: ${parts.join(', ')}`;
}
