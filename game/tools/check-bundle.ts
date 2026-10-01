// M13 (#15): proves the whiteboard's editor is not part of the game's start. It reads the Vite manifest of a build
// (dist/.vite/manifest.json), follows the entry's *static* imports only (what the browser loads before the game
// runs; dynamic imports load later, on demand), and fails when any of those chunks, or the entry's CSS, contains
// React, ReactDOM or Excalidraw: by the module they come from, and by markers in the built code itself. It also
// checks index.html preloads nothing of the editor, and prints the sizes (raw and gzip) of the start and of the
// editor for the pull request. `pnpm build` runs it after every build (package.json), so `make build` fails with it.
//
//   node tools/check-bundle.ts [dist]      (exit 1 with the reasons when the check fails)
//
// Plain erasable TypeScript: node runs it directly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}
export type Manifest = Record<string, ManifestChunk>;

/** Modules that must never load at start: the editor's own packages. */
export const FORBIDDEN_MODULES = [/node_modules\/(\.pnpm\/)?react@/, /node_modules\/(\.pnpm\/)?react-dom@/, /node_modules\/(\.pnpm\/)?@excalidraw\+/, /node_modules\/@excalidraw\//, /node_modules\/(\.pnpm\/)?scheduler@/, /src\/whiteboard\/editor\.ts$/];
/** Text the built code of React, ReactDOM and Excalidraw contains (and the game's own never does). */
export const FORBIDDEN_MARKERS = ['react.transitional.element', '__reactContainer$', 'excalidraw-modal-container', 'excalidraw-container', 'EXCALIDRAW_THROTTLE_RENDER'];
/** CSS of Excalidraw. */
export const FORBIDDEN_CSS = ['.excalidraw{', '.excalidraw ', '--color-primary-darker'];

/** The manifest keys of the entry and every chunk it imports statically, transitively. */
export function startKeys(m: Manifest): string[] {
  const entry = Object.keys(m).find((k) => m[k]?.isEntry);
  if (!entry) throw new Error('the manifest has no entry');
  const seen = new Set<string>();
  const walk = (k: string): void => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const i of m[k]?.imports ?? []) walk(i);
  };
  walk(entry);
  return [...seen];
}

/** The chunks loaded only through a dynamic import (with their static imports), minus what the start already has. */
export function lazyKeys(m: Manifest, root: string): string[] {
  const start = new Set(startKeys(m));
  const seen = new Set<string>();
  const walk = (k: string): void => {
    if (seen.has(k) || start.has(k)) return;
    seen.add(k);
    for (const i of m[k]?.imports ?? []) walk(i);
  };
  walk(root);
  return [...seen];
}

/** Why the start is not clean (empty: it is). `read` returns a built file's text. */
export function violations(m: Manifest, read: (file: string) => string, indexHtml: string): string[] {
  const out: string[] = [];
  const start = startKeys(m);
  for (const k of start) {
    const c = m[k] as ManifestChunk;
    for (const re of FORBIDDEN_MODULES) if (re.test(k) || (c.src && re.test(c.src))) out.push(`the start imports ${k} statically`);
    const code = read(c.file);
    for (const mark of FORBIDDEN_MARKERS) if (code.includes(mark)) out.push(`${c.file} (loaded at start) contains "${mark}"`);
    for (const css of c.css ?? []) {
      const text = read(css);
      for (const mark of FORBIDDEN_CSS) if (text.includes(mark)) out.push(`${css} (loaded at start) contains Excalidraw's CSS ("${mark}")`);
    }
  }
  const lazy = Object.keys(m).filter((k) => /src\/whiteboard\/editor\.ts$/.test(k));
  if (!lazy.length) out.push('no chunk for src/whiteboard/editor.ts: is the editor still loaded with import()?');
  for (const k of lazy) {
    for (const f of [m[k]?.file, ...lazyKeys(m, k).map((x) => m[x]?.file)].filter(Boolean) as string[]) {
      if (indexHtml.includes(f)) out.push(`index.html preloads ${f}, which belongs to the editor`);
    }
  }
  return out;
}

export interface Size {
  raw: number;
  gzip: number;
}

const size = (b: Buffer): Size => ({ raw: b.length, gzip: gzipSync(b, { level: 9 }).length });
const sum = (xs: Size[]): Size => xs.reduce((a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip }), { raw: 0, gzip: 0 });
const kb = (s: Size) => `${(s.raw / 1024).toFixed(1)} kB raw / ${(s.gzip / 1024).toFixed(1)} kB gzip`;

function dirBytes(d: string): number {
  return readdirSync(d).reduce((n, f) => {
    const p = join(d, f);
    const st = statSync(p);
    return n + (st.isDirectory() ? dirBytes(p) : st.size);
  }, 0);
}

/** The report's numbers: the start (JS, CSS) and the editor (JS, CSS: its chunk and the static imports only it has). */
export function sizes(m: Manifest, readBytes: (file: string) => Buffer): { startJs: Size; startCss: Size; editorJs: Size; editorCss: Size; editorChunks: number } {
  const start = startKeys(m);
  const startJs = sum(start.map((k) => size(readBytes((m[k] as ManifestChunk).file))));
  const startCss = sum(start.flatMap((k) => (m[k]?.css ?? []).map((c) => size(readBytes(c)))));
  const root = Object.keys(m).find((k) => /src\/whiteboard\/editor\.ts$/.test(k)) ?? '';
  const lazy = root ? lazyKeys(m, root) : [];
  const editorJs = sum(lazy.map((k) => size(readBytes((m[k] as ManifestChunk).file))));
  const editorCss = sum(lazy.flatMap((k) => (m[k]?.css ?? []).map((c) => size(readBytes(c)))));
  return { startJs, startCss, editorJs, editorCss, editorChunks: lazy.length };
}

function main(): void {
  const dist = resolve(process.argv[2] ?? 'dist');
  const m = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8')) as Manifest;
  const bad = violations(m, (f) => readFileSync(join(dist, f), 'utf8'), readFileSync(join(dist, 'index.html'), 'utf8'));
  const s = sizes(m, (f) => readFileSync(join(dist, f)));
  let fonts = 0;
  try {
    fonts = dirBytes(join(dist, 'assets', 'excalidraw-0.18.1', 'fonts'));
  } catch {
    bad.push('Excalidraw\'s fonts are missing from the build (assets/excalidraw-0.18.1/fonts)');
  }
  console.log(`check-bundle: start JS ${kb(s.startJs)}, start CSS ${kb(s.startCss)}`);
  console.log(`check-bundle: whiteboard editor (lazy, ${s.editorChunks} chunks with its static imports) JS ${kb(s.editorJs)}, CSS ${kb(s.editorCss)}; fonts ${(fonts / 1048576).toFixed(1)} MiB on disk (loaded by unicode-range, on use)`);
  if (bad.length) {
    console.error(`check-bundle: the game's start loads the whiteboard editor:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('check-bundle: ok, no React, ReactDOM or Excalidraw before the whiteboard opens');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
