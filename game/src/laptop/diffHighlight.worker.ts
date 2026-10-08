/**
 * #206: tokenizes the hunks too large to colour on the page's thread (a created 2,000-line file is one hunk: ~100 ms of
 * highlight.js). Its own lazy chunk with its own highlight.js, made the first time such a hunk shows.
 *
 * In: `{id, lang, old, neu}`. Out: `{id, tokens}`, `tokens` null when the hunk could not be tokenized.
 */
import hljs from 'highlight.js/lib/common';
import { tokenizeHunk, type HunkTokens } from './diffTokens';

export interface DiffHlRequest {
  id: number;
  lang: string;
  old: string;
  neu: string;
}

export interface DiffHlReply {
  id: number;
  tokens: HunkTokens | null;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<DiffHlRequest>) => void) | null; postMessage(m: DiffHlReply): void };
const highlight = (text: string, language: string) => hljs.highlight(text, { language, ignoreIllegals: true }).value;

scope.onmessage = (e) => {
  const { id, lang, old, neu } = e.data;
  scope.postMessage({ id, tokens: hljs.getLanguage(lang) ? tokenizeHunk(highlight, lang, old, neu) : null });
};
