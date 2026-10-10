import type { Page } from '@playwright/test';

// #210, #214: what a background hire says, as the player would notice it, for h210-hire-background.spec.ts and the h214
// specs. The beep is seen in the real Web Audio graph: oscillators started at the spawn tone's pitch (G5) are counted.
// Toasts are recorded as they are shown (the HUD has one toast slot, so a later one replaces the earlier). Desktop
// notifications are stubbed and counted.

/** The background success toast, word for word (ui/hireCoordinator.ts SPAWNED_TEXT). */
export const SPAWNED = 'Agent spawned successfully.';

type Probe = { __beeps: number; __toasts: string[]; __notes: number };

/** Before `openGame`: sets Hire in background and the mute on the first load only (a reload keeps what Settings stored). */
export async function probe(page: Page, o: { background?: boolean; muted?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ background, muted }) => {
      const w = window as unknown as Probe;
      w.__beeps = 0;
      w.__toasts = [];
      w.__notes = 0;
      // Only on the first load: a reload keeps what Settings stored.
      if (!sessionStorage.getItem('hire-probe')) {
        sessionStorage.setItem('hire-probe', '1');
        if (background) localStorage.setItem('h3d.hire.background', 'on');
        if (muted) localStorage.setItem('h3d.audio', JSON.stringify({ muted: true, volume: 0.8 }));
      }
      const make = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        const osc = make.call(this);
        const set = osc.frequency.setValueAtTime.bind(osc.frequency);
        osc.frequency.setValueAtTime = (hz: number, at: number) => {
          if (Math.abs(hz - 783.99) < 0.01) w.__beeps++;
          return set(hz, at);
        };
        return osc;
      };
      const N = function Notification() {
        w.__notes++;
      } as unknown as { permission: string; requestPermission: () => Promise<string> };
      N.permission = 'granted';
      N.requestPermission = () => Promise.resolve('granted');
      Object.defineProperty(window, 'Notification', { value: N, configurable: true, writable: true });
      new MutationObserver((records) => {
        for (const r of records) {
          const t = r.target as HTMLElement;
          if (t instanceof HTMLElement && t.classList.contains('toast') && r.type === 'childList' && t.textContent) w.__toasts.push(t.textContent);
        }
      }).observe(document, { childList: true, subtree: true });
    },
    { background: o.background ?? true, muted: o.muted ?? false },
  );
}

export const beeps = (page: Page) => page.evaluate(() => (window as unknown as Probe).__beeps);
export const toasts = (page: Page) => page.evaluate(() => (window as unknown as Probe).__toasts);
export const notes = (page: Page) => page.evaluate(() => (window as unknown as Probe).__notes);
/** Forgets the toasts so far (what was said before this point is not the hire's). */
export const forgetToasts = (page: Page) => page.evaluate(() => void ((window as unknown as Probe).__toasts = []));
/** `simclock=manual`: releases the simulator's held timers (a hire's ack among them) up to `ms` later. */
export const advance = (page: Page, ms: number) => page.evaluate((m) => window.__h3d.simAdvance(m), ms);

export const pose = async (page: Page) => {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  return p;
};
