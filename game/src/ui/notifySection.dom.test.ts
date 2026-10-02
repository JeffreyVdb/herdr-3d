// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiSound } from '../audio';
import { InboxPrefs } from './inboxPrefs';
import { notifySection } from './notifySection';

/** A Notification API whose permission the test sets, and whose prompt answers `answer`. */
function stubNotification(permission: NotificationPermission, answer: NotificationPermission | 'throw' = 'granted') {
  const N = Object.assign(function Notification() {}, {
    permission,
    asked: 0,
    requestPermission: () => {
      N.asked++;
      if (answer === 'throw') return Promise.reject(new Error('NotAllowedError'));
      N.permission = answer;
      return Promise.resolve(answer);
    },
  });
  vi.stubGlobal('Notification', N);
  return N;
}

function mount(o: { muted?: boolean } = {}) {
  document.body.replaceChildren();
  const prefs = new InboxPrefs(null);
  const played: Array<{ sound: UiSound; volume: number | undefined }> = [];
  const audioListeners = new Set<() => void>();
  const audio = {
    muted: o.muted ?? false,
    unlocks: 0,
    unlock: async () => void audio.unlocks++,
    playUi: (sound: UiSound, volume?: number) => void played.push({ sound, volume }),
    onChange: (fn: () => void) => (audioListeners.add(fn), () => audioListeners.delete(fn)),
  };
  const body = document.createElement('div');
  document.body.append(body);
  const handle = notifySection({ prefs, audio })(body);
  handle.open?.();
  const box = (label: string) => [...body.querySelectorAll('label')].find((l) => l.textContent === label)!.querySelector('input')!;
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const badge = () => body.querySelector<HTMLElement>('.settings-nt-head .settings-badge')!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const audioChanged = () => audioListeners.forEach((f) => f());
  return { prefs, audio, played, body, handle, box, button, badge, flush, audioChanged };
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Notifications (#100)', () => {
  it('shows the defaults: desktop and chime on at 60 %, both kinds, no freelancers', () => {
    stubNotification('granted');
    const m = mount();
    expect(m.box('Desktop notifications').checked).toBe(true);
    expect(m.box('Chime').checked).toBe(true);
    expect(m.body.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe('60');
    expect(m.body.querySelector('output')!.textContent).toBe('60%');
    expect(m.box('Needs you').checked).toBe(true);
    expect(m.box('Finished').checked).toBe(true);
    expect(m.box('Include freelancers when they finish').checked).toBe(false);
  });

  it('says what the browser allows: allowed, not asked (with Allow…), blocked (how to unblock), unavailable', () => {
    stubNotification('granted');
    let m = mount();
    expect(m.badge().textContent).toBe('Allowed');
    expect(m.button('Allow…').hidden).toBe(true);

    stubNotification('default');
    m = mount();
    expect(m.badge().textContent).toBe('Not asked');
    expect(m.button('Allow…').hidden).toBe(false);

    stubNotification('denied');
    m = mount();
    expect(m.badge().textContent).toBe('Blocked');
    expect(m.badge().dataset.state).toBe('invalid');
    expect(m.body.textContent).toContain('Site settings');
    expect(m.button('Allow…').hidden).toBe(true);

    vi.stubGlobal('Notification', undefined);
    m = mount();
    expect(m.badge().textContent).toBe('Unavailable');
    expect(m.body.textContent).toContain('HTTPS or localhost');
    expect(m.button('Allow…').hidden).toBe(true);
  });

  it('Allow… asks the browser on the click and shows the answer; allowed switches desktop on', async () => {
    const N = stubNotification('default', 'granted');
    const m = mount();
    m.prefs.set({ desktop: false });
    m.button('Allow…').click();
    expect(N.asked).toBe(1);
    expect(m.button('Allow…').disabled).toBe(true);
    await m.flush();
    expect(m.badge().textContent).toBe('Allowed');
    expect(m.button('Allow…').hidden).toBe(true);
    expect(m.prefs.settings.desktop).toBe(true);
  });

  it('a refused or failed prompt shows what the browser says now, and leaves the switch alone', async () => {
    stubNotification('default', 'denied');
    let m = mount();
    m.button('Allow…').click();
    await m.flush();
    expect(m.badge().textContent).toBe('Blocked');
    expect(m.prefs.settings.desktop).toBe(true);

    stubNotification('default', 'throw');
    m = mount();
    m.prefs.set({ desktop: false });
    m.button('Allow…').click();
    await m.flush();
    expect(m.badge().textContent).toBe('Not asked');
    expect(m.button('Allow…').disabled).toBe(false);
    expect(m.prefs.settings.desktop).toBe(false);
  });

  it('re-reads the permission when the dialog opens (it changes in the browser’s own settings)', () => {
    const N = stubNotification('denied');
    const m = mount();
    expect(m.badge().textContent).toBe('Blocked');
    N.permission = 'granted';
    m.handle.open?.();
    expect(m.badge().textContent).toBe('Allowed');
  });

  it('the switches, the boxes and the slider write the prefs, and follow them when they change elsewhere', () => {
    stubNotification('granted');
    const m = mount();
    for (const [label, key] of [
      ['Desktop notifications', 'desktop'],
      ['Chime', 'chime'],
      ['Needs you', 'onNeeds'],
      ['Finished', 'onFinished'],
      ['Include freelancers when they finish', 'freelancers'],
    ] as const) {
      const b = m.box(label);
      const was = m.prefs.settings[key];
      b.click();
      expect(m.prefs.settings[key], label).toBe(!was);
    }
    const vol = m.body.querySelector<HTMLInputElement>('input[type="range"]')!;
    vol.value = '25';
    vol.dispatchEvent(new Event('input'));
    expect(m.prefs.settings.chimeVolume).toBe(0.25);
    expect(m.body.querySelector('output')!.textContent).toBe('25%');

    m.prefs.set({ chime: true, chimeVolume: 0.9 });
    expect(m.box('Chime').checked).toBe(true);
    expect(vol.value).toBe('90');
  });

  it('says when nothing will ping (neither kind on)', () => {
    stubNotification('granted');
    const m = mount();
    const hint = [...m.body.querySelectorAll<HTMLElement>('.settings-nt-on .settings-field-hint')][0]!;
    expect(hint.hidden).toBe(true);
    m.prefs.set({ onNeeds: false, onFinished: false });
    expect(hint.hidden).toBe(false);
  });

  it('Test unlocks the sound and plays the needs chime at the chime’s volume', async () => {
    stubNotification('granted');
    const m = mount();
    m.prefs.set({ chimeVolume: 0.4 });
    m.button('Test').click();
    await m.flush();
    expect(m.audio.unlocks).toBe(1);
    expect(m.played).toEqual([{ sound: 'needs', volume: 0.4 }]);
  });

  it('says the master mute silences the chime, live', () => {
    stubNotification('granted');
    const m = mount();
    const hint = m.body.querySelector<HTMLElement>('[id$="-muted"]')!;
    expect(hint.hidden).toBe(true);
    m.audio.muted = true;
    m.audioChanged();
    expect(hint.hidden).toBe(false);
  });

  it('drops its listeners on dispose', () => {
    stubNotification('granted');
    const m = mount();
    m.handle.dispose?.();
    m.prefs.set({ chime: false });
    expect(m.box('Chime').checked).toBe(true);
  });
});
