import { describe, expect, it } from 'vitest';
import { lazyKeys, startKeys, violations, type Manifest } from './check-bundle.ts';

// M13: the bundle check of tools/check-bundle.ts on made-up manifests (the real one runs after every `pnpm build`).
const clean: Manifest = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_three.js'], dynamicImports: ['src/whiteboard/editor.ts'], css: ['assets/index.css'] },
  '_three.js': { file: 'assets/three.js' },
  'src/whiteboard/editor.ts': { file: 'assets/editor.js', isDynamicEntry: true, imports: ['index.html', '_react.js'], css: ['assets/editor.css'] },
  '_react.js': { file: 'assets/react.js', src: 'node_modules/.pnpm/react@19.3.0/node_modules/react/index.js' },
};
const files: Record<string, string> = {
  'assets/index.js': 'console.log("game")',
  'assets/three.js': 'three',
  'assets/index.css': '.hud{}',
  'assets/editor.js': 'excalidraw-container',
  'assets/react.js': 'Symbol.for("react.transitional.element")',
  'assets/editor.css': '.excalidraw{color:red}',
};
const read = (f: string) => files[f] ?? '';

describe('check-bundle', () => {
  it('follows only the static imports from the entry', () => {
    expect(startKeys(clean).sort()).toEqual(['_three.js', 'index.html']);
    expect(lazyKeys(clean, 'src/whiteboard/editor.ts').sort()).toEqual(['_react.js', 'src/whiteboard/editor.ts']);
    expect(violations(clean, read, '<script src="/assets/index.js">')).toEqual([]);
  });

  it('fails when the start imports the editor or React statically', () => {
    const m: Manifest = { ...clean, '_three.js': { file: 'assets/three.js', imports: ['_react.js'] } };
    expect(violations(m, read, '').join('\n')).toMatch(/imports _react\.js statically[\s\S]*react\.transitional\.element/);
  });

  it('fails on Excalidraw code or CSS in a start chunk, and on a preload of the editor', () => {
    expect(violations(clean, (f) => (f === 'assets/three.js' ? 'x excalidraw-modal-container' : read(f)), '')).toEqual(['assets/three.js (loaded at start) contains "excalidraw-modal-container"']);
    expect(violations(clean, (f) => (f === 'assets/index.css' ? '.excalidraw{}' : read(f)), '')[0]).toMatch(/Excalidraw's CSS/);
    expect(violations(clean, read, '<link rel="modulepreload" href="/assets/react.js">')).toEqual(['index.html preloads assets/react.js, which belongs to the editor']);
  });

  it('fails when the editor is not a lazy chunk at all', () => {
    const { 'src/whiteboard/editor.ts': _gone, ...rest } = clean;
    expect(violations(rest, read, '')[0]).toMatch(/no chunk for src\/whiteboard\/editor\.ts/);
  });
});
