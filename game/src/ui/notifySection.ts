import type { GameAudio } from '../audio';
import type { InboxPrefs, InboxSettings } from './inboxPrefs';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the Notifications section needs: the inbox's settings, and the sound to test the chime with. */
export interface NotifySectionHost {
  prefs: InboxPrefs;
  audio: Pick<GameAudio, 'playUi' | 'unlock' | 'muted' | 'onChange'>;
}

/** The browser's word on desktop notifications, plus `unsupported` (no Notification API on this page). */
export type NotifyPermission = NotificationPermission | 'unsupported';

/** The Notification API, when this page has one (it needs a secure context: HTTPS or localhost). */
function api(): typeof Notification | null {
  const n = (globalThis as { Notification?: typeof Notification }).Notification;
  return typeof n === 'function' ? n : null;
}

export function notifyPermission(): NotifyPermission {
  try {
    return api()?.permission ?? 'unsupported';
  } catch {
    return 'unsupported';
  }
}

const PERMISSION: Record<NotifyPermission, { badge: string; state: string; hint: string }> = {
  granted: { badge: 'Allowed', state: 'ready', hint: 'This browser shows them while the game is in the background.' },
  default: { badge: 'Not asked', state: 'incomplete', hint: 'The browser has not been asked yet. Allow… asks it.' },
  denied: {
    badge: 'Blocked',
    state: 'invalid',
    hint: 'Blocked in this browser. To unblock in Chrome: click the icon left of the address, open Site settings, set Notifications to Allow, then reload.',
  },
  unsupported: { badge: 'Unavailable', state: 'off', hint: 'This page can’t show desktop notifications: it needs HTTPS or localhost, and a browser that has them.' },
};

let serial = 0;

/**
 * #100: Settings → Notifications: how the inbox reaches you beyond its chip. Desktop notifications (the switch,
 * and the browser's permission with Allow… to ask for it), the chime (switch, its own volume under the master,
 * Test), which entries ping (needs you, finished) and whether freelancers that finish count. All in this
 * browser's `h3d.inbox`; the permission is re-read whenever the dialog opens (it changes in the browser's own UI).
 */
export function notifySection(host: NotifySectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const { prefs, audio } = host;
    const id = `settings-nt-${++serial}`;
    const lede = el('p', 'settings-lede', 'When an agent needs you or finishes, it joins the inbox. These say how you hear about it while you look elsewhere.');

    const toggle = (key: keyof InboxSettings, text: string, cls = 'settings-switch') => {
      const box = el('input');
      box.type = 'checkbox';
      box.id = `${id}-${key}`;
      box.addEventListener('change', () => prefs.set({ [key]: box.checked }));
      const label = el('label', cls);
      label.htmlFor = box.id;
      label.append(box, el('span', '', text));
      return { box, label };
    };

    // Desktop notifications: the switch, the browser's permission beside it, and how to get it.
    const desktop = toggle('desktop', 'Desktop notifications');
    const badge = el('span', 'settings-badge');
    const desktopHead = el('div', 'settings-nt-head');
    desktopHead.append(desktop.label, badge);
    const permHint = el('p', 'settings-field-hint');
    permHint.id = `${id}-perm`;
    desktop.box.setAttribute('aria-describedby', permHint.id);
    const allow = el('button', 'btn btn--sm', 'Allow…');
    allow.type = 'button';
    allow.setAttribute('aria-describedby', permHint.id);
    const desktopBlock = el('div', 'settings-nt-block');
    desktopBlock.append(desktopHead, permHint, allow);

    // The chime: the switch, its volume and Test on one row.
    const chime = toggle('chime', 'Chime');
    const vol = el('input');
    vol.type = 'range';
    vol.className = 'settings-nt-volume';
    vol.id = `${id}-vol`;
    vol.min = '0';
    vol.max = '100';
    vol.step = '5';
    vol.setAttribute('aria-label', 'Chime volume');
    const volLabel = el('label', 'settings-field-label', 'Volume');
    volLabel.htmlFor = vol.id;
    const volOut = el('output', 'settings-nt-figure');
    volOut.htmlFor.add(vol.id);
    const test = el('button', 'btn btn--sm', 'Test');
    test.type = 'button';
    const volRow = el('div', 'settings-nt-row');
    volRow.append(vol, volOut, test);
    const volField = el('div', 'settings-field');
    volField.append(volLabel, volRow);
    const mutedHint = el('p', 'settings-field-hint', 'Sound is muted in the top bar: the chime stays silent until you unmute.');
    mutedHint.id = `${id}-muted`;
    test.setAttribute('aria-describedby', mutedHint.id);
    const chimeBlock = el('div', 'settings-nt-block');
    chimeBlock.append(chime.label, volField, mutedHint);

    // Which entries ping, for both of the above.
    // A group, not a fieldset: panels.css styles the floor settings' fieldsets under the same `.settings` class.
    const on = el('div', 'settings-nt-on');
    on.setAttribute('role', 'group');
    const legend = el('p', 'settings-field-label', 'Notify when an agent');
    legend.id = `${id}-on`;
    on.setAttribute('aria-labelledby', legend.id);
    const needs = toggle('onNeeds', 'Needs you', 'settings-check');
    const finished = toggle('onFinished', 'Finished', 'settings-check');
    const checks = el('div', 'settings-nt-checks');
    checks.append(needs.label, finished.label);
    const silentHint = el('p', 'settings-field-hint', 'Neither: they still join the inbox, but nothing pings.');
    on.append(legend, checks, silentHint);
    const free = toggle('freelancers', 'Include freelancers when they finish');
    const freeHint = el('p', 'settings-field-hint', 'Off: a write-code run’s coders and reviewers come and go all the time. They are always in the inbox when they need you.');
    freeHint.id = `${id}-free-hint`;
    free.box.setAttribute('aria-describedby', freeHint.id);
    const freeBlock = el('div', 'settings-nt-block');
    freeBlock.append(free.label, freeHint);

    const root = el('div', 'settings-nt');
    root.append(desktopBlock, chimeBlock, on, freeBlock);
    body.append(lede, root);

    let permission: NotifyPermission = notifyPermission();
    let asking = false;

    function sync(): void {
      const s = prefs.settings;
      desktop.box.checked = s.desktop;
      const p = PERMISSION[permission];
      badge.textContent = p.badge;
      badge.dataset.state = p.state;
      permHint.textContent = p.hint;
      allow.hidden = permission !== 'default';
      allow.disabled = asking;
      chime.box.checked = s.chime;
      const pct = Math.round(s.chimeVolume * 100);
      if (vol.value !== String(pct)) vol.value = String(pct);
      vol.style.setProperty('--fill', `${pct}%`);
      volOut.value = `${pct}%`;
      mutedHint.hidden = !audio.muted;
      needs.box.checked = s.onNeeds;
      finished.box.checked = s.onFinished;
      free.box.checked = s.freelancers;
      // Nothing pings without a kind to ping for: say so where the switches are.
      silentHint.hidden = s.onNeeds || s.onFinished;
    }

    allow.addEventListener('click', () => {
      const N = api();
      if (!N) return;
      asking = true;
      sync();
      // From the click itself: Chrome asks only inside a user gesture.
      let ask: Promise<NotificationPermission>;
      try {
        ask = Promise.resolve(N.requestPermission());
      } catch {
        ask = Promise.resolve(notifyPermission() as NotificationPermission);
      }
      void ask
        .catch(() => notifyPermission() as NotificationPermission)
        .then((r) => {
          asking = false;
          permission = r ?? notifyPermission();
          // Allowed from here: that is what the switch is for.
          if (permission === 'granted' && !prefs.settings.desktop) prefs.set({ desktop: true });
          sync();
        });
    });

    vol.addEventListener('input', () => prefs.set({ chimeVolume: Number(vol.value) / 100 }));
    test.addEventListener('click', () => {
      // The click is a gesture: unlock first, so even a page that never had a click before can sound.
      void audio.unlock().then(() => audio.playUi('needs', prefs.settings.chimeVolume));
    });

    const offPrefs = prefs.onChange(sync);
    const offAudio = audio.onChange(sync);
    sync();
    return {
      open() {
        permission = notifyPermission();
        sync();
      },
      dispose() {
        offPrefs();
        offAudio();
      },
    };
  };
}
