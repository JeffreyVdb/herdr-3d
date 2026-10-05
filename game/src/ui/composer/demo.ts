/**
 * TEST ONLY. `/?composer-demo&ws=...` mounts the composer in a dialog shaped like the hire dialog, with no game behind
 * it, so Playwright can drive paste, the preview and the upload path in real Chromium (e2e/composer.spec.ts). The
 * bundle loads this module only when that parameter is present; nothing else imports it.
 *
 * `window.__h3dComposer` gives the spec the composer, its draft and what the host dialog saw.
 *
 * #139: the composer completes with two stub sources (e2e/composer-complete.spec.ts): `/` lists a few commands, at once;
 * `@` lists made-up files after `stub.delayMs` (per query: `stub.delays[query]`, to make a reply arrive late), or fails
 * while `stub.fail` is set. `stub.asked` logs every `@` query and whether its signal was aborted.
 */

import { bridgeUrl } from '../../net/endpoint';
import { postUpload } from '../../net/upload';
import { h, ICON, icon } from '../dom';
import type { Source } from './complete';
import { Draft, type ResolveResult } from './draft';
import { mountComposer, type Composer } from './composer';
import { HIRE_PROMPT_MAX_BYTES } from './model';
import './demo.css';

export interface ComposerDemo {
  composer: Composer;
  draft: Draft;
  dialog: HTMLDialogElement;
  /** What the host dialog saw, in order: `cancel`, `close`, `submit`. */
  events: string[];
  last: ResolveResult | null;
  send(): Promise<ResolveResult>;
  open(): void;
  close(): void;
  stub: CompleteStub;
}

export interface CompleteStub {
  delayMs: number;
  delays: Record<string, number>;
  fail: boolean;
  asked: Array<{ query: string; aborted: boolean }>;
}

const COMMANDS = [
  { name: 'help', about: 'What the agent can do' },
  { name: 'clear', about: 'Start a new conversation' },
  { name: 'compact', about: 'Summarise the conversation so far' },
  { name: 'review', about: 'Review the changes on this branch' },
  { name: 'model', about: 'Pick the model' },
  { name: 'cost', about: 'What this session has cost' },
];
const FILES = ['src/main.ts', 'src/ui/composer/composer.ts', 'src/ui/composer/My Notes.md', 'docs/shortcuts.md', 'docs/decisions.md', 'README.md', 'CONTRIBUTING.md', 'game/e2e/composer.spec.ts'];

function stubSources(stub: CompleteStub): Source[] {
  const commands: Source<(typeof COMMANDS)[number]> = {
    trigger: '/',
    label: 'Commands',
    items: (q) => COMMANDS.filter((c) => c.name.startsWith(q.toLowerCase())),
    render: (c) => h('span', { class: 'cmp-demo-cmd' }, h('b', {}, `/${c.name}`), h('span', {}, c.about)),
    insert: (c) => ({ text: `/${c.name} ` }),
  };
  const files: Source<string> = {
    trigger: '@',
    label: 'Files',
    items: (q, signal) => {
      const entry = { query: q, aborted: false };
      stub.asked.push(entry);
      signal.addEventListener('abort', () => (entry.aborted = true));
      const ms = stub.delays[q] ?? stub.delayMs;
      return new Promise((resolve, reject) =>
        setTimeout(() => (stub.fail ? reject(new Error('stub: failed')) : resolve(FILES.filter((f) => f.toLowerCase().includes(q.toLowerCase())))), ms),
      );
    },
    render: (f) => f,
    insert: (f) => ({ text: `@${f} ` }),
  };
  return [commands, files];
}

declare global {
  interface Window {
    __h3dComposer?: ComposerDemo;
  }
}

export function mountDemo(): void {
  const wsUrl = bridgeUrl(window.location, null);
  const events: string[] = [];
  const draft = new Draft({
    upload: (file, hint, signal) => postUpload(wsUrl, file, hint, signal),
    label: 'demo',
    maxPromptBytes: HIRE_PROMPT_MAX_BYTES,
  });
  const stub: CompleteStub = { delayMs: 150, delays: {}, fail: false, asked: [] };
  const out = h('pre', { class: 'cmp-demo-out', id: 'cmp-out', 'aria-live': 'polite' });

  const send = async (): Promise<ResolveResult> => {
    events.push('submit');
    composer.setBusy(true);
    const r = await composer.resolve();
    composer.setBusy(false);
    demo.last = r;
    out.textContent = r.ok ? r.text : JSON.stringify(r.reason === 'upload' ? r.failed.map((f) => `${f.name}: ${f.message}`) : r);
    return r;
  };

  const composer = mountComposer({
    draft,
    ariaLabel: 'First task',
    placeholder: 'Describe the first task…',
    onSubmit: () => void send(),
    complete: { sources: stubSources(stub) },
  });
  const close = h('button', { class: 'btn', 'aria-label': 'Close', id: 'cmp-close', onclick: () => dialog.close() }, icon(ICON.close));
  const dialog = h(
    'dialog',
    { class: 'desk-dlg cmp-demo', 'aria-labelledby': 'cmp-title' },
    h('div', { class: 'dd-head' }, h('div', { class: 'dd-titles' }, h('h2', { id: 'cmp-title' }, 'Composer')), close),
    h('div', { class: 'cmp-demo-body' }, composer.element),
    h('div', { class: 'cmp-demo-foot' }, out, h('button', { class: 'btn btn--primary', id: 'cmp-send', onclick: () => void send() }, 'Send')),
  );
  dialog.addEventListener('cancel', () => events.push('cancel'));
  dialog.addEventListener('close', () => events.push('close'));
  const reopen = h('button', { class: 'btn cmp-demo-reopen', id: 'cmp-reopen', onclick: () => open() }, 'Open composer');
  document.body.append(dialog, reopen);

  const open = (): void => {
    if (!dialog.open) dialog.showModal();
    composer.focus();
  };
  const demo: ComposerDemo = { composer, draft, dialog, events, last: null, send, open, close: () => dialog.close(), stub };
  window.__h3dComposer = demo;
  open();
}
