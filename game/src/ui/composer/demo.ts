/**
 * TEST ONLY. `/?composer-demo&ws=...` mounts the composer in a dialog shaped like the hire dialog, with no game behind
 * it, so Playwright can drive paste, the preview and the upload path in real Chromium (e2e/composer.spec.ts). The
 * bundle loads this module only when that parameter is present; nothing else imports it.
 *
 * `window.__h3dComposer` gives the spec the composer, its draft and what the host dialog saw.
 */

import { bridgeUrl } from '../../net/endpoint';
import { postUpload } from '../../net/upload';
import { h, ICON, icon } from '../dom';
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
  const demo: ComposerDemo = { composer, draft, dialog, events, last: null, send, open, close: () => dialog.close() };
  window.__h3dComposer = demo;
  open();
}
