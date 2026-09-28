import type { GameAudio } from '../audio';
import './audio.css';

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SPEAKER = '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/>';
const ICON = {
  off: svg(`${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`),
  low: svg(`${SPEAKER}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>`),
  high: svg(`${SPEAKER}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 6.8a7.2 7.2 0 0 1 0 10.4"/>`),
};

/**
 * The top bar's sound control: a mute toggle and a volume slider, both
 * remembered per browser by the audio module. Muting silences the voice
 * only; speech bubbles still show.
 */
export function mountAudioControls(parent: HTMLElement, audio: GameAudio, before: Element | null = null): { dispose(): void } {
  const group = document.createElement('div');
  group.className = 'audio-ctl';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Sound');
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'btn btn--icon audio-mute';
  mute.setAttribute('aria-label', 'Mute sound');
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.className = 'audio-vol';
  vol.min = '0';
  vol.max = '100';
  vol.step = '5';
  vol.setAttribute('aria-label', 'Volume');
  group.append(mute, vol);
  parent.insertBefore(group, before && before.parentNode === parent ? before : null);

  let icon = '';
  const sync = () => {
    const pct = Math.round(audio.volume * 100);
    const off = audio.muted || pct === 0;
    mute.setAttribute('aria-pressed', String(audio.muted));
    mute.title = !audio.available ? 'No sound in this browser' : audio.muted ? 'Unmute sound' : 'Mute sound (speech bubbles still show)';
    const next = off ? ICON.off : pct < 45 ? ICON.low : ICON.high;
    if (next !== icon) mute.innerHTML = icon = next;
    if (vol.value !== String(pct)) vol.value = String(pct);
    vol.setAttribute('aria-valuetext', audio.muted ? `${pct}%, muted` : `${pct}%`);
    vol.title = `Volume ${pct}%`;
    group.style.setProperty('--fill', `${pct}%`);
    group.dataset.muted = String(audio.muted);
    mute.disabled = vol.disabled = !audio.available;
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
  mute.addEventListener('click', onMute);
  vol.addEventListener('input', onInput);
  const off = audio.onChange(sync);
  sync();
  return {
    dispose() {
      off();
      mute.removeEventListener('click', onMute);
      vol.removeEventListener('input', onInput);
      group.remove();
    },
  };
}
