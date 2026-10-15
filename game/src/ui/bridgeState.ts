import type { BridgeEntry } from '../net/bridges';
import './bridges.css';

/** #57: a bridge's state as Settings → Bridges and ⌘P → Switch bridge show it. */

/** A bridge's state in words: what the dot means, and what went wrong when it is not up. */
export function bridgeStateText(b: Pick<BridgeEntry, 'state' | 'last_error'>): { text: string; tone: 'up' | 'wait' | 'down' } {
  switch (b.state) {
    case 'up':
      return { text: 'Online', tone: 'up' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'wait' };
    case 'degraded':
      return { text: 'Not answering', tone: 'wait' };
    case 'backoff':
      return { text: 'Offline, retrying', tone: 'down' };
    case 'stopped':
      return { text: 'Stopped', tone: 'down' };
    default:
      return { text: 'Offline', tone: 'down' };
  }
}

/** The state dot: a filled circle in the state's colour (the connection chip's); the row says the state in words. */
export function bridgeDot(b: Pick<BridgeEntry, 'state' | 'last_error'>): HTMLElement {
  const s = bridgeStateText(b);
  const dot = document.createElement('span');
  dot.className = 'br-dot';
  dot.dataset.tone = s.tone;
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}
