// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../net/protocol';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';
import type { PendingPrompt } from './transcriptActivity';

// #108 round 4: the bridge's references to protected files in the conversation, as masked chips that open the file
// popover (#31) with their path.

const DIR = '/run/user/1000/herdr-world/secrets';
const OWNER = 'PUKNXUKGN2LDLHO5W4FFT6Z6TW';
const A = `${DIR}/${OWNER}/MZEWFPEUANUI7A3AAWZIDF6AXG`;
const B = `${DIR}/${OWNER}/L3AQJP4CGRRIXWQ35AQI4MXEWR`;
const ref = (p: string) => `[secret in file ${p}]`;

let container: HTMLDivElement;
let view: TranscriptView;
let seq = 0;
const item = (kind: TranscriptItem['kind'], extra: Partial<TranscriptItem> = {}): TranscriptItem => {
  seq++;
  return { id: `i${seq}`, seq, ts: 1_700_000_000_000 + seq * 1000, kind, ...extra };
};
const text = (t: string) => ({ text: t });
const flush = async () => {
  for (let n = 0; n < 5; n++) await Promise.resolve();
};

function mount(dir: string | null = DIR) {
  const copied: string[] = [];
  const host: TranscriptRenderHost = {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => {},
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => {},
    loadSubagent: async () => [],
    copy: (t) => {
      copied.push(t);
      return Promise.resolve(true);
    },
    secretsDir: () => dir,
  } as TranscriptRenderHost;
  view = mountTranscript(container, host);
  return { copied };
}
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const chips = (root: ParentNode = container) => [...root.querySelectorAll<HTMLElement>('.secret-chip')];
const pend = (id: string, t: string, extra: Partial<PendingPrompt> = {}): PendingPrompt => ({ id, text: t, state: 'sent', late: false, mark: 0, due: null, ...extra });

beforeEach(() => {
  seq = 0;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  container.remove();
});

describe('the conversation’s protected-file chips (#108)', () => {
  it('a sent prompt’s exact references are chips, each opening the file popover with its path and Copy', async () => {
    const { copied } = mount();
    view.setItems([item('user', { parts: [text(`Deploy with TOKEN=${ref(A)} and PASSWORD=${ref(B)}; done.`)] })]);
    const cs = chips();
    expect(cs.map((c) => c.dataset.txFile)).toEqual([A, B]);
    expect(cs.every((c) => c.classList.contains('tx-file-ref') && c.getAttribute('role') === 'button')).toBe(true);
    // The prompt reads as typed around them; no path on screen.
    const bubble = $('.tx-user .tx-md') as HTMLElement;
    const seen = bubble.cloneNode(true) as HTMLElement;
    seen.querySelectorAll('.secret-chip-ref').forEach((x) => x.remove());
    expect(seen.textContent?.trim()).toBe('Deploy with TOKEN=protected file and PASSWORD=protected file; done.');
    (cs[1] as HTMLElement).click();
    const pop = $('.tx-fref') as HTMLElement;
    expect(pop.hidden).toBe(false);
    expect($('.tx-fref-path')?.textContent).toBe(B);
    ($('.tx-fref-copy') as HTMLButtonElement).click();
    await flush();
    expect(copied).toEqual([B]);
  });

  it('text that only looks like one stays text; another directory too while the bridge says its own', () => {
    mount();
    const fake = `[secret in file /tmp/x] and ${ref(`/srv/x/${OWNER}/${OWNER}`)}`;
    view.setItems([item('user', { parts: [text(fake)] })]);
    expect(chips()).toEqual([]);
    expect($('.tx-user .tx-md')?.textContent?.trim()).toBe(fake);
  });

  it('an older bridge (no directory): the shape alone makes a chip', () => {
    mount(null);
    view.setItems([item('user', { parts: [text(`x ${ref(`/srv/x/${OWNER}/${OWNER}`)}`)] })]);
    expect(chips().map((c) => c.dataset.txFile)).toEqual([`/srv/x/${OWNER}/${OWNER}`]);
  });

  it('the agent quoting one, an answer that holds one, and a code block (left as typed)', () => {
    mount();
    view.setItems([
      item('assistant', { parts: [text(`I read \`${ref(A)}\`.\n\n\`\`\`\n${ref(B)}\n\`\`\``)] }),
      item('user', { parts: [text('<answers/>')], answers: [{ question: 'Which token?', answer: `use ${ref(B)}` }] }),
    ]);
    const said = $('.tx-assistant') as HTMLElement;
    expect(chips(said).map((c) => c.dataset.txFile)).toEqual([A]);
    expect(said.querySelector('pre')?.textContent).toContain(ref(B));
    expect(chips($('.tx-answer') as HTMLElement).map((c) => c.dataset.txFile)).toEqual([B]);
  });

  it('the pending row: the prompt as sent with its references as chips; the review’s [secret] placeholders stay words', () => {
    mount();
    view.setPending([pend('p1', `go ${ref(A)}`)]);
    expect(chips($('.tx-pending') as HTMLElement).map((c) => c.dataset.txFile)).toEqual([A]);
    // Before the bridge said what it sent: the masked row, no chip and no value.
    view.setPending([pend('p2', 'go hunter2', { state: 'sending', shown: 'go [secret]' })]);
    const row = $('[data-pending="p2"]') as HTMLElement;
    expect(chips(row)).toEqual([]);
    expect(row.querySelector('.tx-md')?.textContent?.trim()).toBe('go [secret]');
    // The ack's `sent` takes the row: chips now.
    view.setPending([pend('p2', 'go hunter2', { shown: `go ${ref(B)}`, sent: `go ${ref(B)}` })]);
    expect(chips($('[data-pending="p2"]') as HTMLElement).map((c) => c.dataset.txFile)).toEqual([B]);
  });
});
