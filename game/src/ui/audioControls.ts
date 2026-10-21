import type { GameAudio } from '../audio';
import './audio.css';

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SPEAKER = '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/>';
const NOTE = '<path d="M9.5 17V6.2l8-1.7v10.7"/><circle cx="7.3" cy="17.2" r="2.2"/><circle cx="15.3" cy="15.4" r="2.2"/>';
const ICON = {
  music: svg(NOTE),
  musicOff: svg(`${NOTE}<path d="M4 4l16 16"/>`),
  credits: svg('<circle cx="12" cy="12" r="8"/><path d="M12 11v5.2M12 7.9v.1"/>'),
  off: svg(`${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`),
  low: svg(`${SPEAKER}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>`),
  high: svg(`${SPEAKER}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 6.8a7.2 7.2 0 0 1 0 10.4"/>`),
};

/** What the credits button needs: called with the element to give focus back to. */
export interface AudioControlOptions {
  openCredits?: (from: HTMLElement) => void;
}

/**
 * The top bar's sound control: one pill with the master (a mute toggle and a
 * volume for everything the game says and plays) and a Music button. The
 * button opens a small popover under it with the office radio's own mute and
 * volume, and a button for the Music credits. Everything is remembered per
 * browser by the audio module. Muting the master silences the voice and the
 * music; speech bubbles still show.
 */
export function mountAudioControls(parent: HTMLElement, audio: GameAudio, before: Element | null = null, o: AudioControlOptions = {}): { dispose(): void } {
  const group = document.createElement('div');
  group.className = 'audio-ctl';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Sound');

  const slider = (kind: 'master' | 'music', label: string) => {
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = `audio-vol audio-vol--${kind}`;
    vol.min = '0';
    vol.max = '100';
    vol.step = '5';
    vol.setAttribute('aria-label', label);
    return vol;
  };
  const muteButton = (kind: 'master' | 'music', label: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--icon audio-mute audio-mute--${kind}`;
    b.setAttribute('aria-label', label);
    return b;
  };

  const mute = muteButton('master', 'Mute all sound');
  const vol = slider('master', 'Sound volume');
  const sep = document.createElement('span');
  sep.className = 'audio-sep';
  sep.setAttribute('aria-hidden', 'true');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'btn btn--icon audio-music';
  trigger.setAttribute('aria-label', 'Music');
  trigger.setAttribute('aria-haspopup', 'true');

  // The popover: the music's mute and volume, and the credits.
  const pop = document.createElement('div');
  pop.className = 'audio-pop';
  pop.id = 'audio-music-pop';
  pop.setAttribute('popover', 'auto');
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', 'Music');
  const title = document.createElement('p');
  title.className = 'audio-pop-title';
  title.textContent = 'Lounge radio';
  const row = document.createElement('div');
  row.className = 'audio-pop-row';
  const musicMute = muteButton('music', 'Mute music');
  const musicVol = slider('music', 'Music volume');
  const pct = document.createElement('output');
  pct.className = 'audio-pop-pct';
  row.append(musicMute, musicVol, pct);
  pop.append(title, row);
  let credits: HTMLButtonElement | null = null;
  if (o.openCredits) {
    const open = o.openCredits;
    credits = document.createElement('button');
    credits.type = 'button';
    credits.className = 'btn btn--sm audio-credits';
    credits.innerHTML = `${ICON.credits}<span>Music credits</span>`;
    credits.addEventListener('click', () => {
      pop.hidePopover?.();
      open(trigger);
    });
    pop.append(credits);
  }
  trigger.setAttribute('popovertarget', pop.id);
  group.append(mute, vol, sep, trigger, pop);
  parent.insertBefore(group, before && before.parentNode === parent ? before : null);

  /** Below the button when it fits, otherwise above; keep the fixed popover inside the viewport. */
  const place = () => {
    const r = trigger.getBoundingClientRect();
    const height = pop.offsetHeight;
    const below = Math.round(r.bottom + 8);
    const top = below + height <= window.innerHeight - 12 ? below : Math.round(r.top - height - 8);
    pop.style.setProperty('--pop-top', `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`);
    pop.style.setProperty('--pop-right', `${Math.max(12, Math.round(window.innerWidth - r.right))}px`);
  };
  const placeIfOpen = () => {
    if (pop.matches(':popover-open')) place();
  };
  let hadFocus = false;
  const onBeforeToggle = (e: Event) => {
    if ((e as ToggleEvent).newState === 'open') place();
    else hadFocus = pop.contains(document.activeElement);
  };
  // Closed with focus inside (Esc, light dismiss, the credits button): it goes back to the Music button.
  const onToggle = (e: Event) => {
    // The open popover has a measurable height; beforetoggle only positions its first paint.
    if ((e as ToggleEvent).newState === 'open') place();
    else if (hadFocus) trigger.focus();
    hadFocus = false;
  };
  pop.addEventListener('beforetoggle', onBeforeToggle);
  pop.addEventListener('toggle', onToggle);
  window.addEventListener('resize', placeIfOpen);
  window.addEventListener('scroll', placeIfOpen, true);
  // The game's own keys (E, R, WASD…) are not for the popover.
  const onKey = (e: KeyboardEvent) => e.stopPropagation();
  pop.addEventListener('keydown', onKey);

  let masterIcon = '';
  let musicIcon = '';
  const sync = () => {
    const p = Math.round(audio.volume * 100);
    const off = audio.muted || p === 0;
    mute.setAttribute('aria-pressed', String(audio.muted));
    mute.title = !audio.available ? 'No sound in this browser' : audio.muted ? 'Unmute all sound' : 'Mute all sound: voices and music (speech bubbles still show)';
    const next = off ? ICON.off : p < 45 ? ICON.low : ICON.high;
    if (next !== masterIcon) mute.innerHTML = masterIcon = next;
    if (vol.value !== String(p)) vol.value = String(p);
    vol.setAttribute('aria-valuetext', audio.muted ? `${p}%, muted` : `${p}%`);
    vol.title = `Sound volume ${p}%`;
    vol.style.setProperty('--fill', `${p}%`);
    group.dataset.muted = String(audio.muted);

    const m = audio.music;
    const mp = Math.round(m.volume * 100);
    const moff = m.muted || mp === 0;
    trigger.setAttribute('aria-label', m.muted ? 'Music, muted' : 'Music');
    trigger.dataset.muted = String(m.muted);
    trigger.title = !audio.available ? 'No sound in this browser' : m.muted ? 'Music (muted): volume, mute and credits' : `Music ${mp}%: volume, mute and credits`;
    musicMute.setAttribute('aria-pressed', String(m.muted));
    musicMute.title = m.muted ? 'Unmute music' : 'Mute music (voices stay)';
    const mnext = moff ? ICON.musicOff : ICON.music;
    if (mnext !== musicIcon) trigger.innerHTML = musicMute.innerHTML = musicIcon = mnext;
    if (musicVol.value !== String(mp)) musicVol.value = String(mp);
    musicVol.setAttribute('aria-valuetext', m.muted ? `${mp}%, muted` : `${mp}%`);
    musicVol.title = `Music volume ${mp}%`;
    musicVol.style.setProperty('--fill', `${mp}%`);
    pct.textContent = `${mp}%`;
    pop.dataset.muted = String(m.muted);

    mute.disabled = vol.disabled = trigger.disabled = !audio.available;
    if (!audio.available) pop.hidePopover?.();
  };

  const onMute = () => {
    audio.muted = !audio.muted;
    // Unmuting at zero volume would still be silent: bring it back to a usable level.
    if (!audio.muted && audio.volume === 0) audio.volume = 0.5;
  };
  const onInput = () => {
    audio.volume = Number(vol.value) / 100;
    if (audio.muted && audio.volume > 0) audio.muted = false;
  };
  const onMusicMute = () => {
    audio.music.muted = !audio.music.muted;
    if (!audio.music.muted && audio.music.volume === 0) audio.music.volume = 0.4;
  };
  const onMusicInput = () => {
    audio.music.volume = Number(musicVol.value) / 100;
    if (audio.music.muted && audio.music.volume > 0) audio.music.muted = false;
  };
  mute.addEventListener('click', onMute);
  vol.addEventListener('input', onInput);
  musicMute.addEventListener('click', onMusicMute);
  musicVol.addEventListener('input', onMusicInput);
  const off = audio.onChange(sync);
  sync();
  return {
    dispose() {
      off();
      mute.removeEventListener('click', onMute);
      vol.removeEventListener('input', onInput);
      musicMute.removeEventListener('click', onMusicMute);
      musicVol.removeEventListener('input', onMusicInput);
      pop.removeEventListener('beforetoggle', onBeforeToggle);
      pop.removeEventListener('toggle', onToggle);
      window.removeEventListener('resize', placeIfOpen);
      window.removeEventListener('scroll', placeIfOpen, true);
      pop.removeEventListener('keydown', onKey);
      group.remove();
    },
  };
}
