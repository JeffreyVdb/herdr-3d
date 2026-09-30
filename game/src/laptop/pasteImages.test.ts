import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { UPLOAD_MAX_BYTES } from '../net/upload';
import type { Uploader } from '../ui/composer/draft';
import { pasteImages, type PasteImagesHost } from './pasteImages';

const png = (name: string) => new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(o: Partial<PasteImagesHost> & { results?: CommandResult[] } = {}) {
  const said: Array<[string, string]> = [];
  const pasted: string[] = [];
  const hints: Array<{ label: string; n: number }> = [];
  let i = 0;
  const upload: Uploader = (_f, hint) => {
    hints.push({ label: hint.label, n: hint.n });
    const r = o.results?.[i++] ?? { ok: true, data: { path: `/home/u/drops/h3d-terminal-${hint.n}.png`, mime: 'image/png', size: 8 } };
    return Promise.resolve(r);
  };
  const host: PasteImagesHost = {
    name: 'Sunny Otter',
    agent: true,
    upload,
    paste: (t) => {
      pasted.push(t);
      return true;
    },
    say: (k, m) => said.push([k, m]),
    ...o,
  };
  delete (host as { results?: unknown }).results;
  return { host, said, pasted, hints };
}

describe('an image pasted in the terminal view (#64)', () => {
  it('goes to an agent as [Image #n: path] markers, in order, as one paste, uploaded under the surface and the worker', async () => {
    const { host, said, pasted, hints } = setup();
    await pasteImages([png('a.png'), png('b.png')], host);
    expect(pasted).toEqual(['[Image #1: /home/u/drops/h3d-terminal-1.png][Image #2: /home/u/drops/h3d-terminal-2.png]']);
    expect(hints.map((h) => [h.label, h.n])).toEqual([['terminal-Sunny Otter', 1], ['terminal-Sunny Otter', 2]]);
    expect(said[0]).toEqual(['ok', 'Uploading 2 images for Sunny Otter…']);
    expect(said.at(-1)).toEqual(['ok', 'Pasting 2 images into Sunny Otter’s terminal…']);
  });

  it('a plain shell says it cannot take an image; nothing is uploaded, nothing is typed', async () => {
    const { host, said, pasted, hints } = setup({ agent: false });
    await pasteImages([png('a.png')], host);
    expect(pasted).toEqual([]);
    expect(hints).toEqual([]);
    expect(said).toEqual([['error', 'Sunny Otter runs a plain shell, not an agent: an image can’t be pasted there. Nothing was typed.']]);
  });

  it('an upload that fails sends nothing, and says which image and why', async () => {
    const { host, said, pasted } = setup({ results: [{ ok: true, data: { path: '/d/a.png', mime: 'image/png', size: 8 } }, { ok: false, code: 'upload_busy', message: 'Too many uploads at once: try again in a moment' }] });
    await pasteImages([png('a.png'), png('b.png')], host);
    expect(pasted).toEqual([]);
    expect(said.at(-1)).toEqual(['error', 'Nothing was pasted into Sunny Otter’s terminal: image 2 (b.png) did not upload (Too many uploads at once: try again in a moment). Paste again to retry.']);
  });

  it('a file that is refused up front (over 25 MiB, not an image) sends nothing and uploads nothing', async () => {
    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 });
    for (const files of [[big], [png('ok.png'), new File(['x'], 'doc.pdf', { type: 'application/pdf' })]]) {
      const { host, said, pasted, hints } = setup();
      await pasteImages(files, host);
      expect(pasted).toEqual([]);
      expect(hints).toEqual([]);
      expect(said).toHaveLength(1);
      expect(said[0]![0]).toBe('error');
      expect(said[0]![1]).toMatch(/Nothing was pasted\.$/);
    }
  });

  it('Drop Zone down: the failure is the bridge’s message; a game without an upload door says so', async () => {
    const down = setup({ results: [{ ok: false, code: 'dropzone_unavailable', message: 'Drop Zone is not running' }] });
    await pasteImages([png('a.png')], down.host);
    expect(down.pasted).toEqual([]);
    expect(down.said.at(-1)![1]).toContain('Drop Zone is not running');
    const none = setup({ upload: undefined });
    await pasteImages([png('a.png')], none.host);
    expect(none.said).toEqual([['error', 'This game can’t upload images: nothing was pasted.']]);
  });

  it('while the upload is pending nothing has been pasted yet', async () => {
    let done: (r: CommandResult) => void = () => undefined;
    const { host, pasted } = setup({ upload: () => new Promise((r) => (done = r)) });
    const p = pasteImages([png('a.png')], host);
    await flush();
    expect(pasted).toEqual([]);
    done({ ok: true, data: { path: '/d/a.png', mime: 'image/png', size: 8 } });
    await p;
    expect(pasted).toEqual(['[Image #1: /d/a.png]']);
  });

  it('a queue that refuses the text (over 16 KiB) says so', async () => {
    const { host, said } = setup({ paste: () => false });
    await pasteImages([png('a.png')], host);
    expect(said.at(-1)).toEqual(['error', 'That paste is over 16 KiB: paste less at a time.']);
  });
});
