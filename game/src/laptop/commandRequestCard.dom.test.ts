// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { CommandRequest } from '../net/protocol';
import { CommandRequestCard } from './commandRequestCard';

const req: CommandRequest = { key: 'turn', at: 1, commands: [{ command: 'sudo -k id\n', cwd: '/work', cwd_named: true, host: 'bridge', host_text: '', why: 'Inspect it', variants: [{ label: 'temporary', command: 'echo temporary', note: 'Ends on stop' }] }] };
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('command request card', () => {
  it('shows the complete command, cwd, dialog form and variants; retries the same operation', async () => {
    const start = vi.fn().mockResolvedValueOnce({ ok: false, code: 'bad_args', message: 'Unsupported sudo form.' }).mockResolvedValue({ ok: true, data: {} });
    const card = new CommandRequestCard({ worker: 'w', host: () => 'host', start, dismiss: vi.fn(), edit: vi.fn() });
    card.set(req);
    expect(card.el.textContent).toContain(req.commands[0]!.command);
    expect(card.el.textContent).toContain('named in the reply');
    expect(card.el.textContent).toContain('sudo -A -k id');
    expect(card.el.textContent).toContain('Ends on stop');
    button(card.el, 'Run').click(); await Promise.resolve(); await Promise.resolve();
    expect(card.el.textContent).toContain('Unsupported sudo form.');
    expect((card.el.querySelector('input') as HTMLInputElement).checked).toBe(false);
    button(card.el, 'Run').click(); await Promise.resolve(); await Promise.resolve();
    expect(start.mock.calls[0]![0].op).toBe(start.mock.calls[1]![0].op);
    expect(start.mock.calls[1]![0]).toMatchObject({ askpass: false, source: { kind: 'suggestion', key: 'turn', index: 0 } });
  });
  it('disables run and editing for another machine', () => {
    const edit = vi.fn();
    const card = new CommandRequestCard({ worker: 'w', host: () => 'host', start: vi.fn(), dismiss: vi.fn(), edit });
    card.set({ ...req, commands: [{ ...req.commands[0]!, host: 'other', host_text: 'build machine' }] });
    expect(button(card.el, 'Run').disabled).toBe(true);
    expect(card.el.textContent).toContain('The agent asked to run this on build machine');
    expect(button(card.el, 'Edit and run…')).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
  });
});
