// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { CodexServerBook, codexNotice } from '../world/codexServer';
import { codexServerSection } from './codexServerSection';
import { SettingsDialog } from './settings';

function mount(s: Record<string, unknown> | null, answer?: (args: Record<string, unknown>) => CommandResult) {
  document.body.replaceChildren();
  const book = new CodexServerBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'codex',
    'Codex workers',
    codexServerSection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        return Promise.resolve(answer ? answer(args) : { ok: true, data: { ...book.state, ...args } });
      }) as never,
    }),
    { store: 'bridge', group: 'workers' },
  );
  dialog.renderSections(); // #146: what the dialog's first open does
  const root = document.querySelector<HTMLElement>('[data-section="codex"]')!;
  const box = () => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const text = (sel: string) => root.querySelector<HTMLElement>(sel)?.textContent ?? '';
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, box, text, flush };
}

describe('the shared Codex server switch (#155)', () => {
  it('is not there for a bridge without it, and is off by default once it is', () => {
    const m = mount(null);
    expect(m.root.hidden).toBe(true);
    m.book.upsert({ enabled: false, available: true });
    expect(m.root.hidden).toBe(false);
    expect(m.box().checked).toBe(false);
    expect(m.box().disabled).toBe(false);
    expect(m.root.textContent).toContain('Give new Codex workers their own Codex server');
    expect(m.text('.settings-field-hint')).toContain('Codex workers hired from now on');
  });

  it('switches on through codex_server.set and says what changes', async () => {
    const m = mount({ enabled: false, available: true });
    m.box().click();
    expect(m.box().disabled).toBe(true);
    await m.flush();
    expect(m.sent).toEqual([{ t: 'codex_server.set', args: { enabled: true } }]);
    expect(m.book.state).toEqual({ enabled: true, available: true });
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(false);
    expect(m.text('.settings-status')).toBe('On. The next Codex hire gets its own server.');
  });

  it('keeps the keyboard on the switch across the command it sends', async () => {
    const m = mount({ enabled: false, available: true });
    m.box().focus();
    m.box().click();
    m.box().blur(); // what a browser does to a focused control it disables
    await m.flush();
    expect(document.activeElement).toBe(m.box());
  });

  it('a refusal puts the switch back and says why', async () => {
    const m = mount({ enabled: false, available: true }, () => ({ ok: false, code: 'unsupported', message: 'unsupported: no run dir' }) as CommandResult);
    m.box().click();
    await m.flush();
    expect(m.box().checked).toBe(false);
    expect(m.text('.settings-status')).toContain('--codex-run');
    expect(m.root.querySelector('.settings-status')!.classList.contains('settings-field-error')).toBe(true);
  });

  it('saves the compatibility choice, preserves the server switch, and follows updates', async () => {
    const m = mount({ enabled: true, available: true, allow_unverified: false });
    const risk = m.root.querySelector<HTMLInputElement>('input[id$="-unverified"]')!;
    expect(risk.checked).toBe(false);
    expect(risk.disabled).toBe(false);
    expect(m.root.textContent).toContain('I accept');
    risk.focus();
    risk.click();
    risk.blur();
    expect(m.box().disabled).toBe(true);
    await m.flush();
    expect(m.sent).toEqual([{ t: 'codex_server.set', args: { allow_unverified: true } }]);
    expect(m.book.state).toEqual({ enabled: true, available: true, allow_unverified: true });
    expect(document.activeElement).toBe(risk);
    expect(m.text('.settings-status')).toContain('including future upgrades');
    m.box().click();
    await m.flush();
    expect(m.book.state?.allow_unverified).toBe(true);
    m.book.upsert({ enabled: true, available: true, allow_unverified: false });
    expect(risk.checked).toBe(false);
  });

  it('restores the compatibility preference on failure and hides it for older bridges', async () => {
    const m = mount({ enabled: true, available: true, allow_unverified: false }, () => ({ ok: false, code: 'offline', message: '' }) as CommandResult);
    const risk = m.root.querySelector<HTMLInputElement>('input[id$="-unverified"]')!;
    risk.click();
    await m.flush();
    expect(risk.checked).toBe(false);
    expect(m.text('.settings-status')).toContain('Not connected');
    m.book.upsert({ enabled: true, available: true });
    expect(risk.parentElement!.hidden).toBe(true);
    expect(m.book.upsert({ enabled: true, available: true, allow_unverified: 'yes' })).toBe(false);
  });

  it('is disabled, with why, on a bridge that cannot start the servers', () => {
    const m = mount({ enabled: false, available: false });
    expect(m.box().disabled).toBe(true);
    expect(m.text('.settings-field-hint')).toContain('can’t start them');
  });

  it('follows codex_server.update', () => {
    const m = mount({ enabled: false, available: true });
    m.book.upsert({ t: 'codex_server.update', seq: 9, enabled: true, available: true });
    expect(m.box().checked).toBe(true);
    expect(m.book.upsert({ enabled: 'yes' })).toBe(false);
  });
});

describe('what a worker’s Codex launch tells you (#155)', () => {
  it('a dead server needs you; a fallback is a note; anything else is quiet', () => {
    expect(codexNotice({ codex: { mode: 'shared', server: 'down' } })?.tone).toBe('down');
    expect(codexNotice({ codex: { mode: 'shared', server: 'running' } })).toBeNull();
    expect(codexNotice({ codex: { mode: 'shared', server: 'stopped' } })).toBeNull();
    expect(codexNotice({ codex: { mode: 'shared', server: 'stopped', note: 'resume failed: x' } })).toEqual({ tone: 'down', text: 'Its Codex server is not running (resume failed: x).' });
    expect(codexNotice({ codex: { mode: 'legacy', note: 'shared Codex server: .envrc is blocked: /r/.envrc; started the usual way' } })).toEqual({
      tone: 'note',
      text: 'No own Codex server: .envrc is blocked: /r/.envrc. It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript.',
    });
    expect(
      codexNotice({ codex: { mode: 'shared', server: 'stopped', note: "shared Codex server: app-server connection failed; resumed without its own server, on Codex's built-in one" } }),
    ).toEqual({ tone: 'note', text: 'No own Codex server this time: app-server connection failed. It runs with Codex’s built-in one; the next wake tries its own again.' });
    expect(codexNotice({ codex: { mode: 'legacy' } })).toBeNull();
    // #186: a Codex the shared server is not verified with, by its CLI or by its server's userAgent: the version, plainly.
    for (const why of ['"codex-cli 0.999.0" (supported: codex-cli 0.160.x, 0.161.x, 0.162.x or 0.163.x)', 'app-server "herdr_3d/0.999.0 (Linux; x86_64) xterm" (supported: 0.160.x, 0.161.x, 0.162.x or 0.163.x)']) {
      expect(codexNotice({ codex: { mode: 'legacy', note: `shared Codex server: unsupported Codex version: ${why}; started the usual way` } })).toEqual({
        tone: 'note',
        text: 'No own Codex server: the shared Codex server is not verified with Codex 0.999.0 yet (verified: 0.160.x, 0.161.x, 0.162.x or 0.163.x). It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript.',
      });
    }
    expect(
      codexNotice({ codex: { mode: 'shared', server: 'stopped', note: 'shared Codex server: unsupported Codex version: "codex-cli 0.159.9" (supported: codex-cli 0.160.x, 0.161.x, 0.162.x or 0.163.x); started without its own server, on Codex\'s built-in one' } }),
    ).toEqual({ tone: 'note', text: 'No own Codex server this time: the shared Codex server is not verified with Codex 0.159.9 yet (verified: 0.160.x, 0.161.x, 0.162.x or 0.163.x). It runs with Codex’s built-in one; the next wake tries its own again.' });
    expect(codexNotice({})).toBeNull();
  });

  // #116: direnv is a mise shim with no version selected. The note is the Go side's literal
  // (internal/codexapp/preflight_test.go, internal/server/codexserver_test.go); mise's diagnostic is not in it and not shown.
  it('direnv with no mise version selected: what it is, where to fix it, what the worker is left with', () => {
    const n = codexNotice({ codex: { mode: 'legacy', note: 'shared Codex server: direnv is installed through mise but has no version selected for /home/u/repo; started the usual way' } });
    expect(n).toEqual({
      tone: 'note',
      text:
        'No own Codex server: direnv is installed with mise, but no version of it is selected for this worker’s folder (/home/u/repo). ' +
        'Select one for the bridge (see docs/git-worktrees.md). ' +
        'It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript; send it home and hire a new one once that is fixed.',
    });
    expect(n?.text).not.toMatch(/mise use|No version is set|ERROR|\n/);
  });
});
