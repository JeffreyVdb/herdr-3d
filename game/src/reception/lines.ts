/**
 * What the receptionist says, and when: pure logic (no three, no DOM, no
 * audio), so the rules are unit-tested with an injected clock and RNG.
 */

/** What happened, from the player's point of view. */
export type ReceptionEvent =
  | 'arrive-street' // walked into the lobby through the front door from the sidewalk
  | 'arrive-elevator' // stepped out of the elevator into the lobby
  | 'leave-front' // walked out through the front door
  | 'interact'; // pressed E at the reception desk

/** Line kinds; one manifest entry per variant (`game/voices/receptionist.json`: id, kind, text). */
export type LineKind =
  | 'welcome-morning'
  | 'welcome-afternoon'
  | 'welcome-evening'
  | 'welcome-night'
  | 'elevator'
  | 'goodbye'
  | 'nudge'
  | 'quiet'
  | 'interact';

export const LINE_KINDS: readonly LineKind[] = [
  'welcome-morning',
  'welcome-afternoon',
  'welcome-evening',
  'welcome-night',
  'elevator',
  'goodbye',
  'nudge',
  'quiet',
  'interact',
];

/** Live building state the lines depend on (derived from the WorldStore). */
export interface ReceptionContext {
  now: Date; // the browser's local clock (the Mac's)
  building: { id: string | null; name: string };
  floors: Array<{ session: string; name: string; state: 'running' | 'asleep'; needsYou: number }>;
}

export interface Said {
  kind: LineKind;
  id: string; // manifest id == clip file stem
  text: string; // what the voice says
  bubble: string; // what the speech bubble shows (nudge: live floor names + counts)
}

/** One manifest entry. `text` may carry MiMo style tags: `(Happy) Hi!`. */
export interface VoiceLine {
  id: string;
  kind: LineKind;
  text: string;
}

/** Walking in and out: greetings and goodbyes each hold off for this long. */
export const COOLDOWN_MS = 2 * 60 * 1000;

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

/** Local-clock buckets: morning 05–11, afternoon 12–16, evening 17–21, night 22–04. */
export function timeOfDay(d: Date): TimeOfDay {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

/** The words without MiMo's performance tags: `(Happy) Hi [laugh] there` → `Hi there`. */
export function plainText(text: string): string {
  return text
    .replace(/[(（[][^)）\]]*[)）\]]/g, ' ')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Validates a parsed manifest; throws with the first problem. Every kind needs a line. */
export function parseLines(raw: unknown): VoiceLine[] {
  const lines = (raw as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) throw new Error('voice manifest: `lines` must be an array');
  const seen = new Set<string>();
  const out: VoiceLine[] = [];
  for (const l of lines as Array<Record<string, unknown>>) {
    const { id, kind, text } = l ?? {};
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`voice manifest: bad id ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`voice manifest: duplicate id ${id}`);
    if (typeof kind !== 'string' || !LINE_KINDS.includes(kind as LineKind)) throw new Error(`voice manifest: ${id}: bad kind ${JSON.stringify(kind)}`);
    if (typeof text !== 'string' || !plainText(text)) throw new Error(`voice manifest: ${id}: empty text`);
    seen.add(id);
    out.push({ id, kind: kind as LineKind, text });
  }
  for (const k of LINE_KINDS) if (!out.some((l) => l.kind === k)) throw new Error(`voice manifest: no line of kind ${k}`);
  return out;
}

/** The nudge bubble: who is waiting, per floor (`Waiting on you: 2 on herdr-3d, 1 on pastry.`). */
export function nudgeBubble(floors: ReceptionContext['floors'], max = 3): string {
  const waiting = floors.filter((f) => f.needsYou > 0);
  const shown = waiting.slice(0, max).map((f) => `${f.needsYou} on ${f.name}`);
  const more = waiting.length - shown.length;
  if (more > 0) shown.push(`${more} more ${more === 1 ? 'floor' : 'floors'}`);
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '');
  return `Waiting on you: ${list}.`;
}

type Group = 'greeting' | 'goodbye';

const GROUP: Record<ReceptionEvent, Group | null> = {
  'arrive-street': 'greeting',
  'arrive-elevator': 'greeting',
  'leave-front': 'goodbye',
  interact: null,
};

/**
 * Picks lines for events: variants at random without repeating the previous
 * pick of a kind, and a cooldown per group (greetings, goodbyes) timed on
 * `ctx.now`. `interact` is never held back and doesn't start a cooldown.
 */
export class LineBook {
  private readonly byKind = new Map<LineKind, VoiceLine[]>();
  private readonly last = new Map<LineKind, string>();
  private readonly until = new Map<Group, number>();

  constructor(
    lines: readonly VoiceLine[],
    private readonly rng: () => number = Math.random,
    private readonly cooldownMs = COOLDOWN_MS,
  ) {
    for (const l of lines) this.byKind.set(l.kind, [...(this.byKind.get(l.kind) ?? []), l]);
  }

  /** When the group's cooldown ends (ms on the context clock), null when it isn't running. */
  cooldownUntil(group: Group, now: number): number | null {
    const u = this.until.get(group);
    return u !== undefined && u > now ? u : null;
  }

  handle(ev: ReceptionEvent, ctx: ReceptionContext): Said[] {
    const now = ctx.now.getTime();
    const group = GROUP[ev];
    if (group && this.cooldownUntil(group, now) !== null) return [];
    const out: Said[] = [];
    const say = (kind: LineKind, bubble?: string) => {
      const l = this.pick(kind);
      if (l) out.push({ kind, id: l.id, text: plainText(l.text), bubble: bubble ?? plainText(l.text) });
    };
    switch (ev) {
      case 'arrive-street': {
        say(`welcome-${timeOfDay(ctx.now)}`);
        if (ctx.floors.some((f) => f.needsYou > 0)) say('nudge', nudgeBubble(ctx.floors));
        else if (ctx.floors.every((f) => f.state === 'asleep')) say('quiet');
        break;
      }
      case 'arrive-elevator':
        say('elevator');
        break;
      case 'leave-front':
        say('goodbye');
        break;
      case 'interact':
        say('interact');
        break;
    }
    if (group && out.length) this.until.set(group, now + this.cooldownMs);
    return out;
  }

  private pick(kind: LineKind): VoiceLine | null {
    const all = this.byKind.get(kind) ?? [];
    const prev = this.last.get(kind);
    const pool = all.length > 1 ? all.filter((l) => l.id !== prev) : all;
    const l = pool[Math.min(pool.length - 1, Math.floor(this.rng() * pool.length))];
    if (!l) return null;
    this.last.set(kind, l.id);
    return l;
  }
}
