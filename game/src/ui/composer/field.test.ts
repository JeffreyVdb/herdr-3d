import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../net/client';
import { Draft } from './draft';
import { failedImagesText, hasContent, markedText, notSentText, PASTE_HINT, uploadFailedText } from './field';

const png = (name: string) => new File([new Uint8Array(4).fill(1)], name, { type: 'image/png' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function draftWith(results: Array<CommandResult | 'hang'>) {
  let i = 0;
  const d = new Draft({ upload: () => (results[i] === undefined || results[i++] === 'hang' ? new Promise(() => {}) : Promise.resolve(results[i - 1] as CommandResult)), createUrl: () => '', revokeUrl: () => {} });
  return d;
}
const up = (path: string): CommandResult => ({ ok: true, data: { path, mime: 'image/png', size: 4 } });

describe('markedText', () => {
  it('writes [Image #n: path] for an uploaded image and a bare [Image #n] for one that is not (yet)', async () => {
    const d = draftWith([up('/drops/a.png'), 'hang']);
    d.replace(0, 0, 'see  and ');
    d.setSelection({ anchor: 4, focus: 4 });
    d.addImages([png('a.png')]);
    d.setSelection({ anchor: d.doc.text.length, focus: d.doc.text.length });
    await tick();
    d.addImages([png('b.png')]);
    await tick();
    expect(markedText(d.snapshot())).toBe('see [Image #1: /drops/a.png] and [Image #2]');
  });

  it('never puts a path that would break the marker into it', async () => {
    const d = draftWith([up('/drops/a].png')]);
    d.addImages([png('a.png')]);
    await tick();
    expect(markedText(d.snapshot())).toBe('[Image #1]');
  });
});

describe('the words for a failure', () => {
  const failed = [{ res: 'r1', name: 'a.png', numbers: [1], message: 'Drop Zone is down', code: 'dropzone_unavailable' }];
  it('says nothing was sent, why, and what to do', () => {
    expect(uploadFailedText(failed, { nothing: 'sent', again: 'send' })).toBe(
      'Nothing was sent: image 1 (a.png) did not upload (Drop Zone is down). Retry it on the picture, or remove it, then send again. Your prompt is kept.',
    );
    expect(uploadFailedText([...failed, { ...failed[0]!, res: 'r2', name: 'b.png', numbers: [2] }], { nothing: 'started', again: 'start' })).toContain('Retry them on the picture, or remove them, then start again');
  });
  it('a too long prompt says its size; a disposed draft says nothing', () => {
    expect(notSentText({ ok: false, reason: 'serialize', revision: 1, error: { kind: 'too_long', bytes: 20000, max: 16384 } }, { nothing: 'sent', again: 'send' })).toMatch(/limit is 16 KB/);
    expect(notSentText({ ok: false, reason: 'disposed', revision: 1 }, { nothing: 'sent', again: 'send' })).toBe('');
  });
  it('failedImagesText names the failed images of a draft, null when none failed', async () => {
    const d = draftWith([{ ok: false, code: 'upload_busy', message: 'Too many uploads at once: try again in a moment' }]);
    expect(failedImagesText(d.snapshot())).toBeNull();
    d.addImages([png('a.png')]);
    await tick();
    expect(failedImagesText(d.snapshot())).toBe('image 1 (a.png) did not upload (Too many uploads at once: try again in a moment): retry it on the picture, or remove it.');
  });
});

describe('hasContent and the hint', () => {
  it('an image alone is content, blanks are not', () => {
    const d = draftWith([]);
    expect(hasContent(d.snapshot())).toBe(false);
    d.replace(0, 0, '  \n ');
    expect(hasContent(d.snapshot())).toBe(false);
    d.addImages([png('a.png')]);
    expect(hasContent(d.snapshot())).toBe(true);
    expect(PASTE_HINT).toBe('paste a screenshot to add it');
  });
});
