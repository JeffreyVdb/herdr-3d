import './screenShare.css';
import { SURFACE_WORD } from '../screen/capture';
import type { ShareView } from '../screen/share';

/** Authored 24×24 stroke icons, the top bar's weight. */
const ICON = {
  share: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20M12 13.2V8M9.6 10.2 12 7.8l2.4 2.4"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
};
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** What the LIVE group says is shared. */
export function sharedLine(v: Pick<ShareView, 'surface' | 'paused'>): string {
  const what = v.surface ? `Sharing ${SURFACE_WORD[v.surface]}` : 'Sharing';
  return v.paused ? `${what} · paused` : what;
}

/**
 * M13: the top bar's screen share control. Off: "Share screen". Choosing: the same button, busy. Sharing: the red
 * LIVE tape, what is shared, and Stop. Presentation only: the app wires `start` (straight from the click, for the
 * browser's user activation) and `stop`.
 */
export class ShareControl {
  readonly el = document.createElement('div');
  private readonly start = document.createElement('button');
  private readonly live = document.createElement('div');
  private readonly what = document.createElement('span');
  private readonly stopBtn = document.createElement('button');

  constructor(actions: { start(): void; stop(): void }, supported: boolean) {
    this.el.className = 'share';
    this.start.type = 'button';
    this.start.className = 'btn share-start';
    this.start.innerHTML = `${svg(ICON.share)}<span>Share screen</span>`;
    this.start.setAttribute('aria-label', 'Share screen');
    this.start.title = supported
      ? 'Share a tab, a window or your screen on the office TV. It stays on this Mac: an agent gets one frame only when it asks, and you see who.'
      : 'This browser cannot share a screen here. Use Chrome on the Mac.';
    if (!supported) this.start.setAttribute('aria-disabled', 'true');
    this.start.addEventListener('click', () => actions.start());
    this.live.className = 'share-live';
    this.live.setAttribute('role', 'status');
    const tape = document.createElement('span');
    tape.className = 'tape share-tape';
    tape.innerHTML = '<i></i>Live';
    this.what.className = 'share-what';
    this.stopBtn.type = 'button';
    this.stopBtn.className = 'btn share-stop';
    this.stopBtn.innerHTML = `${svg(ICON.stop)}<span>Stop</span>`;
    this.stopBtn.title = 'Stop sharing your screen';
    this.stopBtn.addEventListener('click', () => actions.stop());
    this.live.append(tape, this.what, this.stopBtn);
    this.el.append(this.start, this.live);
    this.set({ phase: 'off', paused: false, w: 0, h: 0, gen: 0 });
  }

  set(v: ShareView): void {
    const on = v.phase === 'live';
    this.el.dataset.phase = v.phase;
    this.el.dataset.paused = String(on && v.paused);
    this.start.hidden = on;
    this.live.hidden = !on;
    this.start.toggleAttribute('aria-busy', v.phase === 'picking');
    if (v.phase === 'picking') this.start.setAttribute('aria-busy', 'true');
    const line = sharedLine(v);
    if (this.what.textContent !== line) this.what.textContent = line;
    this.live.title = `${line}. Agents see a frame only when they ask.`;
    this.live.setAttribute('aria-label', `Live: ${line}`);
  }
}
