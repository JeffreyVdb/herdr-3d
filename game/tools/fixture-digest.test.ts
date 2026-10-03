import { describe, expect, it } from 'vitest';
import { cleanLine } from './fixture-digest.ts';

// #118: the fixture cleans the LLM's answer like internal/digest's Clean.
describe('fixture floor overview summaries: the line', () => {
  it('keeps the first line, without quotes, markdown or a full stop, clipped', () => {
    expect(cleanLine('"Running the e2e suite."', 100)).toBe('Running the e2e suite');
    expect(cleanLine('\n**Fixing the `login` test**\nmore', 100)).toBe('Fixing the login test');
    expect(cleanLine('x'.repeat(120), 100)).toHaveLength(100);
    expect(cleanLine('```\n```', 100)).toBeNull();
    expect(cleanLine('  ""  ', 100)).toBeNull();
  });
});
