import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEMES } from './themes';
import { DEFAULT_UI_THEME, isUiThemeId, UI_THEME_FIELD, UI_THEME_HINT, UI_THEME_KEY, UI_THEMES, uiThemeById } from './uiTheme';

const css = readFileSync(resolve(import.meta.dirname, 'uiTheme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The custom properties of the block that starts with `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/(-{0,2}[a-z][\w-]*)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
}
const quiet = block(':root');
const ubuntu = block(":root[data-ui-theme='ubuntu']");

/** WCAG 2 relative luminance contrast of two opaque #rrggbb colours. */
function ratio(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('UI themes (#216)', () => {
  it('are exactly Quiet and Ubuntu, Quiet the default, with the issue’s copy', () => {
    expect(UI_THEMES.map((t) => t.id)).toEqual(['quiet', 'ubuntu']);
    expect(DEFAULT_UI_THEME).toBe('quiet');
    expect(UI_THEMES.map((t) => t.label)).toEqual(['Quiet', 'Ubuntu']);
    expect(uiThemeById('quiet').blurb).toBe('The current navy interface.');
    expect(uiThemeById('ubuntu').blurb).toBe('Ubuntu purple, orange accents, Ubuntu and Ubuntu Mono.');
    expect(UI_THEME_FIELD).toBe('UI theme');
    expect(UI_THEME_HINT).toBe('Colors and fonts for menus, dialogs, bars, and controls, and the colors of the office. Transcript and terminal appearance are set separately.');
    expect(UI_THEME_KEY).toBe('h3d.theme.ui');
  });

  it('know no third', () => {
    expect(['quiet', 'ubuntu'].every(isUiThemeId)).toBe(true);
    for (const v of ['', 'Quiet', 'terminal', null, 1, 'ubuntu ']) expect(isUiThemeId(v)).toBe(false);
  });

  it('Ubuntu’s tokens are the issue’s table, exactly', () => {
    expect(ubuntu).toMatchObject({
      '--surface': '#300a24',
      '--chrome': '#2c001e',
      '--well': '#2c001e',
      '--raised': '#3b1330',
      '--hover': '#5e2750',
      '--text': '#ffffff',
      '--text-2': '#e8d5e2',
      '--text-3': '#cdb1c6',
      '--border': '#ae93a7',
      '--line': 'rgb(255 255 255 / 14%)',
      '--action': '#e95420',
      '--action-hover': '#eb6536',
      '--action-active': '#ed764d',
      '--on-action': '#2c001e',
      '--on-fill': '#2c001e',
      '--on-chip': '#2c001e',
      '--focus': '#ff9b76',
      '--accent-text': '#ff9b76',
      '--done': '#6be08f',
      '--error-text': '#ff8a80',
      '--error-fill': '#ff8a80',
      '--error-fill-hover': '#ffa39b',
      '--needs_you': '#ffc83d',
      '--warn': '#ffc83d',
      '--working': '#8ec9ff',
      '--waiting': '#76d8d8',
      '--idle': '#cdb1c6',
      '--asleep': '#c9a8f5',
      // A reviewer's verdict stamp: raised purple, the status colours as ink.
      '--stamp-bg': '#3b1330',
      '--stamp-pass': '#6be08f',
      '--stamp-changes': '#ff8a80',
      '--stamp-incomplete': '#cdb1c6',
      '--scrim': 'rgb(44 0 30 / 72%)',
      // Every modal dialog's backdrop is the standard scrim, the prompt overlay's too; the viewers are the 92% one.
      '--scrim-light': 'rgb(44 0 30 / 72%)',
      '--scrim-viewer': 'rgb(44 0 30 / 92%)',
      '--scrim-board': 'rgb(44 0 30 / 92%)',
      '--shadow': '0 10px 28px rgb(0 0 0 / 28%), 0 2px 6px rgb(0 0 0 / 18%)',
      '--radius-ctl': '9px',
      'color-scheme': 'dark',
    });
    expect(ubuntu['--font']).toBe("'Ubuntu', system-ui, sans-serif");
    expect(ubuntu['--font-mono']).toMatch(/^'Ubuntu Mono', 'H3D Box Ubuntu'/);
    expect(ubuntu['--fvs-casual']).toBe('normal');
  });

  it('Ubuntu overrides every Quiet token the shell reads except the shared shape ones, and Quiet keeps today’s values', () => {
    const same = new Set(['--paper', '--radius', '--ease', '--line', '--ink-soft', '--btn-border-hover', '--text-on-ink', '--text-on-ink-2']);
    for (const k of Object.keys(quiet)) if (!same.has(k)) expect(ubuntu, `Ubuntu sets ${k}`).toHaveProperty(k);
    expect(quiet).toMatchObject({ '--stamp-bg': '#ffffff', '--stamp-pass': '#0b8454', '--stamp-changes': '#c42a26', '--stamp-incomplete': '#5d6478' });
    expect(quiet).toMatchObject({ '--ink': '#1c2540', '--sun': '#ffc233', '--font': "'Recursive Variable', system-ui, sans-serif", 'color-scheme': 'light' });
  });

  it('the pairings the issue measured hold on the real tokens', () => {
    const p = (k: string) => ubuntu[k] as string;
    expect(ratio(p('--text'), p('--surface'))).toBeCloseTo(17.58, 1);
        expect(ratio(p('--text-3'), p('--raised'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p('--on-action'), p('--action'))).toBeCloseTo(5.11, 1);
    expect(ratio(p('--on-action'), p('--action-hover'))).toBeCloseTo(5.73, 1);
    expect(ratio(p('--on-action'), p('--action-active'))).toBeCloseTo(6.48, 1);
    expect(ratio('#ffffff', p('--action'))).toBeLessThan(4.5);
    expect(ratio(p('--accent-text'), p('--hover'))).toBeCloseTo(5.42, 1);
    expect(ratio(p('--border'), p('--hover'))).toBeCloseTo(4.0, 1);
    expect(ratio(p('--error-text'), p('--hover'))).toBeCloseTo(4.89, 1);
    // Text on the filled chips and buttons is the dark aubergine, 4.5:1 on each fill.
    for (const k of ['--done-chip', '--needs_you-chip', '--idle-chip', '--waiting-chip', '--error-fill', '--error-fill-hover', '--action', '--action-hover', '--action-active']) {
      expect(ratio(p('--on-chip'), p(k)), k).toBeGreaterThanOrEqual(4.5);
    }
    for (const k of ['--stamp-pass', '--stamp-changes', '--stamp-incomplete']) expect(ratio(p(k), p('--stamp-bg')), k).toBeGreaterThanOrEqual(4.5);
    // Status colours as text or icons on purple surfaces.
    for (const k of ['--working', '--done', '--needs_you', '--idle', '--asleep', '--waiting', '--error-text']) {
      for (const g of ['--surface', '--chrome', '--raised']) expect(ratio(p(k), p(g)), `${k} on ${g}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/** The hue of an opaque #rrggbb colour, in degrees. */
function hue(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h6 = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h6 * 60 + 360) % 360;
}
const hueGap = (a: string, b: string) => Math.min(Math.abs(hue(a) - hue(b)), 360 - Math.abs(hue(a) - hue(b)));

// #187: the questions button's two lanes. It sits in the transcript's prompt form (`--ctl-bar`) at a laptop whose
// conversation wears either transcript preset, and its colours are the lanes' marks in the questions sheet (`--surface`,
// `--raised`): every UI theme × preset pairing, read from the real tokens.
describe('the questions lanes’ colours (#187)', () => {
  const themes = { quiet, ubuntu };
  const presets = THEMES.map((t) => t.palette);
  for (const [name, t] of Object.entries(themes)) {
    /** A token's colour, through its `var(--…)` aliases (Quiet's `--surface` is `var(--ink)`). */
    const v = (k: string): string => {
      const alias = /^var\((--[\w-]+)\)$/.exec(t[k] ?? '');
      if (alias) return v(alias[1]!);
      expect(t[k], `${name} sets ${k}`).toMatch(/^#[0-9a-f]{6}$/);
      return t[k] as string;
    };
    /** Every ground the button or a lane mark can sit on under this UI theme, whatever the transcript preset. */
    const grounds = () => [
      ...['--ctl-bar', '--ctl-raised', '--ctl-hover', '--ctl-well', '--surface', '--raised'].map((k) => [k, v(k)]),
      ...presets.flatMap((p) => (['bg', 'bg-2', 'bg-3'] as const).map((k) => [`--tx-${k}`, p[k]])),
    ];

    it(`${name}: the label is 4.5:1 on each lane's fill`, () => {
      expect(ratio(v('--ctl-q-urgent-text'), v('--ctl-q-urgent'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(v('--ctl-q-optional-text'), v('--ctl-q-optional'))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: each lane's fill and ring are 3:1 on every ground, in both transcript presets`, () => {
      for (const lane of ['--ctl-q-urgent', '--ctl-q-optional']) {
        for (const [g, c] of grounds()) expect(ratio(v(lane), c!), `${lane} on ${g} ${c}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${name}: urgent is red, optional is calm, neither is the accent or the sun`, () => {
      const urgent = v('--ctl-q-urgent');
      const optional = v('--ctl-q-optional');
      expect(hueGap(urgent, '#ff0000'), 'urgent reads red').toBeLessThanOrEqual(12);
      for (const k of ['--ctl-accent', '--action', '--sun']) {
        expect(hueGap(urgent, v(k)), `urgent vs ${k}`).toBeGreaterThanOrEqual(18);
        expect(hueGap(optional, v(k)), `optional vs ${k}`).toBeGreaterThanOrEqual(25);
      }
      expect(hueGap(urgent, optional)).toBeGreaterThanOrEqual(120);
    });
  }
});

// #42: index.html's inline script puts a saved Ubuntu on the root before the first frame (the e2e checks the frames of a
// real reload); here its reading of storage: only the exact stored 'ubuntu', and never a throw.
describe('the pre-frame UI theme script in index.html (#216)', () => {
  const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  function boot(storage: () => Pick<Storage, 'getItem'>): { theme: string | null; color: string | null } {
    const got = { theme: null as string | null, color: null as string | null };
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => k === 'data-ui-theme' && (got.theme = v) },
      querySelector: (s: string) => (s === 'meta[name="theme-color"]' ? { setAttribute: (_k: string, v: string) => (got.color = v) } : null),
    };
    const scope = {} as { localStorage: Storage };
    Object.defineProperty(scope, 'localStorage', { get: storage });
    new Function('scope', 'document', `with (scope) {${script}}`)(scope, document);
    return got;
  }
  const stored = (v: string | null) => () => ({ getItem: (k: string) => (k === UI_THEME_KEY ? v : null) });

  it('marks the root Ubuntu, with the Ubuntu theme colour, for a stored Ubuntu only', () => {
    expect(boot(stored('ubuntu'))).toEqual({ theme: 'ubuntu', color: '#2c001e' });
    for (const v of [null, '', 'quiet', 'solarized', 'UBUNTU', 'Ubuntu', ' ubuntu', 'null']) expect(boot(stored(v)), JSON.stringify(v)).toEqual({ theme: null, color: null });
  });

  it('leaves the root alone when storage is blocked or throws', () => {
    expect(
      boot(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toEqual({ theme: null, color: null });
    expect(
      boot(() => ({
        getItem: () => {
          throw new DOMException('denied', 'SecurityError');
        },
      })),
    ).toEqual({ theme: null, color: null });
  });
});
