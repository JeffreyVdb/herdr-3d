/**
 * M13 screen share: asking the browser for a screen, the way Google Meet does. Chrome's own picker offers a Chrome
 * tab, a window and an entire screen; this game's own tab is left out of it, "Share this tab instead" works while
 * sharing, no audio. Width, height and frame rate are bounds on what Chrome sends after the choice (never a filter on
 * what can be chosen). Research: docs/research/screen-share.md.
 */

import { DISPLAY_SURFACES, type DisplaySurface } from '../net/protocol';

/** Conditional focus: keeps the focus on the game when a tab or window is chosen (Chrome 109+). */
export interface FocusController {
  setFocusBehavior(value: 'no-focus-change'): void;
}

/** Chrome's extensions of the options (the DOM library may lag; these are not feature detection). */
export type DisplayOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
  controller?: FocusController;
};

/** Bounds of the captured video: what the TV needs, and what a frame grab sends at most. */
export const CAPTURE_MAX_WIDTH = 1920;
export const CAPTURE_MAX_HEIGHT = 1080;
export const CAPTURE_IDEAL_FPS = 15;
export const CAPTURE_MAX_FPS = 30;

/** The getDisplayMedia request. No `min`/`exact` (they reject before the picker) and no `displaySurface` hint. */
export function displayOptions(controller?: FocusController): DisplayOptions {
  return {
    video: {
      width: { ideal: CAPTURE_MAX_WIDTH, max: CAPTURE_MAX_WIDTH },
      height: { ideal: CAPTURE_MAX_HEIGHT, max: CAPTURE_MAX_HEIGHT },
      frameRate: { ideal: CAPTURE_IDEAL_FPS, max: CAPTURE_MAX_FPS },
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    systemAudio: 'exclude',
    windowAudio: 'exclude',
    ...(controller ? { controller } : {}),
  };
}

export interface MediaDevicesLike {
  getDisplayMedia(o: DisplayOptions): Promise<MediaStream>;
}

export interface CaptureEnv {
  /** `navigator.mediaDevices`, or null where there is none (an insecure context, an old browser). */
  media: MediaDevicesLike | null;
  /** `window.CaptureController`, where it exists. */
  Controller?: (new () => FocusController) | undefined;
}

/** The browser's own, where it has them. */
export function browserCapture(): CaptureEnv {
  const md = typeof navigator !== 'undefined' ? (navigator.mediaDevices as MediaDevicesLike | undefined) : undefined;
  const Controller = typeof window !== 'undefined' ? (window as unknown as { CaptureController?: new () => FocusController }).CaptureController : undefined;
  return { media: md && typeof md.getDisplayMedia === 'function' ? md : null, Controller };
}

/**
 * Calls getDisplayMedia at once: it must run inside the click's user activation, before any other await. A fresh
 * controller per capture; its focus behaviour is set before the call (afterwards it can miss its window or throw).
 */
export function requestDisplay(env: CaptureEnv): Promise<MediaStream> {
  if (!env.media) return Promise.reject(new DOMException('getDisplayMedia is not available', 'NotSupportedError'));
  let controller: FocusController | undefined;
  if (env.Controller) {
    try {
      controller = new env.Controller();
      controller.setFocusBehavior('no-focus-change');
    } catch {
      controller = undefined; // an older Chrome: focus moves to the shared tab or window, as it always did
    }
  }
  return env.media.getDisplayMedia(displayOptions(controller));
}

/** A display surface as the protocol names it, or undefined. */
export function surfaceOf(track: Pick<MediaStreamTrack, 'getSettings'> | null | undefined): DisplaySurface | undefined {
  const s = (track?.getSettings?.() as { displaySurface?: unknown } | undefined)?.displaySurface;
  return typeof s === 'string' && (DISPLAY_SURFACES as readonly string[]).includes(s) ? (s as DisplaySurface) : undefined;
}

/** What the share is, in the words the top bar uses. */
export const SURFACE_WORD: Record<DisplaySurface, string> = { browser: 'a tab', window: 'a window', monitor: 'your screen' };

/** The macOS setting that gates window and screen capture (older macOS: "Screen Recording"). */
export const MAC_SETTINGS = 'System Settings → Privacy & Security → Screen & System Audio Recording';

export type CaptureFailure =
  /** The picker was cancelled (or closed): nothing is said. */
  | { kind: 'cancelled' }
  | { kind: 'os_denied' | 'not_found' | 'not_readable' | 'needs_click' | 'unsupported' | 'failed'; message: string };

/**
 * Sorts a getDisplayMedia rejection. Browsers have no reliably distinct error for a cancelled picker and a denial
 * by macOS (both are NotAllowedError), so: Chrome's own message for the OS case ("Permission denied by system", not
 * localised), or a NotAllowedError on a Mac that came back faster than a person can open and cancel a picker, is
 * taken as the OS; any other NotAllowedError is a cancel and says nothing. `elapsedMs` is the time since the call.
 */
export function classifyCaptureError(err: unknown, o: { mac: boolean; elapsedMs: number }): CaptureFailure {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '';
  const macHelp = `macOS has not allowed Chrome to record the screen. Open ${MAC_SETTINGS}, turn on Google Chrome, relaunch Chrome if it asks, then press Share screen again.`;
  switch (name) {
    case 'NotAllowedError':
      if (/by system/i.test(msg) || (o.mac && o.elapsedMs < FAST_DENIAL_MS)) return { kind: 'os_denied', message: macHelp };
      return { kind: 'cancelled' };
    case 'NotFoundError':
      return { kind: 'not_found', message: 'There is no screen or window to share.' };
    case 'NotReadableError':
      return {
        kind: 'not_readable',
        message: o.mac ? `That source could not be captured. If macOS asked, allow Chrome in ${MAC_SETTINGS}; otherwise try a tab or another window.` : 'That source could not be captured: try a tab or another window.',
      };
    case 'InvalidStateError':
      return { kind: 'needs_click', message: 'Screen sharing needs a click in this window: press Share screen again.' };
    case 'NotSupportedError':
    case 'TypeError':
      return { kind: 'unsupported', message: 'This browser cannot share a screen here. Use Chrome on the Mac.' };
  }
  return { kind: 'failed', message: "Screen sharing wasn't started. Press Share screen to try again." };
}

/** Faster than a person can see a picker and cancel it: the OS (or a policy) said no. */
export const FAST_DENIAL_MS = 250;
