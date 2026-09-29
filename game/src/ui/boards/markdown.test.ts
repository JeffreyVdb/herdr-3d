import { describe, expect, it } from 'vitest';
import { renderMarkdown, setMarkdown } from './markdown';

// The browser check (a Playwright spec on the simulator's XSS card) proves what the sanitiser leaves; this covers the
// unit: with no DOM to sanitise in, nothing is rendered as HTML.
describe('renderMarkdown without a DOM', () => {
  it('fails closed: no fragment, and the text goes in as text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBeNull();
    const el = { textContent: '', replaceChildren: () => undefined } as unknown as HTMLElement;
    setMarkdown(el, '<script>alert(1)</script>');
    expect(el.textContent).toBe('<script>alert(1)</script>');
  });
});
