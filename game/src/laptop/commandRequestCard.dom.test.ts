// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { CommandRequest } from '../net/protocol';
import { CommandRequestCard, type CommandRequestCardHost } from './commandRequestCard';

const req: CommandRequest = { key: 'turn', at: 1, commands: [{ command: 'sudo -k id\n', cwd: '/work', cwd_named: true, host: 'bridge', host_text: '', why: 'Inspect it', variants: [{ label: 'temporary', command: 'echo temporary', note: 'Ends on stop' }] }] };
/** A button by its accessible name (its aria-label, else its text). */
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)!;
const texts = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const card = (o: Partial<CommandRequestCardHost> = {}) => new CommandRequestCard({ worker: 'w', name: () => 'Zippy', host: () => 'host', start: vi.fn().mockResolvedValue({ ok: true, data: {} }), dismiss: vi.fn().mockResolvedValue({ ok: true, data: {} }), edit: vi.fn(), ...o });

describe('command request card', () => {
  it('shows the complete command, cwd, dialog form and variants; retries the same operation', async () => {
    const start = vi.fn().mockResolvedValueOnce({ ok: false, code: 'bad_args', message: 'Unsupported sudo form.' }).mockResolvedValue({ ok: true, data: {} });
    const c = card({ start });
    c.set(req);
    expect(c.el.textContent).toContain(req.commands[0]!.command);
    expect(c.el.textContent).toContain('named in the reply');
    expect(c.el.textContent).toContain('sudo -A -k id');
    expect(c.el.textContent).toContain('Ends on stop');
    button(c.el, 'Run').click(); await flush();
    expect(c.el.querySelector('[role="alert"]')!.textContent).toContain('Unsupported sudo form.');
    expect((c.el.querySelector('input') as HTMLInputElement).checked).toBe(false);
    button(c.el, 'Run').click(); await flush();
    expect(start.mock.calls[0]![0].op).toBe(start.mock.calls[1]![0].op);
    expect(start.mock.calls[1]![0]).toMatchObject({ askpass: false, source: { kind: 'suggestion', key: 'turn', index: 0 } });
  });
  it('disables run and editing for another machine', () => {
    const edit = vi.fn();
    const c = card({ edit });
    c.set({ ...req, commands: [{ ...req.commands[0]!, host: 'other', host_text: 'build machine' }] });
    expect(button(c.el, 'Run').disabled).toBe(true);
    expect(c.el.textContent).toContain('The agent asked to run this on build machine');
    expect(c.el.textContent).toContain('Machine:build machine');
    expect(button(c.el, 'Edit and run…')).toBeUndefined();
    expect(button(c.el, 'Copy command').disabled).toBe(false);
    expect(button(c.el, 'Dismiss this request').disabled).toBe(false);
    expect(c.el.querySelector('.mp-askpass')).toBeNull();
    expect(edit).not.toHaveBeenCalled();
  });
  // #220: "as your user" is the bridge's request once extracted; the exact `! sudo …` bytes run, without the dialog option.
  it('runs the bridge request of an account reply, its exact bytes, with the dialog only where eligible', async () => {
    const edit = vi.fn(); const start = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const c = card({ edit, start });
    const command = '! sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215';
    c.set({ key: 'k220', at: 1, commands: [{ command, cwd: '', cwd_named: false, host: 'bridge', host_text: '', why: '' }] });
    expect(button(c.el, 'Run').disabled).toBe(false);
    expect(c.el.querySelector('.mp-warning')).toBeNull();
    expect(c.el.textContent).toContain('Machine:host');
    expect(c.el.querySelector('.mp-well pre')!.textContent).toBe(command);
    expect(c.el.querySelector('.mp-askpass')).toBeNull();
    button(c.el, 'Edit and run…').click();
    expect(edit).toHaveBeenCalledWith(command, '');
    button(c.el, 'Run').click(); await flush();
    expect(start.mock.calls[0]![0]).toMatchObject({ command, askpass: false, source: { kind: 'suggestion', key: 'k220', index: 0 } });
    const plain = card();
    plain.set({ key: 'k220b', at: 1, commands: [{ command: command.slice(2), cwd: '', cwd_named: false, host: 'bridge', host_text: '', why: '' }] });
    expect(button(plain.el, 'Run').disabled).toBe(false);
    expect(plain.el.querySelector('.mp-warning')).toBeNull();
    expect(plain.el.querySelector<HTMLInputElement>('.mp-askpass input')!.checked).toBe(true);
    expect(plain.el.querySelector('.mp-launched')!.textContent).toContain('sudo -A tailscale serve --bg --https=8216 http://127.0.0.1:45215');
  });
  it('reads as a terminal command preview: the icon, whose request, the question, the exact bytes without a prompt in them', () => {
    const c = card();
    const command = 'printf "a  b\\n"\n\techo \'q\'  ';
    c.set({ key: 'k', at: 1, commands: [{ command, cwd: '', cwd_named: false, host: 'bridge', host_text: '', why: 'Needs a check' }] });
    expect(c.el.querySelector('h3')!.textContent).toBe('Command Previewfrom Zippy');
    expect(c.el.getAttribute('aria-labelledby')).toBe(c.el.querySelector('h3')!.id);
    expect(c.el.querySelector('.mp-request-icon svg')).not.toBeNull();
    expect(c.el.querySelector('.mp-request-ask')!.textContent).toBe('Run this command?');
    expect(c.el.querySelector('.mp-well pre')!.textContent).toBe(command);
    expect(c.el.querySelector('.mp-well')!.textContent).not.toContain('$');
    expect(c.el.textContent).toContain('the agent’s folder (agent’s folder)');
    expect(c.el.querySelector('.mp-why')!.textContent).toBe('Needs a check');
    // The order of the actions, and their names.
    expect(texts(c.el)).toEqual(['Run', 'Edit and run…', 'Copy command', 'Dismiss this request']);
    expect([...c.el.querySelectorAll('button svg')].every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
  it('shows the launched form only while the dialog option is on', () => {
    const c = card();
    document.body.append(c.el);
    c.set({ key: 'k', at: 1, commands: [{ ...req.commands[0]!, variants: [] }] });
    const check = c.el.querySelector<HTMLInputElement>('.mp-askpass input')!;
    const launched = c.el.querySelector<HTMLElement>('.mp-launched')!;
    expect([check.checked, launched.hidden]).toEqual([true, false]);
    expect(launched.textContent).toBe('Launched formsudo -A -k id\n');
    check.click();
    expect(launched.hidden).toBe(true);
    c.el.remove();
  });
  it('says Starting… on the run in flight only, holds the others, and keeps the focus through a redraw', async () => {
    let done!: (v: unknown) => void;
    const start = vi.fn((_args: unknown) => new Promise((r) => { done = r; }));
    const c = card({ start: start as never });
    document.body.append(c.el);
    c.set(req);
    const variant = button(c.el, 'Run temporary');
    variant.focus();
    variant.click();
    expect(texts(c.el)).toContain('Starting…');
    for (const name of ['Run', 'Starting…', 'Edit and run…', 'Dismiss this request']) expect(button(c.el, name).getAttribute('aria-disabled'), name).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.key).toBe('run:0:0');
    button(c.el, 'Starting…').click(); // a second press while it starts sends nothing
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ command: 'echo temporary', askpass: false });
    done({ ok: false, code: 'stale', message: '' }); await flush();
    expect(c.el.querySelector('[role="alert"]')!.textContent).toContain('out of date');
    c.el.remove();
  });
  it('goes away when the run is accepted or the request is dismissed, and says what failed otherwise', async () => {
    const c = card();
    c.set(req);
    button(c.el, 'Run').click(); await flush();
    expect(c.shown).toBe(false);
    const d = card({ dismiss: vi.fn().mockResolvedValue({ ok: false, code: 'timeout', message: 'The bridge did not answer.' }) });
    d.set(req);
    button(d.el, 'Dismiss this request').click();
    expect(texts(d.el)).toContain('Dismiss this request');
    expect(d.el.textContent).toContain('Dismissing…');
    await flush();
    expect(d.shown).toBe(true);
    expect(d.el.querySelector('[role="alert"]')!.textContent).toBe('The bridge did not answer.');
  });
  it('hands the exact command to Edit and run… and runs nothing itself', () => {
    const edit = vi.fn(); const start = vi.fn();
    const c = card({ edit, start });
    c.set(req);
    button(c.el, 'Edit and run…').click();
    expect(edit).toHaveBeenCalledWith('sudo -k id\n', '/work');
    expect(start).not.toHaveBeenCalled();
  });
  it('names each of several commands, each with its own place, reason and controls', () => {
    const c = card();
    c.set({ key: 'k', at: 1, commands: [{ command: 'make a', cwd: '/a', cwd_named: true, host: 'bridge', host_text: '', why: 'First' }, { command: 'make b', cwd: '/b', cwd_named: false, host: 'other', host_text: 'the CI box', why: 'Second' }] });
    expect(c.el.querySelector('.mp-request-ask')!.textContent).toBe('Run these 2 commands?');
    expect(texts(c.el)).toEqual(['Run command 1', 'Edit and run command 1…', 'Copy command 1', 'Run command 2', 'Copy command 2', 'Dismiss this request']);
    const groups = [...c.el.querySelectorAll('[role="group"]')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Command 1', 'Command 2']);
    expect(groups[1]!.textContent).toContain('the CI box');
    expect(groups[1]!.textContent).toContain('Second');
    expect(button(c.el, 'Run command 2').disabled).toBe(true);
  });
  it('copies the exact command and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const c = card();
    c.set(req);
    button(c.el, 'Copy temporary command').click(); await flush();
    expect(writeText).toHaveBeenCalledWith('echo temporary');
    button(c.el, 'Copy command').click(); await flush();
    expect(writeText).toHaveBeenLastCalledWith('sudo -k id\n');
    expect(button(c.el, 'Copied command')).toBeDefined();
  });
});
