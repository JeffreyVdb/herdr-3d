// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { taskPreview } from '../world/hireReview';
import { chipSecretRefs, dialogChips, secretChip, secretPreviewNodes, secretRefLine, secretTextNodes, type SecretChipOptions } from './secretChips';

// #108 round 4: masked inline file chips for the bridge's references to protected files.

const DIR = '/run/user/1000/herdr-world/secrets';
const OWNER = 'PUKNXUKGN2LDLHO5W4FFT6Z6TW';
const A = `${DIR}/${OWNER}/MZEWFPEUANUI7A3AAWZIDF6AXG`;
const B = `${DIR}/${OWNER}/QQQQQQQQQQQQQQQQQQQQQQQQQQ`;
const ref = (p: string) => `[secret in file ${p}]`;

const flush = async () => {
  for (let n = 0; n < 5; n++) await Promise.resolve();
};
const chipsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('.secret-chip')];
/** What a reader sees: the chips' tape words, never a path. */
const seen = (el: Element) => {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('.secret-chip-ref').forEach((x) => x.remove());
  return c.textContent;
};

afterEach(() => document.body.replaceChildren());

describe('secret chips (#108)', () => {
  const copies: string[] = [];
  const copyOpts = (ok = true, said: Array<[string, boolean]> = []): SecretChipOptions =>
    dialogChips(DIR, (m, e) => said.push([m, e]), (t) => {
      copies.push(t);
      return Promise.resolve(ok);
    });

  it('a text becomes its text and a chip per exact reference; the chip says a protected file is there, its path on demand', () => {
    const p = document.createElement('p');
    p.append(...secretTextNodes(`Use ${ref(A)} and ${ref(B)}.`, copyOpts()));
    const chips = chipsIn(p);
    expect(chips.map((c) => c.dataset.secretRef)).toEqual([A, B]);
    expect(seen(p)).toBe('Use protected file and protected file.');
    const c = chips[0] as HTMLElement;
    expect(c.tagName).toBe('BUTTON');
    expect(c.getAttribute('aria-label')).toBe(`Protected file: ${A}. Copy its path`);
    expect(c.title).toContain(A);
    // A copy of a selection across it carries the reference as sent (the hidden text), not the tape's words.
    expect(c.querySelector('.secret-chip-ref')?.textContent).toBe(ref(A));
    expect(c.querySelector('.secret-chip-ref')?.getAttribute('aria-hidden')).toBe('true');
    expect(c.querySelector('.secret-chip-tape')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('look-alikes stay text; with the bridge’s directory known, another directory does too', () => {
    const t = `[secret in file /tmp/x] ${ref(`/srv/other/${OWNER}/${OWNER}`)} @${ref(A)}`;
    const known = document.createElement('p');
    known.append(...secretTextNodes(t, copyOpts()));
    expect(chipsIn(known)).toEqual([]);
    expect(known.textContent).toBe(t);
    // An older bridge says no directory: the shape alone, so the other absolute directory chips, the rest does not.
    const shape = document.createElement('p');
    shape.append(...secretTextNodes(t, { ...copyOpts(), dir: null }));
    expect(chipsIn(shape).map((c) => c.dataset.secretRef)).toEqual([`/srv/other/${OWNER}/${OWNER}`]);
  });

  it('a dialog chip copies its path, shows the check a moment, and the dialog says how it went (refused: the path, to select)', async () => {
    copies.length = 0;
    const said: Array<[string, boolean]> = [];
    const c = secretChip(A, copyOpts(true, said));
    document.body.append(c);
    c.click();
    await flush();
    expect(copies).toEqual([A]);
    expect(c.dataset.copied).toBe('true');
    expect(said).toEqual([['Path copied.', false]]);
    const refused = secretChip(B, copyOpts(false, said));
    refused.click();
    await flush();
    expect(said.at(-1)).toEqual([`The browser did not allow copying. The file’s path: ${B}`, true]);
    expect(refused.dataset.copied).toBe('false');
  });

  it('the transcript’s chips are its file references: the popover opens them (role button, the path as data)', () => {
    const c = secretChip(A, { dir: DIR, action: { kind: 'popover', cls: 'tx-file-ref' } });
    expect(c.tagName).toBe('SPAN');
    expect(c.classList.contains('tx-file-ref')).toBe(true);
    expect(c.getAttribute('role')).toBe('button');
    expect(c.getAttribute('tabindex')).toBe('0');
    expect(c.getAttribute('aria-haspopup')).toBe('dialog');
    expect(c.dataset.txFile).toBe(A);
    expect(c.getAttribute('aria-label')).toBe(`Protected file: ${A}`);
  });

  it('chips the text under an element, never inside a code block (the highlighter redraws it from its text), nor twice', () => {
    const md = document.createElement('div');
    md.innerHTML = `<p>a <code>${ref(A)}</code> b ${ref(B)}</p><pre><code>${ref(A)}</code></pre>`;
    const o: SecretChipOptions = { dir: DIR, action: { kind: 'popover', cls: 'tx-file-ref' } };
    expect(chipSecretRefs(md, o)).toBe(2);
    expect(chipsIn(md).map((c) => c.dataset.secretRef)).toEqual([A, B]);
    expect(md.querySelector('pre')?.textContent).toBe(ref(A));
    expect(chipSecretRefs(md, o)).toBe(0);
    expect(chipsIn(md)).toHaveLength(2);
  });

  it('a preview cuts whole references only: each is one inert chip (nothing to press inside a control), never half a path', () => {
    const task = `Deploy the service with TOKEN=${ref(A)} and the key ${ref(B)}, then open a pull request and tag the release notes properly.`;
    const nodes = secretPreviewNodes(task, DIR, taskPreview);
    const sum = document.createElement('span');
    sum.append(...nodes);
    const chips = chipsIn(sum);
    expect(chips.map((c) => c.dataset.secretRef)).toEqual([A, B]);
    expect(chips.every((c) => c.tagName === 'SPAN' && !c.hasAttribute('tabindex') && !c.hasAttribute('role'))).toBe(true);
    expect(seen(sum)).toBe(taskPreview(task.replace(ref(A), '').replace(ref(B), '')).replace(//g, 'protected file'));
    expect(seen(sum)).not.toContain(DIR);
    // A reference past the cut is gone with the rest, not shown in part.
    const long = `${'word '.repeat(30)}${ref(A)}`;
    const cut = document.createElement('span');
    cut.append(...secretPreviewNodes(long, DIR, taskPreview));
    expect(chipsIn(cut)).toEqual([]);
    expect(cut.textContent).not.toContain('[secret in file');
  });

  it('the line under a text box names the files its references point at, and hides while there are none', () => {
    const line = secretRefLine('refs', () => copyOpts());
    document.body.append(line.el);
    line.update('nothing here');
    expect(line.el.hidden).toBe(true);
    line.update(`go ${ref(A)}`);
    expect(line.el.hidden).toBe(false);
    expect(seen(line.el)).toBe('It refers to a protected file: protected file Keep each “[secret in file …]” as it is: the agent reads the value from that file.');
    line.update(`go ${ref(A)} ${ref(B)} [secret in file /tmp/x]`);
    expect(chipsIn(line.el).map((c) => c.dataset.secretRef)).toEqual([A, B]);
    expect(line.el.textContent).toContain('It refers to 2 protected files');
    line.update('');
    expect(line.el.hidden).toBe(true);
    expect(chipsIn(line.el)).toEqual([]);
  });
});
