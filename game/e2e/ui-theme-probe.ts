import type { Page } from '@playwright/test';

// #216: browser-side probes of the rendered page: the colours and fonts that really paint (after resets, inheritance,
// alpha compositing and state overlays), for the contrast, coverage and font checks. Each is one self-contained
// function run in the page (no imports reach it).

export interface TextSample {
  /** A short selector path for the report. */
  at: string;
  text: string;
  fg: string;
  bg: string | null;
  ratio: number | null;
  size: number;
  weight: string;
  family: string;
  /** The nearest ancestor that sets a background wholly or in part, as a short path (why the bg is what it is). */
  bgFrom: string | null;
}

export interface Stray {
  at: string;
  prop: string;
  value: string;
  why: string;
}

/** Every text-bearing element under `root` (visible), with its real foreground and the opaque colour behind it. */
export function textSamples(page: Page, rootSel: string, skipSel = ''): Promise<TextSample[]> {
  return page.evaluate(
    ({ rootSel, skipSel }) => {
      type RGBA = [number, number, number, number];
      const parse = (s: string): RGBA | null => {
        s = s.trim();
        let m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
        if (m) {
          const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          return [+m[1]!, +m[2]!, +m[3]!, a];
        }
        m = s.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\)$/);
        if (m) {
          const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          return [+m[1]! * 255, +m[2]! * 255, +m[3]! * 255, a];
        }
        return null;
      };
      const over = (top: RGBA, under: RGBA): RGBA => {
        const a = top[3] + under[3] * (1 - top[3]);
        if (a === 0) return [0, 0, 0, 0];
        return [0, 1, 2].map((i) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
      };
      const lum = (c: RGBA) => {
        const [r, g, b] = [c[0], c[1], c[2]].map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: RGBA, b: RGBA) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const path = (e: Element) => {
        const parts: string[] = [];
        for (let n: Element | null = e; n && parts.length < 4 && n !== document.documentElement; n = n.parentElement) {
          const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
          parts.unshift(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''}`);
        }
        return parts.join(' > ');
      };
      const roots = [...document.querySelectorAll(rootSel)];
      const seen = new Set<Element>();
      const out: Array<Record<string, unknown>> = [];
      for (const root of roots) {
        const all: Element[] = [root, ...root.querySelectorAll('*')];
        for (const el of all) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (skipSel && el.closest(skipSel)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          // Only elements whose own text nodes carry visible text.
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
          // Pseudo-element content (counts, keycaps drawn with attr()) is text too.
          const pseudo = ['::before', '::after'].map((p) => getComputedStyle(el, p).content).filter((c) => c && c !== 'none' && c !== 'normal' && c !== '""' && !c.startsWith('url('));
          const text = own || (pseudo.length ? pseudo.join(' ').replace(/^"|"$/g, '') : '');
          if (!text) continue;
          if (cs.clip !== 'auto' && cs.clip !== '' && /rect\(0px, 0px, 0px, 0px\)|rect\(1px, 1px, 1px, 1px\)/.test(cs.clip)) continue;
          if (cs.clipPath && cs.clipPath.startsWith('inset(50%)')) continue;
          const fgRaw = parse(cs.color);
          if (!fgRaw) continue;
          // Layers from the element up: the first opaque background ends the stack.
          const layers: RGBA[] = [];
          let bgFrom: string | null = null;
          let unknown = false;
          for (let n: Element | null = el; n; n = n.parentElement) {
            const ns = getComputedStyle(n);
            if (ns.backgroundImage && ns.backgroundImage !== 'none') {
              // A gradient or an image: its colour is not one number. Take the element's background-color under it, and flag it.
              unknown = true;
            }
            const c = parse(ns.backgroundColor);
            if (c && c[3] > 0) {
              layers.push(c);
              bgFrom ??= path(n);
              if (c[3] >= 1) break;
            }
          }
          let bg: RGBA | null = null;
          if (layers.length && layers[layers.length - 1]![3] >= 1) {
            bg = layers.reduceRight<RGBA>((under, top) => over(top, under), [0, 0, 0, 0]);
          }
          // Text drawn with alpha mixes with what is behind it.
          const fg = bg ? over(fgRaw, bg) : fgRaw;
          const sampleRatio = bg && !unknown ? ratio(fg, bg) : null;
          const fmt = (c: RGBA) => `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}${c[3] < 1 ? ` / ${c[3].toFixed(2)}` : ''})`;
          out.push({
            at: path(el),
            text: text.slice(0, 40),
            fg: fmt(fg),
            bg: bg ? fmt(bg) : unknown ? 'gradient/image' : 'translucent',
            ratio: sampleRatio,
            size: parseFloat(cs.fontSize),
            weight: cs.fontWeight,
            family: cs.fontFamily,
            bgFrom,
          });
        }
      }
      return out;
    },
    { rootSel, skipSel },
  ) as unknown as Promise<TextSample[]>;
}

/**
 * Colours and fonts that give away Quiet in a surface that should be wholly Ubuntu: every computed colour-bearing
 * property of every visible element under `root` that is a navy / yellow of Quiet's palette or a Quiet-only font family.
 */
export function strays(page: Page, rootSel: string, allowSel = ''): Promise<Stray[]> {
  return page.evaluate(
    ({ rootSel, allowSel }) => {
      // Quiet's own palette (hex of the tokens and of the literals the shell used), as 'r,g,b'.
      const QUIET = [
        '#1c2540', '#2a355a', '#3a466e', '#121a31', '#101626', '#0b1122', '#0b1022', '#0b1020', '#ffc233', '#ffd25e', '#ffe27a', '#eef2fb', '#b9c3dc', '#8f9abb',
        '#ffb4ae', '#ff7b73', '#d8302c', '#bf2622', '#c42a26', '#2fc46a', '#2f6bf0', '#12a26a', '#e8413a', '#7a8398', '#5a5fa8', '#1e9aa0', '#0b8454', '#6b7388', '#0f7378',
        '#6f9bff', '#0f1526', '#161e35', '#1f2a47', '#e4e9f6', '#9aa5c3', '#76819f', '#4cd88a', '#ff7a72', '#fff3c4', '#fff6dd', '#5b6685', '#354270', '#34406a', '#34416c', '#4a5570',
      ].map((h) => `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`);
      const rgbOf = (s: string) => [...s.matchAll(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/g)].map((m) => `${Math.round(+m[1]!)},${Math.round(+m[2]!)},${Math.round(+m[3]!)}`);
      const srgbOf = (s: string) => [...s.matchAll(/color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/g)].map((m) => `${Math.round(+m[1]! * 255)},${Math.round(+m[2]! * 255)},${Math.round(+m[3]! * 255)}`);
      const colours = (s: string) => [...rgbOf(s), ...srgbOf(s)];
      const path = (e: Element) => {
        const parts: string[] = [];
        for (let n: Element | null = e; n && parts.length < 4 && n !== document.documentElement; n = n.parentElement) {
          const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
          parts.unshift(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''}`);
        }
        return parts.join(' > ');
      };
      const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'boxShadow', 'textShadow', 'fill', 'stroke', 'caretColor', 'accentColor', 'textDecorationColor', 'scrollbarColor', 'backgroundImage', 'borderImageSource'] as const;
      const found: Array<{ at: string; prop: string; value: string; why: string }> = [];
      const seen = new Set<Element>();
      for (const root of document.querySelectorAll(rootSel)) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (allowSel && el.closest(allowSel)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 && r.height < 1) continue;
          const fam = cs.fontFamily;
          if (/Recursive|JetBrains|Atkinson|Departure|Archivo/i.test(fam) && (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim()))) {
            found.push({ at: path(el), prop: 'font-family', value: fam, why: 'Quiet-only family' });
          }
          for (const p of PROPS) {
            const v = (cs as unknown as Record<string, string>)[p] ?? '';
            if (!v || v === 'none') continue;
            // A border / outline that is not drawn has no colour to give away.
            if (p.startsWith('border') && p.endsWith('Color')) {
              const side = p.replace('Color', 'Style').replace('border', 'border');
              const w = parseFloat((cs as unknown as Record<string, string>)[p.replace('Color', 'Width')] ?? '0');
              if (!w || (cs as unknown as Record<string, string>)[side] === 'none') continue;
            }
            if (p === 'outlineColor' && (cs.outlineStyle === 'none' || !parseFloat(cs.outlineWidth))) continue;
            for (const c of colours(v)) {
              if (QUIET.includes(c)) found.push({ at: path(el), prop: p, value: v.slice(0, 90), why: `Quiet colour rgb(${c})` });
            }
          }
        }
      }
      return found;
    },
    { rootSel, allowSel },
  ) as unknown as Promise<Stray[]>;
}
