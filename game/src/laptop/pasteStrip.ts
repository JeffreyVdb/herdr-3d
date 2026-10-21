// Plain erasable TypeScript: the fixture server (node) imports it too.
/** Bracketed paste's markers (DECSET 2004), as herdr's `PasteStart` and `PasteEnd`. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * #176 part 2: a paste's text as the bridge takes it for `worker.paste` (`herdr.PasteStrip`, pinned by the same
 * vectors): NUL and the paste markers removed, until none is left (taking one out may join another). Its secrets are
 * reviewed on this text, the text the bridge scans.
 */
export function pasteStrip(text: string): string {
  let t = text.replaceAll('\u0000', '');
  while (t.includes(PASTE_START) || t.includes(PASTE_END)) t = t.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
  return t;
}
