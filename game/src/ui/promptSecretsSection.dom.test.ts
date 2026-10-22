// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { PromptSecretsBook } from '../world/promptSecrets';
import { promptSecretsSection } from './promptSecretsSection';
import { SettingsDialog } from './settings';

function mount(s: Record<string, unknown> | null, answer?: (args: Record<string, unknown>) => CommandResult) {
  document.body.replaceChildren();
  const book = new PromptSecretsBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'prompt-secrets',
    'Prompt secrets',
    promptSecretsSection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        return Promise.resolve(answer ? answer(args) : { ok: true, data: { enabled: args.enabled, available: true } });
      }) as never,
    }),
    { store: 'bridge', group: 'workers' },
  );
  dialog.renderSections(); // #146: what the dialog's first open does
  const root = document.querySelector<HTMLElement>('[data-section="prompt-secrets"]')!;
  const box = () => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const text = (sel: string) => root.querySelector<HTMLElement>(sel)?.textContent ?? '';
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, box, text, flush };
}

describe('the “Review prompt secrets before sending” switch (#108)', () => {
  it('is not there for a bridge without it; off by default, kept on the bridge, its limit said in plain words', () => {
    const m = mount(null);
    expect(m.root.hidden).toBe(true);
    m.book.upsert({ enabled: false, available: true });
    expect(m.root.hidden).toBe(false);
    expect(m.box().checked).toBe(false);
    expect(m.root.querySelector('label.settings-switch')!.textContent).toBe('Review prompt secrets before sending');
    expect(m.text('.settings-store')).toBe('Bridge');
    expect(m.text('.settings-act-privacy')).toMatch(/the agent can still read a protected file/);
    expect(m.text('.settings-field-hint')).toBe('Off: prompts are sent as typed, nothing is scanned.');
    // No private directory note while there is one.
    expect(m.root.querySelector<HTMLElement>('.settings-ps-away')!.hidden).toBe(true);
  });

  it('switches on and off through prompt_secrets.set and says what changes', async () => {
    const m = mount({ enabled: false, available: true });
    m.box().click();
    expect(m.box().disabled).toBe(true);
    expect(m.text('.settings-status')).toBe('Switching on…');
    await m.flush();
    expect(m.sent).toEqual([{ t: 'prompt_secrets.set', args: { enabled: true } }]);
    expect(m.book.on).toBe(true);
    expect(m.box().checked).toBe(true);
    expect(m.text('.settings-status')).toBe('On. Prompts are reviewed for secrets before they go.');
    expect(m.text('.settings-field-hint')).toMatch(/^On: every prompt/);
    m.box().click();
    await m.flush();
    expect(m.box().checked).toBe(false);
    expect(m.text('.settings-status')).toBe('Off. Prompts are sent as typed.');
    // Another client switches it on: this one's last word on its own change goes.
    m.book.upsert({ enabled: true, available: true });
    expect(m.box().checked).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.settings-status')!.hidden).toBe(true);
  });

  it('follows another client’s change; says when the bridge has no private directory; a failure says why', async () => {
    const m = mount({ enabled: false, available: true }, () => ({ ok: false, code: 'unknown_command', message: 'unknown command' }));
    m.book.upsert({ enabled: false, available: false });
    const away = m.root.querySelector<HTMLElement>('.settings-ps-away')!;
    expect(away.hidden).toBe(false);
    expect(away.textContent).toMatch(/no private runtime directory/);
    expect(away.classList.contains('settings-field-error')).toBe(false); // off: a fact, not an error
    m.book.upsert({ enabled: true, available: false });
    expect(m.box().checked).toBe(true);
    expect(away.classList.contains('settings-field-error')).toBe(true); // on: it refuses what protects anything
    expect(m.box().getAttribute('aria-describedby')).toContain(away.id);
    m.box().click();
    await m.flush();
    expect(m.box().checked).toBe(true);
    expect(m.text('.settings-status')).toMatch(/Update it/);
    expect(m.root.querySelector('.settings-status')?.classList.contains('settings-field-error')).toBe(true);
  });
});
