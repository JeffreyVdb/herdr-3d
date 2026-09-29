/**
 * A shuffled playlist that plays every track once before any repeats: the
 * order is a random permutation; when it is used up a new one is drawn, and it
 * never starts with the track that just played. `next()` is also how a genre
 * "resumes": the queue remembers where it was while another genre plays.
 */
export class ShuffleQueue {
  private order: string[] = [];
  private pos = 0;
  private lastId: string | null = null;

  constructor(
    private readonly ids: readonly string[],
    private readonly random: () => number = Math.random,
  ) {}

  get size(): number {
    return this.ids.length;
  }

  /** The next track id; null for an empty list. */
  next(): string | null {
    if (!this.ids.length) return null;
    if (this.pos >= this.order.length) this.reshuffle();
    const id = this.order[this.pos++] as string;
    this.lastId = id;
    return id;
  }

  private reshuffle(): void {
    const a = [...this.ids];
    // Fisher–Yates.
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j] as string, a[i] as string];
    }
    // A new round never opens with the track that closed the last one.
    if (a.length > 1 && a[0] === this.lastId) [a[0], a[a.length - 1]] = [a[a.length - 1] as string, a[0] as string];
    this.order = a;
    this.pos = 0;
  }
}
