// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { RevokeSecretsDialog, type RevokeSecretsHost } from './revokeSecrets';
import { SeatBar } from './seat';

// #108 round 4: removing a worker's protected files now: the seat bar's chip and its confirmation.

const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};

function setup(o: { files?: number; unsupported?: boolean; reply?: CommandResult } = {}) {
  document.body.replaceChildren();
  const worker: { id: string; secret_files?: number } = { id: 'A', ...(o.files !== undefined ? { secret_files: o.files } : { secret_files: 3 }) };
  const workers = new Map([['A', worker]]);
  const sent: Array<{ t: string; args: unknown }> = [];
  const toasts: Array<[string, string]> = [];
  const host = {
    store: { workers, workerView: (id: string) => (workers.has(id) ? { name: 'Pebble', worker: workers.get(id) } : null) },
    send: (t: string, args: unknown) => {
      sent.push({ t, args });
      return Promise.resolve(o.reply ?? ({ ok: true, data: { removed: 3 } } as CommandResult));
    },
    unsupported: () => o.unsupported === true,
    toast: (m: string, kind: string) => void toasts.push([m, kind]),
  } as unknown as RevokeSecretsHost;
  const opener = document.createElement('button');
  document.body.append(opener);
  const dlg = new RevokeSecretsDialog(document.body, host);
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`.desk-dlg--revoke [data-key="${key}"]`)!;
  return { dlg, worker, workers, sent, toasts, opener, q };
}

describe('the revoke confirmation (#108)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => document.body.replaceChildren());

  it('says what removing does, Cancel has the keyboard first; Remove sends prompt_secrets.revoke and the toast says how many went', async () => {
    const e = setup();
    expect(e.dlg.open('A', e.opener)).toBe(true);
    const s = e.dlg.summary()!;
    expect(s).toMatchObject({ kind: 'revoke-secrets', state: 'ready', worker: 'A', name: 'Pebble', files: 3 });
    const what = document.querySelector('[data-hook="revoke-what"]')!.textContent ?? '';
    expect(what).toContain('Pebble holds 3 protected files');
    expect(what).toContain('Pebble keeps running');
    expect(what).toContain('will point at nothing');
    expect(what).toContain('cannot be undone');
    expect(document.querySelector('#rv-sec-title')?.textContent).toBe('Remove protected files');
    expect(document.querySelector('#rv-sec-sub')?.textContent).toBe('Pebble · 3 protected files on the bridge host');
    expect(document.activeElement).toBe(e.q('cancel'));
    expect(e.q('remove').textContent).toBe('Remove 3 files');
    expect(e.q('remove').classList.contains('btn--danger')).toBe(true);
    e.q('remove').click();
    expect(e.dlg.summary()?.state).toBe('busy');
    await flush();
    expect(e.sent).toEqual([{ t: 'prompt_secrets.revoke', args: { worker: 'A' } }]);
    expect(e.dlg.isOpen).toBe(false);
    expect(e.toasts).toEqual([['Removed 3 protected files from Pebble. Pebble keeps working.', 'info']]);
    expect(document.activeElement).toBe(e.opener);
  });

  it('Cancel, Esc and the close button send nothing', () => {
    const e = setup();
    e.dlg.open('A', e.opener);
    e.q('cancel').click();
    e.dlg.open('A', e.opener);
    e.q('close').click();
    e.dlg.open('A', e.opener);
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel'));
    e.dlg.close();
    expect(e.sent).toEqual([]);
  });

  it('does not open for a worker with no files, no count (an older bridge) or without the command', () => {
    expect(setup({ files: 0 }).dlg.open('A')).toBe(false);
    const none = setup();
    delete none.worker.secret_files;
    expect(none.dlg.open('A')).toBe(false);
    expect(setup({ unsupported: true }).dlg.open('A')).toBe(false);
    expect(setup().dlg.open('gone')).toBe(false);
  });

  it('a refusal stays in the dialog (Remove again possible); an older bridge closes it with why; a worker gone says so', async () => {
    const e = setup({ reply: { ok: false, code: 'secrets_unavailable', message: 'no private runtime directory' } });
    e.dlg.open('A', e.opener);
    e.q('remove').click();
    await flush();
    expect(e.dlg.isOpen).toBe(true);
    expect(e.dlg.summary()).toMatchObject({ state: 'ready', error: true });
    expect(e.dlg.summary()?.status).toContain('can’t keep secrets in files right now');
    const old = setup({ reply: { ok: false, code: 'unknown_command', message: 'unknown command: "prompt_secrets.revoke"' } });
    old.dlg.open('A', old.opener);
    old.q('remove').click();
    await flush();
    expect(old.dlg.isOpen).toBe(false);
    expect(old.toasts.at(-1)?.[1]).toBe('error');
    expect(old.toasts.at(-1)?.[0]).toContain('remove a worker’s protected files');
    const gone = setup({ reply: { ok: false, code: 'not_found', message: 'not found' } });
    gone.dlg.open('A', gone.opener);
    gone.q('remove').click();
    await flush();
    expect(gone.dlg.summary()?.status).toBe('Pebble is no longer here: its protected files went with it.');
  });

  it('follows the worker while open: a new count, and none (or the worker gone) closes it', () => {
    const e = setup();
    e.dlg.open('A', e.opener);
    e.worker.secret_files = 5;
    e.dlg.refresh();
    expect(e.dlg.summary()?.files).toBe(5);
    expect(e.q('remove').textContent).toBe('Remove 5 files');
    e.worker.secret_files = 1;
    e.dlg.refresh();
    expect(e.q('remove').textContent).toBe('Remove the file');
    delete e.worker.secret_files;
    e.dlg.refresh();
    expect(e.dlg.isOpen).toBe(false);
    e.worker.secret_files = 2;
    e.dlg.open('A');
    e.workers.delete('A');
    e.dlg.refresh();
    expect(e.dlg.isOpen).toBe(false);
  });
});

describe('the seat bar’s protected-files chip (#108)', () => {
  const noop = { text() {}, paste() {}, stand() {}, toggle() {} };

  it('shows the count while the seated worker holds some, hidden at none; a press opens the confirmation from it', () => {
    const hud = document.createElement('div');
    const asked: HTMLElement[] = [];
    const bar = new SeatBar(hud, { ...noop, revoke: (from) => void asked.push(from) });
    bar.show('Pebble', false);
    const chip = hud.querySelector<HTMLButtonElement>('.seat-secrets')!;
    expect(chip.hidden).toBe(true);
    expect(bar.summary().secretFiles).toBeNull();
    bar.secretFiles(3);
    expect(chip.hidden).toBe(false);
    expect(bar.summary().secretFiles).toBe('3 protected files');
    expect(chip.getAttribute('aria-label')).toBe('3 protected files: remove them now…');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.title).toContain('Pebble holds 3 protected files');
    chip.click();
    expect(asked).toEqual([chip]);
    bar.secretFiles(1);
    expect(bar.summary().secretFiles).toBe('1 protected file');
    bar.secretFiles(0);
    expect(chip.hidden).toBe(true);
  });

  it('a bar with no way to revoke never shows it', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    bar.show('Pebble', false);
    bar.secretFiles(4);
    expect(bar.summary().secretFiles).toBeNull();
    expect(hud.querySelector('.seat-secrets')).toBeNull();
  });
});
