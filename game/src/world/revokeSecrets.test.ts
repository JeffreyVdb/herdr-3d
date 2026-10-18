import { describe, expect, it } from 'vitest';
import { revokedText, revokeWhat, secretFilesOf, secretFilesText } from './revokeSecrets';

// #108 round 4: a worker's protected files, removed on purpose (prompt_secrets.revoke).

describe('revoke secrets (#108)', () => {
  it('reads Worker.secret_files: absent, 0 or not a whole count is none', () => {
    expect(secretFilesOf({ secret_files: 3 })).toBe(3);
    for (const w of [{}, { secret_files: 0 }, { secret_files: -2 }, { secret_files: 1.5 }, { secret_files: '2' as unknown as number }, null, undefined]) expect(secretFilesOf(w)).toBe(0);
  });

  it('says the count, what removing does (the worker keeps running, the references point at nothing) and the answer', () => {
    expect(secretFilesText(1)).toBe('1 protected file');
    expect(secretFilesText(3)).toBe('3 protected files');
    const what = revokeWhat('Pebble', 3).join(' ');
    expect(what).toContain('Pebble holds 3 protected files');
    expect(what).toContain('Pebble keeps running');
    expect(what).toContain('will point at nothing');
    expect(what).toContain('cannot be undone');
    expect(revokeWhat('Pebble', 1).join(' ')).toContain('Remove deletes it at once.');
    expect(revokeWhat('Pebble', 2).join(' ')).toContain('Remove deletes them at once.');
    expect(revokedText('Pebble', 3)).toBe('Removed 3 protected files from Pebble. Pebble keeps working.');
    expect(revokedText('Pebble', 1)).toBe('Removed 1 protected file from Pebble. Pebble keeps working.');
    expect(revokedText('Pebble', 0)).toBe('Pebble held no protected files any more: nothing was removed.');
  });
});
