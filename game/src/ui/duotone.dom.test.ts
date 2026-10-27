// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DUOTONE, DUOTONE_NAMES, duotone, type DuotoneName } from './duotone';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = 'path, rect, circle, line, polyline, polygon, ellipse';

describe('duotone icons', () => {
  it('covers the contract’s set and the seat’s other icons', () => {
    const wanted: DuotoneName[] = ['terminal', 'chat', 'image', 'play', 'files', 'server', 'bell', 'stop', 'reply', 'panel', 'door', 'question', 'copy', 'trash', 'pencil', 'x', 'check', 'expand', 'search', 'chevronDown', 'chevronRight', 'chevronLeft', 'chevronUp', 'bolt', 'folder', 'file', 'split', 'gear', 'lock', 'alert', 'refresh', 'repo', 'clock', 'hire', 'fileText', 'globe', 'agent', 'list', 'tool', 'brain', 'urgent', 'ask'];
    expect(DUOTONE_NAMES).toEqual(expect.arrayContaining(wanted));
  });

  it.each(DUOTONE_NAMES)('%s renders a valid, hidden, 24-grid stroke SVG with the class contract', (name) => {
    const svg = duotone(name);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.classList.contains('dt')).toBe(true);
    expect(svg.dataset.icon).toBe(name);
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) expect(svg.getAttribute(k), k).toBe(v);
    const shapes = [...svg.querySelectorAll(SHAPES)];
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    // Every child is a drawn shape in the SVG namespace (no stray text, no HTML parsed into it).
    expect([...svg.children].every((c) => c.namespaceURI === SVG_NS && c.matches(SHAPES))).toBe(true);
    expect(svg.textContent?.trim()).toBe('');
    // No hard-coded colours: only currentColor or the accent classes paint.
    for (const s of shapes) {
      for (const a of ['fill', 'stroke', 'style', 'color']) {
        const v = s.getAttribute(a);
        if (v !== null) expect(['currentColor', 'none'], `${name} ${a}=${v}`).toContain(v);
      }
    }
  });

  it.each(DUOTONE_NAMES)('%s keeps base and accent apart: accent elements carry ac/acf, base ones neither', (name) => {
    const [base, accent] = DUOTONE[name];
    const parse = (s: string) => [...duotoneFragment(s).querySelectorAll(SHAPES)];
    const baseEls = parse(base);
    const accentEls = parse(accent);
    expect(baseEls.length + accentEls.length).toBeGreaterThanOrEqual(1);
    for (const e of baseEls) expect(e.classList.contains('ac') || e.classList.contains('acf'), `${name} base`).toBe(false);
    for (const e of accentEls) expect(e.classList.contains('ac') !== e.classList.contains('acf'), `${name} accent`).toBe(true);
    // A filled accent draws no stroke of its own (the CSS sets stroke: none); a stroked one is not filled.
    for (const e of accentEls.filter((x) => x.classList.contains('ac'))) expect(e.getAttribute('fill')).toBeNull();
  });

  it('adds extra classes and returns a fresh element each time', () => {
    const a = duotone('bell', 'seat-needs-icon big');
    const b = duotone('bell');
    expect(a).not.toBe(b);
    expect([...a.classList]).toEqual(['dt', 'seat-needs-icon', 'big']);
    expect(a.querySelector('.acf')).not.toBeNull();
  });
});

function duotoneFragment(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg xmlns="${SVG_NS}">${markup}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
