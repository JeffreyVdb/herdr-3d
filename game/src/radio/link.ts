import { genreName, RADIO_OFF_NAME } from '../audio/tracks';
import type { Music, NowPlaying, RadioEvent, RadioState } from '../audio/music';
import type { OfficeView } from '../render/office';

/** How long the "now playing" toast stays. */
export const NOW_PLAYING_MS = 3000;

export const nowPlayingText = (n: NowPlaying): string => `♪ ${n.track.title} · ${n.track.artist}`;

/** What the radio prop's HUD hint says. */
export const radioHint = (genre: RadioState['genre']): string => `Radio: ${genre === 'off' ? RADIO_OFF_NAME : genreName(genre)} · E next genre · R next track`;

export interface RadioLinkDeps {
  music: Music;
  /** `soft`: does not cover a message that is still showing. */
  toast(msg: string, ms: number, soft?: boolean): void;
  /** The look-at bar's radio line changed (genre name; "Off"). */
  hudRadio(name: string): void;
}

/**
 * What the game does around the radio: it plays only while you are on the
 * floor that has it (fades out in the lobby, on the street, on the fire
 * escape, in the city), sits at the prop's place, shows its state on its
 * display and LED, announces each new track, and answers E and R.
 */
export class RadioLink {
  private office: OfficeView | null = null;
  private drawn = '';
  private named = '';
  private readonly off: () => void;

  constructor(private readonly d: RadioLinkDeps) {
    this.off = d.music.onTrack((n) => d.toast(nowPlayingText(n), NOW_PLAYING_MS, true));
    this.name(d.music.state);
  }

  private name(s: RadioState): void {
    const n = s.genre === 'off' ? RADIO_OFF_NAME : genreName(s.genre);
    if (n === this.named) return;
    this.named = n;
    this.d.hudRadio(n);
  }

  /** Once per frame: `onFloor` is you standing on an office floor (not its fire escape, the lobby, the street or the city). */
  frame(onFloor: boolean, office: OfficeView | null): void {
    const m = this.d.music;
    const here = onFloor ? office : null;
    m.setActive(!!here);
    if (office !== this.office) {
      this.office = office;
      this.drawn = '';
      const b = office?.layout.props.find((p) => p.id === 'radio')?.box;
      if (b) m.setPosition({ x: (b.min[0] + b.max[0]) / 2, y: (b.min[1] + b.max[1]) / 2, z: (b.min[2] + b.max[2]) / 2 });
    }
    const s = m.state;
    this.name(s);
    const key = `${s.genre}|${s.playing}`;
    if (office && key !== this.drawn) {
      this.drawn = key;
      office.setRadio(s.genre === 'off' ? null : genreName(s.genre), s.playing);
    }
  }

  /** E on the radio: the next genre (Off is a stop of the cycle). */
  cycle(): void {
    const m = this.d.music;
    const g = m.cycleGenre();
    if (g === 'off') this.d.toast('Radio off', 1800);
    else if (m.muted) this.d.toast(`${genreName(g)} · the music is muted (top bar)`, 2600);
  }

  /** R on the radio: the next track of the genre. */
  skip(): void {
    const m = this.d.music;
    if (m.genre === 'off') {
      this.d.toast('The radio is off: E picks a genre', 2000);
      return;
    }
    m.nextTrack();
    if (m.muted) this.d.toast('The music is muted (top bar)', 2000);
  }

  get state(): RadioState {
    return this.d.music.state;
  }

  get events(): readonly RadioEvent[] {
    return this.d.music.events;
  }

  dispose(): void {
    this.off();
  }
}
