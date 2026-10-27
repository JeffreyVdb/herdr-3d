// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fullscreenChip } from '../laptop/fullscreen';
import { SeatBar } from './seat';
import { ViewPrefs } from './themePrefs';

const noop = { text() {}, paste() {}, stand() {}, toggle() {} };

describe('seat bar: the terminal’s preset and zoom (#59)', () => {
  it('a radio group of the two presets and A− / level / A+, for the terminal only', () => {
    const hud = document.createElement('div');
    const prefs = new ViewPrefs(null);
    const bar = new SeatBar(hud, noop, prefs);
    const group = hud.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Terminal theme');
    const radios = [...hud.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked'), r.tabIndex])).toEqual([
      ['Ubuntu', 'false', -1],
      ['Quiet', 'true', 0],
    ]);
    radios[0]!.click();
    expect([prefs.theme('terminal'), prefs.theme('transcript')]).toEqual(['ubuntu', 'quiet']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    // Arrows move and pick, and stay out of the game and the pane.
    let reached = 0;
    hud.addEventListener('keydown', () => reached++);
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(prefs.theme('terminal')).toBe('quiet');
    expect(reached).toBe(0);
    // The zoom: its level always shown, steps of 10, reset on the middle one; the transcript's zoom stays.
    const zoom = hud.querySelector('[aria-label="Terminal text size"]') as HTMLElement;
    const [out, level, inc] = [...zoom.querySelectorAll<HTMLButtonElement>('button')];
    expect(level!.textContent).toBe('100%');
    inc!.click();
    inc!.click();
    expect(level!.textContent).toBe('120%');
    expect(bar.summary().terminalZoom).toBe('120%');
    level!.click();
    for (let i = 0; i < 9; i++) out!.click();
    expect(prefs.zoom('terminal')).toBe(70);
    expect(out!.disabled).toBe(true);
    expect(prefs.zoom('transcript')).toBe(100);
    // Set elsewhere (the keys), shown here.
    prefs.setZoom('terminal', 150);
    expect(level!.textContent).toBe('150%');
    // Its controls own their keys; the hidden keyboard for the pane does not count as one.
    expect(bar.owns(radios[0]!)).toBe(true);
    expect(bar.owns(bar.input)).toBe(false);
    expect(bar.owns(document.body)).toBe(false);
  });

  it('Ctrl+, lands on the picked preset (the label says so); Esc from the controls hands the keyboard back', () => {
    const hud = document.createElement('div');
    document.body.append(hud);
    const prefs = new ViewPrefs(null);
    prefs.setTheme('terminal', 'ubuntu');
    const bar = new SeatBar(hud, noop, prefs);
    bar.show('Tofu', false);
    bar.focus();
    const label = hud.querySelector('.seat-look-label') as HTMLElement;
    expect([...label.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', ',']);
    const group = hud.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-keyshortcuts')).toBe('Control+,');
    expect(bar.focusLook()).toBe(true);
    const ubuntu = hud.querySelector('[data-theme-id="ubuntu"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(ubuntu);
    expect(bar.inLook(ubuntu)).toBe(true);
    expect(bar.inLook(hud.querySelector('.seat-stand'))).toBe(false);
    expect(bar.inLook(bar.input)).toBe(false);
    // Back to the pane's keyboard.
    bar.focus();
    expect(document.activeElement).toBe(bar.input);
    hud.remove();
  });

  it('without prefs (an older host), no controls', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    expect(hud.querySelector('.seat-look')).toBeNull();
    expect(bar.focusLook()).toBe(false);
  });
});

describe('seat bar: the fullscreen chip (#74)', () => {
  const chipOf = (hud: HTMLElement) => hud.querySelector<HTMLButtonElement>('.seat-fs')!;

  it('is hidden until there is something to say, then states the fact and is a toggle', () => {
    const hud = document.createElement('div');
    const asked: string[] = [];
    const bar = new SeatBar(hud, { ...noop, fullscreen: (a: string) => asked.push(a) }, new ViewPrefs(null));
    const chip = chipOf(hud);
    expect(chip.hidden).toBe(true);
    expect(bar.summary().fullscreen).toBeNull();

    bar.setFullscreen(fullscreenChip({ state: 'split', applied: false }, { cols: 60, rows: 40 }));
    expect(chip.hidden).toBe(false);
    expect(bar.summary().fullscreen).toEqual({ label: 'Zoom herdr tab (split 60×40)', pressed: false, unavailable: false });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.getAttribute('aria-label')).toBe('Zoom herdr tab, off. Split pane 60 by 40');
    chip.click();

    bar.setFullscreen(fullscreenChip({ state: 'zoomed', applied: true }, { cols: 131, rows: 47 }));
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(bar.summary().fullscreen?.label).toBe('herdr tab zoomed');
    chip.click();
    expect(asked).toEqual(['zoom', 'unzoom']);

    // A zoom that could not widen the pane: its words stay, it does nothing and is marked aria-disabled, still focusable.
    bar.setFullscreen(fullscreenChip({ state: 'zoomed', applied: true, headless: true }, { cols: 120, rows: 40 }));
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.disabled).toBe(false);
    expect(bar.summary().fullscreen).toEqual({ label: 'Zoom unavailable', pressed: false, unavailable: true });
    chip.click();
    expect(asked).toHaveLength(2);

    bar.setFullscreen(null);
    expect(chip.hidden).toBe(true);
  });

  it('is one of the bar’s controls: it owns its keys, and Ctrl+, reaches the controls it sits with', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop, new ViewPrefs(null));
    bar.setFullscreen(fullscreenChip({ state: 'split', applied: false }, { cols: 60, rows: 40 }));
    const chip = chipOf(hud);
    expect(bar.owns(chip)).toBe(true);
    expect(bar.inLook(chip)).toBe(true);
    // After the swatches and the zoom, in Tab order.
    const order = [...hud.querySelectorAll('.seat-look button')];
    expect(order.at(-1)).toBe(chip);
  });
});


describe('seat bar: the worker’s own Codex server (#155)', () => {
  it('a line in the question’s place that says what to do, gone when there is nothing to say', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    const line = hud.querySelector('.seat-codex') as HTMLElement;
    const seat = hud.querySelector('.seat') as HTMLElement;
    expect(line.hidden).toBe(true);
    bar.codexNote({ tone: 'down', text: 'Its Codex server stopped: the terminal is waiting to reconnect.' });
    expect(line.hidden).toBe(false);
    expect(seat.hasAttribute('data-codex')).toBe(true);
    expect(line.dataset.tone).toBe('down');
    expect(line.textContent).toBe('Codex serverIts Codex server stopped: the terminal is waiting to reconnect.');
    expect(line.getAttribute('role')).toBe('status');
    bar.codexNote(null);
    expect(line.hidden).toBe(true);
    expect(seat.hasAttribute('data-codex')).toBe(false);
  });
});

describe('seat bar: the worker’s Codex profile (#139)', () => {
  it('a line under the server’s, by its name; the bar keeps its notice row while either shows', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    const seat = hud.querySelector('.seat') as HTMLElement;
    const profile = hud.querySelector('.seat-profile') as HTMLElement;
    const server = hud.querySelector('.seat-codex') as HTMLElement;
    expect(profile.hidden).toBe(true);
    bar.profileNote({ tone: 'note', text: 'Work seat' });
    expect(profile.hidden).toBe(false);
    expect(profile.textContent).toBe('Codex profileWork seat');
    expect(profile.dataset.tone).toBe('note');
    expect(profile.getAttribute('role')).toBe('status');
    expect(seat.hasAttribute('data-codex')).toBe(true);
    bar.codexNote({ tone: 'down', text: 'Its Codex server stopped.' });
    expect(server.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    bar.codexNote(null);
    expect(seat.hasAttribute('data-codex')).toBe(true); // the profile line still shows
    bar.profileNote({ tone: 'down', text: 'Work seat. Asked for Work seat, the server signed in to another account.' });
    expect(profile.dataset.tone).toBe('down');
    bar.profileNote(null);
    expect(profile.hidden).toBe(true);
    expect(seat.hasAttribute('data-codex')).toBe(false);
  });
});

describe('the seated workspace (#176)', () => {
  const setup = (extra: Record<string, unknown> = {}) => {
    document.body.replaceChildren();
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div'); // a body-level overlay (the overview): never made inert by the seat
    const hud = document.createElement('div');
    const topbar = document.createElement('button');
    topbar.textContent = 'Menu';
    const toast = document.createElement('div');
    toast.className = 'toast';
    const plate = document.createElement('aside');
    plate.setAttribute('popover', 'manual');
    hud.append(topbar, toast, plate);
    const dialog = document.createElement('dialog');
    document.body.append(canvas, hud, overlay, dialog);
    const calls: string[] = [];
    const bar = new SeatBar(hud, { ...noop, mode: (m: string) => calls.push(`mode ${m}`), live: () => calls.push('live'), ...extra }, new ViewPrefs(null));
    return { bar, hud, canvas, overlay, topbar, toast, plate, dialog, calls };
  };

  it('the read-only terminal has its own arrows (they scroll it); the owned one gives every key to the pane', () => {
    const { bar } = setup();
    expect(bar.owns(bar.termHost)).toBe(false);
    bar.termHost.setAttribute('data-readonly', '');
    expect(bar.owns(bar.termHost)).toBe(true);
    const cell = document.createElement('div');
    bar.termHost.append(cell);
    expect(bar.owns(cell)).toBe(false); // xterm's own parts: a press there gives the keyboard back to the seat
  });

  it('covers the game: what is behind it is inert (never the toasts, a popover or a dialog), and the focus goes back after', () => {
    const { bar, canvas, overlay, topbar, toast, plate, dialog } = setup();
    topbar.focus();
    bar.show('Tofu', false);
    bar.focus();
    expect(bar.summary().shown).toBe(true);
    // (jsdom does not reflect `inert` until it is set: !! reads it.)
    expect([canvas.inert, topbar.inert]).toEqual([true, true]);
    expect([toast, plate, dialog, overlay, bar.el].map((e) => !!e.inert)).toEqual([false, false, false, false, false]);
    expect(document.activeElement).toBe(bar.input);
    bar.hide();
    expect(bar.summary().shown).toBe(false);
    expect([!!canvas.inert, !!topbar.inert]).toEqual([false, false]);
    expect(document.activeElement).toBe(topbar);
    // The element the workspace grows in holds the terminal's host and the content.
    expect(bar.content.contains(bar.termHost)).toBe(true);
  });

  it('#216: the rail is a vertical tab list of the four views, the one up selected; a pick goes to the host', () => {
    const { bar, hud, calls } = setup();
    bar.show('Tofu', false);
    const list = hud.querySelector<HTMLElement>('.seat-rail [role="tablist"]')!;
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((b) => [b.textContent, b.getAttribute('aria-selected'), b.tabIndex])).toEqual([
      ['Terminal', 'true', 0],
      ['Chat', 'false', -1],
      ['Images', 'false', -1],
      ['Runs', 'false', -1],
    ]);
    expect(tabs.map((b) => b.getAttribute('aria-keyshortcuts'))).toEqual(['Control+Shift+1', 'Control+Shift+2', 'Control+Shift+3', 'Control+Shift+4']);
    tabs[1]!.click();
    tabs[2]!.click();
    tabs[3]!.click();
    tabs[0]!.click(); // the one up: nothing to do
    expect(calls).toEqual(['mode transcript', 'mode images', 'mode runs']);
    bar.setMode('runs');
    expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'true']);
    expect(bar.content.dataset.mode).toBe('runs');
    // ↓ moves along the list (roving: one tab stop), wrapping; the move picks nothing.
    tabs[3]!.focus();
    tabs[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(calls).toHaveLength(3);
    // The counts are in the tabs' names; Runs says what waits before what runs.
    bar.railCounts({ chat: 2, images: 5, runs: { waiting: 1, running: 3 } });
    expect(bar.summary().rail).toEqual(['Terminal', 'Chat, 2 waiting for you', 'Images, 5 images', 'Runs, 1 waiting for you']);
    expect(hud.querySelector('.seat-rail-view[data-mode="runs"] .seat-rail-badge')!.hasAttribute('data-warn')).toBe(true);
    bar.railCounts({ chat: 0, images: null, runs: { waiting: 0, running: 3 } });
    expect(bar.summary().rail).toEqual(['Terminal', 'Chat', 'Images', 'Runs, 3 running']);
    expect(hud.querySelector<HTMLElement>('.seat-rail-view[data-mode="transcript"] .seat-rail-badge')!.hidden).toBe(true);
  });

  it('the worker’s status, the read-only line and the history indicator; Back to live goes to the host', () => {
    const { bar, hud, calls } = setup();
    bar.show('Tofu', false);
    bar.workerStatus('needs_you');
    expect(bar.summary().status).toBe('Needs you');
    bar.workerStatus(null);
    expect(bar.summary().status).toBeNull();
    bar.readOnly({ text: 'Another client controls this terminal' });
    expect(bar.summary().readOnly).toContain('Another client controls this terminal');
    expect(bar.el.hasAttribute('data-readonly')).toBe(true);
    bar.readOnly(null);
    expect(bar.summary().readOnly).toBeNull();
    bar.history({ offset: 0, max: 80 });
    expect(bar.summary().history).toBeNull();
    bar.history({ offset: 1, max: 80 });
    expect(bar.summary().history).toContain('1 line up');
    bar.history({ offset: 42, max: 80 });
    const pill = hud.querySelector<HTMLButtonElement>('.seat-history')!;
    expect(pill.getAttribute('aria-label')).toBe('42 lines up in the history. Back to live');
    pill.click();
    expect(calls).toEqual(['live']);
    // Sitting again starts clean.
    bar.hide();
    bar.show('Mochi', false);
    expect([bar.summary().history, bar.summary().readOnly]).toEqual([null, null]);
  });

  it('a copy event while seated takes the terminal’s selection; without one it is the browser’s', () => {
    let selection = 'ls -la';
    const { bar } = setup({ selection: () => selection });
    bar.show('Tofu', false);
    const copy = () => {
      const data = new Map<string, string>();
      const e = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: { setData(t: string, v: string): void } };
      Object.defineProperty(e, 'clipboardData', { value: { setData: (t: string, v: string) => data.set(t, v) } });
      bar.input.dispatchEvent(e);
      return { prevented: e.defaultPrevented, text: data.get('text/plain') ?? null };
    };
    expect(copy()).toEqual({ prevented: true, text: 'ls -la' });
    selection = '';
    expect(copy()).toEqual({ prevented: false, text: null });
  });
});

describe('seat bar: #213 command suggestion and runs asking for you', () => {
  it('"Command to review" shows while the card is out of sight; one press reveals it', () => {
    const hud = document.createElement('div');
    const asked: HTMLElement[] = [];
    const bar = new SeatBar(hud, { ...noop, review: (from) => void asked.push(from) });
    const b = hud.querySelector<HTMLButtonElement>('.seat-cmdreq')!;
    expect(b.hidden).toBe(true);
    bar.commandRequest(1);
    expect([b.hidden, b.textContent]).toEqual([false, 'Command to review']);
    expect(b.getAttribute('aria-label')).toBe('Command to review: the agent suggests a command to run. Show the suggestion');
    expect(b.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    b.click();
    expect(asked).toEqual([b]);
    bar.commandRequest(2);
    expect(b.textContent).toBe('2 commands to review');
    bar.commandRequest(0);
    expect(b.hidden).toBe(true);
  });
  it('the notices row holds the chips while a run asks; the process control carries the mark and says so', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, { ...noop, processes: () => {} });
    const others = document.createElement('div');
    bar.mountAttention(others); // #216: after the needs-you line (this worker's runs)
    bar.manualProcesses(2, true);
    const seat = hud.querySelector<HTMLElement>('.seat')!;
    const proc = hud.querySelector<HTMLButtonElement>('.seat-processes')!;
    expect(hud.querySelector('.seat-notes .seat-attn')!.children).toEqual(expect.objectContaining({ length: 2 }));
    expect(seat.hasAttribute('data-attn')).toBe(false);
    bar.attention(1, 0);
    expect([seat.hasAttribute('data-attn'), proc.hasAttribute('data-attn')]).toEqual([true, true]);
    expect(proc.getAttribute('aria-label')).toBe('2 manual processes, 1 asking for you: open list');
    bar.attention(0, 2);
    expect([seat.hasAttribute('data-attn'), proc.hasAttribute('data-attn')]).toEqual([true, false]);
    expect(proc.getAttribute('aria-label')).toBe('2 manual processes: open list');
    bar.attention(0, 0);
    expect(seat.hasAttribute('data-attn')).toBe(false);
  });
});
