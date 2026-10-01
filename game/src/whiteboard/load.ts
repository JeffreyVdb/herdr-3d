/**
 * M13: the one door to the Excalidraw editor. The game imports this file only; it loads ./editor.ts (React, ReactDOM,
 * Excalidraw and its CSS) with a dynamic import the first time it is called, so none of it is in the entry chunk
 * (tools/check-bundle.ts). Excalidraw's fonts are served from the build itself (vite.config.ts copies them to
 * `assets/excalidraw-<version>/fonts/`): the asset path is set before the module loads, so no font comes from a CDN.
 */

import { EXCALIDRAW_ASSETS_DIR } from './version';

/** Where Excalidraw finds its fonts: the parent of `fonts/`, with a trailing slash. */
export const EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}${EXCALIDRAW_ASSETS_DIR}/`;

type Editor = typeof import('./editor');
let loading: Promise<Editor> | undefined;

/** The editor module, loaded once (a failed load is tried again next time). */
export function loadEditor(): Promise<Editor> {
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
  loading ??= import('./editor').catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** Whether the editor module was asked for yet (test hook). */
export function editorRequested(): boolean {
  return loading !== undefined;
}
