import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../net/client';
import { UPLOAD_MAX_BYTES } from '../../net/upload';
import { Draft, type DraftOptions, type ResolveResult } from './draft';
import { caret, IMG, imagesOf } from './model';

/** An upload the test finishes by hand. */
interface Call {
  n: number;
  label: string;
  name: string;
  signal: AbortSignal;
  ok(path?: string): void;
  fail(code?: string, message?: string): void;
}

function harness(o: Partial<DraftOptions> = {}) {
  const calls: Call[] = [];
  const urls = new Set<string>();
  let u = 0;
  const draft = new Draft({
    upload: (file, hint, signal) =>
      new Promise<CommandResult>((resolve) => {
        const c: Call = {
          n: hint.n,
          label: hint.label,
          name: (file as File).name,
          signal,
          ok: (path = `/drops/h3d-${hint.label}-${hint.n}.png`) => resolve({ ok: true, data: { path, mime: 'image/png', size: file.size } }),
          fail: (code = 'dropzone_unavailable', message = 'Drop Zone is down') => resolve({ ok: false, code, message }),
        };
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'aborted', message: 'cancelled' }));
        calls.push(c);
      }),
    createUrl: () => {
      const x = `blob:test/${++u}`;
      urls.add(x);
      return x;
    },
    revokeUrl: (x) => urls.delete(x),
    ...o,
  });
  return { draft, calls, urls };
}

const png = (name = 'shot.png', size = 10) => new File([new Uint8Array(size).fill(1)], name, { type: 'image/png' });
const tick = () => new Promise((r) => setTimeout(r, 0));
const ok = (r: ResolveResult) => {
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r)}`);
  return r;
};

describe('adding images', () => {
  it('puts two files at the caret, in order, replacing the selection, as one step', () => {
    const { draft } = harness();
    draft.replace(0, 0, 'hello world');
    draft.setSelection({ anchor: 5, focus: 6 });
    const r = draft.addImages([png('a.png'), png('b.png')]);
    expect(r).toEqual({ added: 2, errors: [] });
    expect(draft.doc.text).toBe(`hello${IMG}${IMG}world`);
    expect(draft.selection).toEqual(caret(7));
    expect(draft.snapshot().images.map((i) => [i.n, i.name])).toEqual([[1, 'a.png'], [2, 'b.png']]);
    draft.undo();
    expect(draft.doc.text).toBe('hello world');
  });

  it('refuses each bad file with a message and takes the rest', () => {
    const { draft } = harness();
    const r = draft.addImages([png('ok.png'), new File([''], 'empty.png', { type: 'image/png' }), new File(['x'], 'doc.pdf', { type: 'application/pdf' }), png('ok2.png')]);
    expect(r.added).toBe(2);
    expect(r.errors).toEqual(['empty.png is empty.', 'doc.pdf is not a PNG, JPEG, GIF or WebP image.']);
  });

  it('refuses a file over the cap (on its size), and takes one at exactly the cap', () => {
    const { draft } = harness();
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 });
    const edge = new File(['x'], 'edge.png', { type: 'image/png' });
    Object.defineProperty(edge, 'size', { value: UPLOAD_MAX_BYTES });
    const r = draft.addImages([big, edge]);
    expect(r.added).toBe(1);
    expect(r.errors[0]).toMatch(/big\.png is 25\.0 MB/);
  });

  it('stops at the image limit with one message, and a replaced selection frees its room', () => {
    const { draft } = harness({ maxImages: 3 });
    expect(draft.addImages([png(), png()]).added).toBe(2);
    const r = draft.addImages([png(), png(), png()]);
    expect(r.added).toBe(1);
    expect(r.errors).toEqual(['You can attach up to 3 images to one prompt.']);
    // Selecting two images and pasting two: they replace them.
    expect(draft.addImages([png(), png()], [0, 2]).added).toBe(2);
    expect(draft.doc.chips).toHaveLength(3);
  });

  it('names an unnamed clipboard image', () => {
    const { draft } = harness();
    draft.addImages([new File(['x'], '', { type: 'image/png' })]);
    expect(draft.snapshot().images[0]?.name).toBe('pasted image');
  });

  it('keeps two screenshots with the same name and size apart', () => {
    const { draft } = harness();
    draft.addImages([png('image.png', 5), png('image.png', 5)]);
    const ims = draft.snapshot().images;
    expect(new Set(ims.map((i) => i.res)).size).toBe(2);
    expect(new Set(ims.map((i) => i.occ)).size).toBe(2);
  });
});

describe('the upload queue', () => {
  it('starts uploading at once, at most two at a time, with a label and n per image', async () => {
    const { draft, calls } = harness({ label: 'nibble' });
    draft.addImages([png('a.png'), png('b.png'), png('c.png')]);
    expect(calls.map((c) => [c.label, c.n, c.name])).toEqual([['nibble', 1, 'a.png'], ['nibble', 2, 'b.png']]);
    expect(draft.snapshot().images.map((i) => i.status)).toEqual(['uploading', 'uploading', 'pending']);
    calls[0]?.ok();
    await tick();
    expect(calls).toHaveLength(3);
    expect(draft.snapshot().images.map((i) => i.status)).toEqual(['ready', 'uploading', 'uploading']);
  });

  it('takes the label from a function each time', () => {
    let l = 'a';
    const { draft, calls } = harness({ label: () => l });
    draft.addImages([png()]);
    l = 'b';
    draft.addImages([png()]);
    expect(calls.map((c) => c.label)).toEqual(['a', 'b']);
  });

  it('records the path when an upload is ready and the message when it fails', async () => {
    const { draft, calls } = harness();
    draft.addImages([png(), png()]);
    calls[0]?.ok('/drops/x y.png');
    calls[1]?.fail('upload_unsupported', 'not an image');
    await tick();
    const [a, b] = draft.snapshot().images;
    expect(a).toMatchObject({ status: 'ready', path: '/drops/x y.png' });
    expect(b).toMatchObject({ status: 'error', error: 'not an image', code: 'upload_unsupported' });
    expect(draft.snapshot()).toMatchObject({ uploading: false, failed: true });
  });

  it('treats a success without a path as a failure', async () => {
    const { draft } = harness({ upload: async () => ({ ok: true, data: { nope: 1 } }) });
    draft.addImages([png()]);
    await tick();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'error', code: 'dropzone_bad_response' });
  });

  it('turns a rejected upload into an error, not an unhandled rejection', async () => {
    const { draft } = harness({ upload: () => Promise.reject(new Error('boom')) });
    draft.addImages([png()]);
    await tick();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'error', code: 'internal' });
  });

  it('retry puts only the failed image back; a ready one is never sent again', async () => {
    const { draft, calls } = harness();
    draft.addImages([png('a.png'), png('b.png')]);
    calls[0]?.ok();
    calls[1]?.fail();
    await tick();
    const [a, b] = draft.snapshot().images;
    expect(draft.retry(a?.res as string)).toBe(false);
    expect(draft.retry(b?.res as string)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.name).toBe('b.png');
    calls[2]?.ok();
    await tick();
    expect(draft.snapshot().images.map((i) => i.status)).toEqual(['ready', 'ready']);
  });

  it('ignores the late answer of an image that was removed, and cancels its upload', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const im = draft.snapshot().images[0];
    draft.removeChip(im?.occ as string);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.ok('/late.png');
    await tick();
    expect(draft.snapshot().images).toEqual([]);
    // The resource is still there (undo can bring it back), pending, without the late path.
    expect(draft.resource(im?.res as string)).toMatchObject({ status: 'pending' });
    expect(draft.resource(im?.res as string)?.path).toBeUndefined();
  });

  it('uploads again after an undo brings the image back, and never uses the answer of the cancelled attempt', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const im = draft.snapshot().images[0];
    draft.removeChip(im?.occ as string);
    draft.undo();
    expect(draft.snapshot().images[0]?.status).toBe('uploading');
    expect(calls).toHaveLength(2);
    calls[0]?.ok('/stale.png');
    await tick();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'uploading' });
    calls[1]?.ok('/fresh.png');
    await tick();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'ready', path: '/fresh.png' });
  });

  it('ignores an answer that arrives after a retry began', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const res = draft.snapshot().images[0]?.res as string;
    calls[0]?.fail();
    await tick();
    draft.retry(res);
    calls[0]?.ok('/stale.png'); // already settled: no effect
    await tick();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'uploading' });
    calls[1]?.ok('/fresh.png');
    await tick();
    expect(draft.snapshot().images[0]?.path).toBe('/fresh.png');
  });
});

describe('resolve', () => {
  it('waits for every upload and returns the text with markers in document order', async () => {
    const { draft, calls } = harness({ label: 'x' });
    draft.replace(0, 0, 'see  and .');
    draft.addImages([png('a.png')], [4, 4]);
    draft.addImages([png('b.png')], [11, 11]);
    expect(draft.doc.text).toBe(`see ${IMG} and .${IMG}`);
    const p = draft.resolve();
    // The second finishes first: numbering follows the document, not the completion.
    calls[1]?.ok('/d/b.png');
    await tick();
    let settled = false;
    void p.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    calls[0]?.ok('/d/a.png');
    const r = ok(await p);
    expect(r.text).toBe('see [Image #1: /d/a.png] and .[Image #2: /d/b.png]');
    expect(r.images.map((i) => i.n)).toEqual([1, 2]);
    expect(r.revision).toBe(draft.revision);
  });

  it('resolves at once for a draft with no images', async () => {
    const { draft } = harness();
    draft.replace(0, 0, 'just text');
    expect(ok(await draft.resolve()).text).toBe('just text');
  });

  it('fails, with the failed image and its marker number, when one upload fails; nothing to send', async () => {
    const { draft, calls } = harness();
    draft.addImages([png('a.png'), png('b.png')]);
    const p = draft.resolve();
    calls[0]?.ok();
    calls[1]?.fail('upload_too_large', 'over 25 MB');
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'upload', failed: [{ name: 'b.png', numbers: [2], message: 'over 25 MB', code: 'upload_too_large' }] });
    expect('text' in r).toBe(false);
    // The draft is untouched: both images still there.
    expect(draft.doc.chips).toHaveLength(2);
  });

  it('does not try a failed image again by itself: the user retries it, then resolve goes through', async () => {
    const { draft, calls } = harness();
    draft.addImages([png('a.png'), png('b.png')]);
    const first = draft.resolve();
    calls[0]?.ok('/d/a.png');
    calls[1]?.fail();
    expect((await first).ok).toBe(false);
    expect(calls).toHaveLength(2);
    // Again, at once: the same answer, no new request.
    expect(await draft.resolve()).toMatchObject({ ok: false, reason: 'upload', failed: [{ name: 'b.png' }] });
    expect(calls).toHaveLength(2);
    draft.retry(draft.snapshot().images[1]?.res as string);
    const second = draft.resolve();
    expect(calls).toHaveLength(3);
    calls[2]?.ok('/d/b.png');
    expect(ok(await second).text).toBe('[Image #1: /d/a.png][Image #2: /d/b.png]');
  });

  it('after a per-chip retry, resolve finds the image ready and sends nothing again', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const first = draft.resolve();
    calls[0]?.fail();
    await first;
    draft.retry(draft.snapshot().images[0]?.res as string);
    calls[1]?.ok('/d/a.png');
    await tick();
    expect(ok(await draft.resolve()).text).toBe('[Image #1: /d/a.png]');
    expect(calls).toHaveLength(2);
  });

  it('uploads an image that is pending behind the concurrency limit', async () => {
    const { draft, calls } = harness();
    draft.addImages([png(), png(), png()]);
    const p = draft.resolve();
    for (let i = 0; i < 3; i++) {
      await tick();
      calls[i]?.ok(`/d/${i}.png`);
    }
    expect(ok(await p).images.map((i) => i.path)).toEqual(['/d/0.png', '/d/1.png', '/d/2.png']);
  });

  it('one upload serves two chips of the same image', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const im = draft.snapshot().images[0];
    // The same resource twice (what undoing a delete of a duplicated chip looks like): build the doc by hand.
    draft.fromEditor({ text: `${IMG}-${IMG}`, chips: [{ occ: 'x1', res: im?.res as string }, { occ: 'x2', res: im?.res as string }] }, caret(3));
    const p = draft.resolve();
    calls[0]?.ok('/d/a.png');
    expect(ok(await p).text).toBe('[Image #1: /d/a.png]-[Image #2: /d/a.png]');
    expect(calls).toHaveLength(1);
  });

  it('is an error, not text, when the path would break the marker', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const p = draft.resolve();
    calls[0]?.ok('/d/a].png');
    expect(await p).toMatchObject({ ok: false, reason: 'serialize', error: { kind: 'bad_path' } });
  });

  it('is an error when the text with the markers is over the cap', async () => {
    const { draft, calls } = harness();
    draft.replace(0, 0, 'x'.repeat(30));
    draft.addImages([png()]);
    const p = draft.resolve({ maxBytes: 40 });
    calls[0]?.ok('/d/a.png');
    expect(await p).toMatchObject({ ok: false, reason: 'serialize', error: { kind: 'too_long', max: 40 } });
  });

  it('serialises the document as it was when it was called, and reports that revision', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const rev = draft.revision;
    const p = draft.resolve();
    draft.replace(draft.doc.text.length, draft.doc.text.length, ' edited');
    calls[0]?.ok('/d/a.png');
    const r = ok(await p);
    expect(r.text).toBe('[Image #1: /d/a.png]');
    expect(r.revision).toBe(rev);
    expect(draft.revision).toBeGreaterThan(rev);
    expect(draft.clearIf(r.revision)).toBe(false);
  });

  it('a removal during the wait does not cancel an upload the resolve is waiting for', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    const p = draft.resolve();
    draft.removeChip(draft.snapshot().images[0]?.occ as string);
    expect(calls[0]?.signal.aborted).toBe(false);
    calls[0]?.ok('/d/a.png');
    expect(ok(await p).text).toBe('[Image #1: /d/a.png]');
  });

  it('reports disposed if the draft goes while it waits', async () => {
    const { draft } = harness();
    draft.addImages([png()]);
    const p = draft.resolve();
    draft.dispose();
    expect(await p).toMatchObject({ ok: false, reason: 'disposed' });
  });
});

describe('history', () => {
  it('undoes and redoes text and images as one history', () => {
    let t = 0;
    const { draft } = harness({ now: () => (t += 5000) });
    draft.replace(0, 0, 'ab');
    draft.addImages([png()], [1, 1]);
    draft.replace(0, 0, 'X');
    expect(draft.doc.text).toBe(`Xa${IMG}b`);
    expect(draft.undo()).toBe(true);
    expect(draft.doc.text).toBe(`a${IMG}b`);
    expect(draft.undo()).toBe(true);
    expect(draft.doc.text).toBe('ab');
    expect(draft.redo()).toBe(true);
    expect(draft.doc.text).toBe(`a${IMG}b`);
    expect(draft.redo()).toBe(true);
    expect(draft.redo()).toBe(false);
    expect(draft.doc.text).toBe(`Xa${IMG}b`);
  });

  it('restores the caret each step left', () => {
    const { draft } = harness({ now: () => 0 });
    draft.replace(0, 0, 'abc');
    draft.replace(1, 1, 'XY');
    expect(draft.selection).toEqual(caret(3));
    draft.undo();
    expect(draft.selection).toEqual(caret(3));
    draft.undo();
    expect(draft.selection).toEqual(caret(0));
  });

  it('typing within the coalescing window is one step; a pause or another kind of edit starts a new one', () => {
    let t = 0;
    const { draft } = harness({ now: () => t, coalesceMs: 1000 });
    draft.fromEditor({ text: 'h', chips: [] }, caret(1));
    t = 100;
    draft.fromEditor({ text: 'he', chips: [] }, caret(2));
    t = 200;
    draft.fromEditor({ text: 'hel', chips: [] }, caret(3));
    t = 5000;
    draft.fromEditor({ text: 'help', chips: [] }, caret(4));
    draft.undo();
    expect(draft.doc.text).toBe('hel');
    draft.undo();
    expect(draft.doc.text).toBe('');
    draft.redo();
    draft.redo();
    // An image is its own step, and typing after it does not fold into it.
    t = 6000;
    draft.addImages([png()]);
    t = 6100;
    draft.fromEditor({ text: `help${IMG}!`, chips: draft.doc.chips }, caret(6));
    draft.undo();
    expect(draft.doc.text).toBe(`help${IMG}`);
    draft.undo();
    expect(draft.doc.text).toBe('help');
  });

  it('a new edit drops the redo tail; an edit that changes nothing is no step', () => {
    const { draft } = harness({ now: () => 0 });
    draft.replace(0, 0, 'a');
    draft.replace(1, 1, 'b');
    draft.undo();
    draft.replace(1, 1, 'c');
    expect(draft.canRedo).toBe(false);
    const rev = draft.revision;
    expect(draft.fromEditor(draft.doc, caret(0))).toBe(false);
    expect(draft.revision).toBe(rev);
  });

  it('keeps at most historyLimit steps', () => {
    const { draft } = harness({ historyLimit: 3, now: () => 0 });
    for (const ch of 'abcde') draft.replace(draft.doc.text.length, draft.doc.text.length, ch);
    let n = 0;
    while (draft.undo()) n++;
    expect(n).toBe(3);
    expect(draft.doc.text).toBe('ab');
  });

  it('undo of an image removal brings back the same image with its upload', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    calls[0]?.ok('/d/a.png');
    await tick();
    draft.removeChip(draft.snapshot().images[0]?.occ as string);
    expect(draft.doc.chips).toHaveLength(0);
    draft.undo();
    expect(draft.snapshot().images[0]).toMatchObject({ status: 'ready', path: '/d/a.png' });
    expect(calls).toHaveLength(1);
  });
});

describe('lifetime of the bytes', () => {
  it('keeps the object URL while history can bring the image back, and pins hold it longer', () => {
    const { draft, urls } = harness({ historyLimit: 2, now: () => 0 });
    draft.addImages([png()]);
    const im = draft.snapshot().images[0];
    expect(urls.size).toBe(1);
    draft.removeChip(im?.occ as string);
    expect(urls.size).toBe(1); // undo can restore it
    const unpin = draft.pin(im?.res as string);
    draft.replace(0, 0, 'a');
    draft.replace(0, 0, 'b');
    draft.replace(0, 0, 'c'); // the step with the image is gone from history now
    expect(urls.size).toBe(1); // ...but a preview shows it
    unpin();
    expect(urls.size).toBe(0);
    expect(draft.resourceCount).toBe(0);
  });

  it('a pin is released once, however often unpin is called, and two pins need two releases', () => {
    const { draft, urls } = harness({ historyLimit: 1, now: () => 0 });
    draft.addImages([png()]);
    const res = draft.snapshot().images[0]?.res as string;
    const a = draft.pin(res);
    const b = draft.pin(res);
    draft.removeChip(draft.snapshot().images[0]?.occ as string);
    draft.replace(0, 0, 'x');
    a();
    a();
    expect(urls.size).toBe(1);
    b();
    expect(urls.size).toBe(0);
  });

  it('clear releases everything and cancels uploads; clearIf only when nothing changed', () => {
    const { draft, calls, urls } = harness();
    draft.addImages([png(), png()]);
    const rev = draft.revision;
    expect(draft.clearIf(rev + 1)).toBe(false);
    expect(draft.doc.chips).toHaveLength(2);
    expect(draft.clearIf(rev)).toBe(true);
    expect(draft.doc.text).toBe('');
    expect(urls.size).toBe(0);
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    expect(draft.canUndo).toBe(false);
  });

  it('dispose cancels uploads, revokes every URL and ignores what arrives after', async () => {
    const { draft, calls, urls } = harness();
    draft.addImages([png()]);
    draft.dispose();
    expect(urls.size).toBe(0);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.ok();
    await tick();
    expect(draft.resourceCount).toBe(0);
    expect(draft.addImages([png()]).added).toBe(1); // no crash; nothing is uploaded
    expect(calls).toHaveLength(1);
  });

  it('survives an editor being closed: the draft keeps text, caret, images and paths', async () => {
    const { draft, calls } = harness();
    draft.replace(0, 0, 'first task ');
    draft.addImages([png()]);
    calls[0]?.ok('/d/a.png');
    await tick();
    const snap = draft.snapshot();
    // (the view is gone; the draft is what the host holds)
    expect(snap.text).toBe('first task ');
    expect(snap.images[0]).toMatchObject({ status: 'ready', path: '/d/a.png' });
    expect(snap.selection).toEqual(caret(12));
    expect(ok(await draft.resolve()).text).toBe('first task [Image #1: /d/a.png]');
  });
});

describe('subscribe', () => {
  it('tells the view when to redraw the document and when only a chip changed', async () => {
    const { draft, calls } = harness();
    const seen: string[] = [];
    const off = draft.subscribe((e) => seen.push(e.kind === 'doc' ? `doc:${e.origin}` : 'res'));
    draft.fromEditor({ text: 'a', chips: [] }, caret(1));
    draft.addImages([png()]);
    calls[0]?.ok();
    await tick();
    draft.undo();
    off();
    draft.undo();
    expect(seen).toEqual(['doc:dom', 'res', 'doc:api', 'res', 'doc:history']);
  });
});

describe('replaceAll (#64: a generated prompt with the markers of images already uploaded elsewhere)', () => {
  const uploaded = async () => {
    const src = harness();
    src.draft.addImages([png('a.png'), png('b.png')]);
    await tick();
    src.calls[0]!.ok('/drops/a 1.png');
    src.calls[1]!.ok('/drops/b.png');
    await tick();
    return src.draft;
  };

  it('turns the markers of ready images of the source into ready chips, without uploading, and keeps other markers as text', async () => {
    const from = await uploaded();
    const { draft, calls } = harness();
    const text = 'See [Image #1: /drops/a 1.png] and [Image #2: /drops/b.png], not [Image #3: /elsewhere.png].';
    expect(draft.replaceAll(text, from)).toBe(true);
    expect(draft.doc.text).toBe(`See ${IMG} and ${IMG}, not [Image #3: /elsewhere.png].`);
    expect(draft.snapshot().images.map((i) => [i.n, i.name, i.status, i.path])).toEqual([[1, 'a.png', 'ready', '/drops/a 1.png'], [2, 'b.png', 'ready', '/drops/b.png']]);
    expect(calls).toHaveLength(0);
    expect(draft.selection).toEqual(caret(draft.doc.text.length));
    const r = ok(await draft.resolve({ maxBytes: 1000 }));
    // The chips serialise to the same markers, numbered by document order.
    expect(r.text).toBe('See [Image #1: /drops/a 1.png] and [Image #2: /drops/b.png], not [Image #3: /elsewhere.png].');
  });

  it('is not an undo step, replaces the last one, and does nothing (no event) when nothing would change', async () => {
    const from = await uploaded();
    const { draft } = harness();
    const seen: string[] = [];
    draft.subscribe((e) => seen.push(e.kind));
    draft.replaceAll('one [Image #1: /drops/b.png]', from);
    expect(draft.canUndo).toBe(false);
    draft.replaceAll('two', from);
    expect(draft.doc.text).toBe('two');
    expect(draft.canUndo).toBe(false);
    expect(draft.resourceCount).toBe(0);
    const n = seen.length;
    expect(draft.replaceAll('two', from)).toBe(false);
    expect(seen).toHaveLength(n);
  });

  it('a marker whose image is not ready in the source stays text; the same path twice is two chips of one resource', async () => {
    const src = harness();
    src.draft.addImages([png('a.png'), png('b.png')]);
    await tick();
    src.calls[0]!.ok('/drops/a.png'); // b is still uploading
    await tick();
    const { draft } = harness();
    draft.replaceAll('[Image #1: /drops/a.png] [Image #2: /drops/a.png] [Image #3: /drops/b.png]', src.draft);
    expect(draft.doc.chips).toHaveLength(2);
    expect(imagesOf(draft.doc)[0]!.res).toBe(imagesOf(draft.doc)[1]!.res);
    expect(draft.doc.text).toBe(`${IMG} ${IMG} [Image #3: /drops/b.png]`);
  });

  it('releases the images of the document it replaces', async () => {
    const from = await uploaded();
    const { draft, urls } = harness();
    draft.replaceAll('[Image #1: /drops/a 1.png]', from);
    expect(urls.size).toBe(1);
    draft.replaceAll('nothing', from);
    expect(urls.size).toBe(0);
  });
});

describe('holdRefused (#64: a refused file holds the prompt until the user dismisses it)', () => {
  const pdf = () => new File(['x'], 'notes.pdf', { type: 'application/pdf' });

  it('holds the refusal, keeps the text and the good files, and will not resolve', async () => {
    const { draft, calls } = harness({ holdRefused: true });
    draft.replace(0, 0, 'look at this');
    const r = draft.addImages([png('a.png'), pdf()]);
    expect(r.added).toBe(1);
    expect(draft.refusal).toBe('notes.pdf is not a PNG, JPEG, GIF or WebP image.');
    expect(draft.snapshot().refusal).toBe(draft.refusal);
    const res = await draft.resolve();
    expect(res).toMatchObject({ ok: false, reason: 'refused', message: 'notes.pdf is not a PNG, JPEG, GIF or WebP image.' });
    expect(calls).toHaveLength(1); // the refused resolve did not wait for, or start, anything it did not need
    expect(draft.doc.text).toContain('look at this');
  });

  it('holds a file over the size limit and an overflow of the image limit the same way', async () => {
    const { draft } = harness({ holdRefused: true, maxImages: 1 });
    draft.addImages([png('a.png'), png('b.png')]);
    expect(draft.refusal).toBe('You can attach up to 1 images to one prompt.');
    draft.dismissRefusal();
    const huge = png('huge.png');
    Object.defineProperty(huge, 'size', { value: UPLOAD_MAX_BYTES + 1 });
    draft.addImages([huge]);
    expect(draft.refusal).toMatch(/^huge\.png is /);
    expect((await draft.resolve()).ok).toBe(false);
  });

  it('dismiss is the explicit resolution: it announces once, then the draft resolves with the text', async () => {
    const { draft } = harness({ holdRefused: true });
    const seen: string[] = [];
    draft.subscribe((e) => e.kind === 'refusal' && seen.push(draft.refusal ?? 'gone'));
    draft.replace(0, 0, 'text only');
    draft.addImages([pdf()]);
    expect(draft.dismissRefusal()).toBe(true);
    expect(draft.dismissRefusal()).toBe(false);
    expect(seen).toEqual(['notes.pdf is not a PNG, JPEG, GIF or WebP image.', 'gone']);
    expect(ok(await draft.resolve()).text).toBe('text only');
  });

  it('a second refusal adds to the first; typing and plain text change nothing about it', async () => {
    const { draft } = harness({ holdRefused: true });
    draft.addImages([pdf()]);
    draft.addImages([new File(['x'], 'a.svg', { type: 'image/svg+xml' })]);
    draft.replace(0, 0, 'typing goes on');
    expect(draft.refusal).toContain('notes.pdf');
    expect(draft.refusal).toContain('a.svg');
    expect(draft.doc.text).toBe('typing goes on');
  });

  it('a refusal made after a send snapshot survives that send’s clearIf; the sent text and images still go', async () => {
    const { draft } = harness({ holdRefused: true });
    draft.replace(0, 0, 'first');
    const sent = ok(await draft.resolve());
    draft.addImages([pdf()]); // made while the send is pending: the revision is the same, the refusal is newer
    expect(draft.revision).toBe(sent.revision);
    expect(draft.clearIf(sent.revision)).toBe(true);
    expect(draft.doc.text).toBe('');
    expect(draft.refusal).toBe('notes.pdf is not a PNG, JPEG, GIF or WebP image.');
    expect(await draft.resolve()).toMatchObject({ ok: false, reason: 'refused' });
    expect(draft.dismissRefusal()).toBe(true);
    expect(ok(await draft.resolve()).text).toBe('');
  });

  it('clearIf without a held refusal is unchanged, and clear() still drops a refusal', () => {
    const { draft } = harness({ holdRefused: true });
    draft.replace(0, 0, 'x');
    expect(draft.clearIf(draft.revision)).toBe(true);
    draft.addImages([pdf()]);
    const seen: string[] = [];
    draft.subscribe((e) => e.kind === 'refusal' && seen.push('refusal'));
    draft.clearIf(draft.revision);
    expect(seen).toEqual([]); // the held refusal is not announced as gone
    draft.clear();
    expect(draft.refusal).toBeNull();
    expect(seen).toEqual(['refusal']);
  });

  it('is cleared with the draft (a sent prompt) and is off by default', async () => {
    const held = harness({ holdRefused: true });
    held.draft.addImages([pdf()]);
    held.draft.clear();
    expect(held.draft.refusal).toBeNull();
    const plain = harness();
    plain.draft.replace(0, 0, 'hire');
    plain.draft.addImages([pdf()]);
    expect(plain.draft.refusal).toBeNull();
    expect(ok(await plain.draft.resolve()).text).toBe('hire');
  });
});

describe('file chips (#141)', () => {
  const file = (path: string, dir = false) => ({ kind: 'file' as const, path, dir });

  it('insertParts puts a chip and the text after it in one step, the caret after both', () => {
    const { draft } = harness();
    draft.replace(0, 0, 'see @comp now');
    draft.insertParts(4, 9, [file('game/src/ui/composer.ts'), ' ']);
    expect(draft.doc.text).toBe(`see ${IMG}  now`);
    expect(draft.selection).toEqual(caret(6));
    expect(draft.snapshot().files).toEqual([{ occ: draft.doc.chips[0]?.occ, path: 'game/src/ui/composer.ts', dir: false }]);
    draft.undo();
    expect(draft.doc.text).toBe('see @comp now');
    draft.redo();
    expect(draft.snapshot().files.map((f) => f.path)).toEqual(['game/src/ui/composer.ts']);
  });

  it('numbers images among images only and counts only images toward the limit', () => {
    const { draft } = harness({ maxImages: 2 });
    draft.insertParts(0, 0, [file('a.ts'), file('b.ts'), file('c.ts')]);
    draft.addImages([png('one.png')]);
    draft.insertParts(4, 4, [file('d.ts')]);
    expect(draft.addImages([png('two.png'), png('three.png')]).added).toBe(1);
    const s = draft.snapshot();
    expect(s.images.map((i) => [i.n, i.name])).toEqual([[1, 'one.png'], [2, 'two.png']]);
    expect(draft.numberOf(s.images[1]!.occ)).toBe(2);
    expect(draft.numberOf(s.files[0]!.occ)).toBe(0);
    // Replacing a selection that holds an image frees its room; one that holds only files does not.
    expect(draft.addImages([png('x.png')], [0, 1]).added).toBe(0);
    expect(draft.addImages([png('y.png')], [3, 4]).added).toBe(1);
  });

  it('removeChip takes a file chip out as one step; the images keep uploading', async () => {
    const { draft, calls } = harness();
    draft.addImages([png()]);
    draft.insertParts(1, 1, [' ', file('a.ts')]);
    await tick();
    draft.removeChip(draft.snapshot().files[0]!.occ);
    expect(draft.doc.text).toBe(`${IMG} `);
    expect(calls[0]?.signal.aborted).toBe(false);
    draft.undo();
    expect(draft.snapshot().files).toHaveLength(1);
  });

  it('a file chip has no resource: nothing to upload, and resolve sends its mention at once', async () => {
    const { draft, calls } = harness();
    draft.insertParts(0, 0, ['fix ', file('my docs/a b.md'), 'please']);
    expect(draft.resourceCount).toBe(0);
    const r = ok(await draft.resolve({ maxBytes: 100 }));
    expect(r.text).toBe('fix @"my docs/a b.md" please');
    expect(calls).toHaveLength(0);
  });

  it('a failed image is numbered among images, whatever file chips come before it', async () => {
    const { draft, calls } = harness();
    draft.insertParts(0, 0, [file('a.ts')]);
    draft.addImages([png('bad.png')]);
    const p = draft.resolve();
    await tick();
    calls[0]?.fail();
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'upload', failed: [{ name: 'bad.png', numbers: [1] }] });
  });

  it('the cap counts the mentions', async () => {
    const { draft } = harness();
    draft.insertParts(0, 0, ['x', file('abc')]); // 'x @abc' = 6 bytes
    expect((await draft.resolve({ maxBytes: 6 })).ok).toBe(true);
    expect(await draft.resolve({ maxBytes: 5 })).toMatchObject({ ok: false, reason: 'serialize', error: { kind: 'too_long', bytes: 6 } });
  });

  it('an edit that only changes a chip’s path is an edit (history sees it)', () => {
    const { draft } = harness();
    draft.insertParts(0, 0, [file('a.ts')]);
    const occ = draft.doc.chips[0]!.occ;
    expect(draft.fromEditor({ text: IMG, chips: [{ kind: 'file', occ, path: 'b.ts', dir: false }] }, caret(1))).toBe(true);
    draft.undo();
    expect(draft.snapshot().files[0]?.path).toBe('a.ts');
  });

  it('hydrate makes the parts the document, no history behind it, the caret at the end', () => {
    const { draft } = harness();
    const events: string[] = [];
    draft.subscribe((e) => events.push(e.kind));
    expect(draft.hydrate(['see ', file('src/ui', true), ' now'])).toBe(true);
    expect(draft.doc.text).toBe(`see ${IMG} now`);
    expect(draft.selection).toEqual(caret(9));
    expect(draft.canUndo).toBe(false);
    expect(events).toEqual(['doc']);
    expect(draft.hydrate(['see ', file('src/ui', true), ' now'])).toBe(false);
    expect(draft.hydrate(['see ', file('src/ui', false), ' now'])).toBe(true);
  });
});
