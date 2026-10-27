import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askpassEligible, askpassForm, askpassRewrite } from './askpass';

/** #213: the bridge writes these cases from its own rewrite (internal/manual/askpass); the game agrees with each. */
const file = resolve(import.meta.dirname, '../../../internal/manual/askpass/testdata/eligibility.json');
const cases = JSON.parse(readFileSync(file, 'utf8')) as Array<{ command: string; eligible: boolean; launched: string | null }>;

describe('askpass parity with the bridge', () => {
  it('has the required cases', () => {
    expect(cases.find((c) => c.command === 'sudo -k python3 tools/hello_world_server.py 80\n')).toEqual({ command: 'sudo -k python3 tools/hello_world_server.py 80\n', eligible: true, launched: 'sudo -A -k python3 tools/hello_world_server.py 80\n' });
    expect(cases.some((c) => !c.eligible)).toBe(true);
  });
  for (const c of cases) {
    it(`${JSON.stringify(c.command)} → ${c.eligible ? JSON.stringify(c.launched) : 'terminal'}`, () => {
      expect(askpassRewrite(c.command)).toBe(c.eligible ? c.launched : null);
      expect(askpassEligible(c.command)).toBe(c.eligible);
      expect(askpassForm(c.command)).toBe(c.eligible ? c.launched : c.command);
    });
  }
});
