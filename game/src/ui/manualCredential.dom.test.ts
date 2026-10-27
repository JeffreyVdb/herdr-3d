// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualProcess } from '../net/protocol';
import { ManualCredentialDialog } from './manualCredential';

beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});

const process = { id: 'p', host: 'bridge', command: 'sudo thing', launched: 'sudo -A thing', credential: { request: 'r1', prompt: 'Password:', user: 'root', attempt: 1, expires_at: 0 } } as ManualProcess;

describe('manual credential dialog', () => {
  it('clears the field immediately and never exposes the secret in its summary', async () => {
    let finish!: (result: { ok: true; data: undefined }) => void;
    const send = vi.fn(() => new Promise<{ ok: true; data: undefined }>((resolve) => { finish = resolve; }));
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const dialog = new ManualCredentialDialog(document.body, send, vi.fn());
    dialog.refresh(process);
    const input = document.querySelector('input')!;
    input.value = 'H3D-MARKER';
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!.click();
    expect(input.value).toBe('');
    expect(JSON.stringify(dialog.summary())).not.toContain('H3D-MARKER');
    expect(JSON.stringify(process)).not.toContain('H3D-MARKER');
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    expect(send).toHaveBeenCalledWith({ id: 'p', request: 'r1', secret: 'H3D-MARKER' });
    finish({ ok: true, data: undefined });
    await Promise.resolve();
    expect(dialog.isOpen).toBe(false);
  });
  it('replaces the request and closes when it disappears', () => {
    const dialog = new ManualCredentialDialog(document.body, vi.fn(), vi.fn());
    dialog.refresh(process);
    (document.querySelector('input') as HTMLInputElement).value = 'old';
    dialog.refresh({ ...process, credential: { ...process.credential!, request: 'r2', attempt: 2 } });
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).toContain('Wrong password, try again');
    dialog.refresh(undefined);
    expect(dialog.isOpen).toBe(false);
  });
});
