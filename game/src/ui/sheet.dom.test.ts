// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet, type SheetCloseReason, type SheetOptions } from './sheet';

let shown: ReturnType<typeof vi.fn<(d: HTMLDialogElement) => void>>;
beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the code looks at, and close fires `close` as a browser does.
  shown = vi.fn();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    shown(this);
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function make(o: Partial<SheetOptions> = {}): { sheet: Sheet; closes: SheetCloseReason[] } {
  const closes: SheetCloseReason[] = [];
  const sheet = new Sheet({ label: 'Questions', onClose: (why) => closes.push(why), ...o });
  return { sheet, closes };
}

/** jsdom has no layout: the dialog's box is 100..500 x 50..350; a point outside it is the backdrop. */
function boxed(sheet: Sheet): void {
  sheet.el.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300, x: 100, y: 50, toJSON: () => ({}) });
}
function press(target: Element, x: number, y: number): void {
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(down, 'isPrimary', { value: true });
  target.dispatchEvent(down);
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

describe('Sheet (#187)', () => {
  it('opens as a modal dialog on the body, once however often it is asked', () => {
    const host = document.createElement('div');
    host.className = 'tx';
    document.body.append(host);
    const { sheet } = make({ className: 'tx-qsheet' });
    expect(sheet.el.isConnected).toBe(false);
    sheet.open();
    sheet.open();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(sheet.el.parentElement).toBe(document.body);
    expect(sheet.isOpen).toBe(true);
    expect(sheet.el.classList).toContain('sheet');
    expect(sheet.el.classList).toContain('tx-qsheet');
    expect(sheet.el.id).toMatch(/^sheet-\d+$/);
    expect(sheet.header.contains(sheet.el.querySelector('.sheet-close'))).toBe(true);
    expect(sheet.el.contains(sheet.body)).toBe(true);
  });

  it('two sheets have two ids', () => {
    expect(make().sheet.el.id).not.toBe(make().sheet.el.id);
  });

  it('Esc (the dialog’s cancel) closes it itself and says esc once', () => {
    const { sheet, closes } = make();
    sheet.open();
    const cancel = new Event('cancel', { cancelable: true });
    sheet.el.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(sheet.isOpen).toBe(false);
    expect(closes).toEqual(['esc']);
  });

  it('a close the browser makes on its own (a repeated Esc that skips cancel) still says esc once', () => {
    const { sheet, closes } = make();
    sheet.open();
    HTMLDialogElement.prototype.close.call(sheet.el);
    expect(closes).toEqual(['esc']);
  });

  it('the close button says button', () => {
    const { sheet, closes } = make();
    sheet.open();
    (sheet.el.querySelector('.sheet-close') as HTMLButtonElement).click();
    expect(sheet.isOpen).toBe(false);
    expect(closes).toEqual(['button']);
  });

  it('close() says api, and only while open', () => {
    const { sheet, closes } = make();
    sheet.close();
    sheet.open();
    sheet.close();
    sheet.close();
    expect(closes).toEqual(['api']);
  });

  it('a press and click on the backdrop close it; a press that began inside and ended there does not', () => {
    const { sheet, closes } = make();
    const field = document.createElement('textarea');
    sheet.body.append(field);
    sheet.open();
    boxed(sheet);
    // Started in the text box (a selection), released on the backdrop: the click lands on the dialog.
    const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 100, button: 0 });
    Object.defineProperty(down, 'isPrimary', { value: true });
    field.dispatchEvent(down);
    sheet.el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20, button: 0 }));
    expect(sheet.isOpen).toBe(true);
    // Inside the box but on the dialog itself (its padding): not the backdrop.
    press(sheet.el, 200, 100);
    expect(sheet.isOpen).toBe(true);
    press(sheet.el, 20, 20);
    expect(sheet.isOpen).toBe(false);
    expect(closes).toEqual(['backdrop']);
  });

  it('with `backdrop: none` (it holds an edit) a press and click on the backdrop leave it open; Esc and the button still close it', () => {
    const { sheet, closes } = make({ backdrop: 'none' });
    sheet.open();
    boxed(sheet);
    expect(sheet.el.getAttribute('closedby')).toBe('closerequest');
    press(sheet.el, 20, 20);
    expect(sheet.isOpen).toBe(true);
    sheet.el.dispatchEvent(new Event('cancel', { cancelable: true }));
    sheet.open();
    (sheet.el.querySelector('.sheet-close') as HTMLButtonElement).click();
    expect(closes).toEqual(['esc', 'button']);
  });

  it('can open again after closing, and each close is reported', () => {
    const { sheet, closes } = make();
    sheet.open();
    sheet.close();
    sheet.open();
    (sheet.el.querySelector('.sheet-close') as HTMLButtonElement).click();
    expect(shown).toHaveBeenCalledTimes(2);
    expect(closes).toEqual(['api', 'button']);
  });

  it('puts the focus on the first control of the body, and back on the opener when it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { sheet } = make();
    const note = document.createElement('p');
    const first = document.createElement('button');
    const second = document.createElement('input');
    sheet.body.append(note, first, second);
    sheet.open(opener);
    expect(document.activeElement).toBe(first);
    sheet.close();
    expect(document.activeElement).toBe(opener);
  });

  it('remembers the focused element as the opener when none is given', () => {
    const was = document.createElement('input');
    document.body.append(was);
    was.focus();
    const { sheet } = make();
    sheet.body.append(document.createElement('button'));
    sheet.open();
    expect(document.activeElement).not.toBe(was);
    sheet.el.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(document.activeElement).toBe(was);
  });

  it('honours initialFocus, falls back to the dialog itself, and leaves a removed opener alone', () => {
    const target = document.createElement('textarea');
    const a = make({ initialFocus: () => target });
    a.sheet.body.append(document.createElement('button'), target);
    a.sheet.open();
    expect(document.activeElement).toBe(target);

    const opener = document.createElement('button');
    document.body.append(opener);
    const b = make();
    b.sheet.body.append(document.createElement('p'));
    b.sheet.open(opener);
    expect(document.activeElement).toBe(b.sheet.el);
    opener.remove();
    expect(() => b.sheet.close()).not.toThrow();
    expect(b.closes).toEqual(['api']);
  });

  it('is named by its visible title, and setLabel renames it', () => {
    const { sheet } = make({ label: 'Answer to continue' });
    const named = () => {
      const by = sheet.el.getAttribute('aria-labelledby');
      return by ? document.getElementById(by)?.textContent : sheet.el.getAttribute('aria-label');
    };
    sheet.open();
    expect(named()).toBe('Answer to continue');
    expect(sheet.header.textContent).toContain('Answer to continue');
    sheet.setLabel('Open questions');
    expect(named()).toBe('Open questions');
    expect(sheet.header.textContent).toContain('Open questions');
    // A heading that differs from the name: the name is the label, the heading shows the title.
    sheet.setLabel('Questions: 2 to answer, 1 open', 'Questions');
    expect(named()).toBe('Questions: 2 to answer, 1 open');
    expect(sheet.el.querySelector('.sheet-title')?.textContent).toBe('Questions');
  });

  it('destroy closes it without a word and removes it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const { sheet, closes } = make();
    sheet.body.append(document.createElement('button'));
    sheet.open(opener);
    sheet.destroy();
    expect(closes).toEqual([]);
    expect(sheet.el.isConnected).toBe(false);
    expect(sheet.isOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
    sheet.open();
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('keeps its keys from the game and the laptop, but its own content still hears them; a release still reaches the walker', () => {
    const onWindow = vi.fn();
    const onWindowUp = vi.fn();
    window.addEventListener('keydown', onWindow);
    window.addEventListener('keyup', onWindowUp);
    try {
      const { sheet } = make();
      const field = document.createElement('input');
      sheet.body.append(field);
      const onBody = vi.fn();
      const onSheet = vi.fn();
      sheet.body.addEventListener('keydown', onBody);
      sheet.el.addEventListener('keydown', onSheet);
      sheet.open();
      for (const key of ['w', 'Escape', '1', 'Enter']) field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
      expect(onBody).toHaveBeenCalledTimes(4);
      expect(onSheet).toHaveBeenCalledTimes(4);
      expect(onWindow).not.toHaveBeenCalled();
      expect(onWindowUp).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindow);
      window.removeEventListener('keyup', onWindowUp);
    }
  });

  it('with the on-screen keyboard up, it stands above it and keeps the focused field in view', () => {
    const listeners = new Map<string, () => void>();
    const vv = {
      height: 800,
      offsetTop: 0,
      scale: 1,
      addEventListener: vi.fn((t: string, f: () => void) => listeners.set(t, f)),
      removeEventListener: vi.fn((t: string) => listeners.delete(t)),
    };
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('innerHeight', 800);
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    const { sheet } = make();
    const field = document.createElement('textarea');
    sheet.body.append(field);
    sheet.open();
    expect(sheet.el.style.getPropertyValue('--sheet-kb')).toBe('0px');
    expect(sheet.el.style.getPropertyValue('--sheet-vv')).toBe('800px');
    // The keyboard takes the lower 340px of the screen.
    vv.height = 460;
    listeners.get('resize')!();
    expect(sheet.el.style.getPropertyValue('--sheet-kb')).toBe('340px');
    expect(sheet.el.style.getPropertyValue('--sheet-vv')).toBe('460px');
    expect(into).toHaveBeenCalledWith({ block: 'nearest' });
    // The page scrolled under it (iOS pans the visual viewport): the gap below shrinks by as much.
    vv.offsetTop = 100;
    listeners.get('scroll')!();
    expect(sheet.el.style.getPropertyValue('--sheet-kb')).toBe('240px');
    // A pinch zoom is not a keyboard.
    vv.scale = 2;
    listeners.get('resize')!();
    expect(sheet.el.style.getPropertyValue('--sheet-kb')).toBe('0px');
    sheet.close();
    expect(listeners.size).toBe(0);
  });
});
