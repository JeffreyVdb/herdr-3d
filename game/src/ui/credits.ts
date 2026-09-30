import { CHANGES, GENRES, LICENSE_NAME, MANIFEST, type MusicRow } from '../audio/tracks';
import './credits.css';
import { backdropPolicy } from './dismiss';
import { FONT_CREDITS, FONT_LICENSES_FILE, OFL, type FontCredit } from './fontCredits';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, text: string, label: string): HTMLAnchorElement {
  const a = el('a', 'credits-link', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', label);
  return a;
}

function closeIcon(): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M6.5 6.5l11 11M17.5 6.5l-11 11');
  s.append(p);
  return s;
}

function fontRow(f: FontCredit): HTMLLIElement {
  const li = el('li', 'credits-row credits-font');
  const who = el('div', 'credits-who');
  who.append(el('span', 'credits-title', f.name), el('span', 'credits-artist', `${f.role}. ${f.copyright}.`));
  const meta = el('div', 'credits-meta');
  const lic = f.license ?? OFL;
  meta.append(link(lic.url, lic.name, `${f.name}: license, ${lic === OFL ? 'SIL Open Font License 1.1' : lic.name}`), link(f.source, 'Source', `${f.name}: source`));
  li.append(who, meta);
  return li;
}

/** One track: what it is, who made it, and the license and source it came under. */
function row(r: MusicRow): HTMLLIElement {
  const li = el('li', 'credits-row');
  const who = el('div', 'credits-who');
  who.append(el('span', 'credits-title', r.title), el('span', 'credits-artist', r.artist));
  const meta = el('div', 'credits-meta');
  meta.append(link(r.licenseUrl, LICENSE_NAME[r.license], `${r.title}: license, ${LICENSE_NAME[r.license]}`), link(r.sourceUrl, 'Source', `${r.title}: source page`));
  li.append(who, meta);
  return li;
}

/**
 * The Music credits panel: every track of the radio, from the manifest (title,
 * artist, license with its link, source), grouped by genre. The same data as
 * the `MUSIC_CREDITS.txt` that ships next to the build. A modal `<dialog>` like
 * the other panels; Esc or the header's Close shuts it, and the game's keys
 * (E, R, WASD…) do nothing while it is open.
 */
export class MusicCredits {
  private readonly dialog = el('dialog', 'credits');
  private opener: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly rows: readonly MusicRow[] = MANIFEST.tracks,
  ) {
    const head = el('header', 'panel-head');
    const titles = el('div', 'panel-titles');
    const h = el('h2', '', 'Music credits');
    h.id = 'credits-title';
    titles.append(h, el('p', '', `${this.rows.length} tracks play on the lounge radio`));
    const close = el('button', 'btn btn--icon panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    const body = el('div', 'panel-body credits-body');
    body.tabIndex = -1;
    for (const g of GENRES) {
      const list = this.rows.filter((r) => r.genre === g.id);
      if (!list.length) continue;
      const sec = el('section', 'credits-genre');
      const title = el('h3', 'credits-genre-name');
      const tape = el('span', 'tape', g.name);
      tape.style.setProperty('--c', 'var(--sun)');
      title.append(tape, el('span', 'credits-count', String(list.length)));
      title.setAttribute('aria-label', `${g.name}, ${list.length} tracks`);
      const ul = el('ul', 'credits-list');
      ul.append(...list.map(row));
      sec.append(title, ul);
      body.append(sec);
    }
    // #59: the fonts, after the music: the credits panel is the one place the game names what it ships.
    const fonts = el('section', 'credits-genre credits-fonts');
    const fontsTitle = el('h3', 'credits-genre-name');
    const fontsTape = el('span', 'tape', 'Fonts');
    fontsTape.style.setProperty('--c', 'var(--sun)');
    fontsTitle.append(fontsTape, el('span', 'credits-count', String(FONT_CREDITS.length)));
    fontsTitle.setAttribute('aria-label', `Fonts, ${FONT_CREDITS.length}`);
    const fontList = el('ul', 'credits-list');
    fontList.append(...FONT_CREDITS.map(fontRow));
    // The licences' full texts ship with the game (the OFL and the Bitstream Vera licence ask it): a local file.
    const texts = el('p', 'credits-fonts-texts');
    const local = el('a', 'credits-link', FONT_LICENSES_FILE);
    local.href = FONT_LICENSES_FILE;
    local.target = '_blank';
    local.rel = 'noopener';
    local.setAttribute('aria-label', `The fonts’ licences in full, ${FONT_LICENSES_FILE}, shipped with the game`);
    texts.append(document.createTextNode('Their licences in full ship with the game: '), local, document.createTextNode('.'));
    fonts.append(fontsTitle, fontList, texts);
    body.append(fonts);
    const foot = el('p', 'panel-status credits-foot', `Each music file is ${CHANGES}. The same list ships as MUSIC_CREDITS.txt, the fonts’ licences as ${FONT_LICENSES_FILE}.`);

    this.dialog.setAttribute('aria-labelledby', 'credits-title');
    this.dialog.append(head, body, foot);
    // The game's own keys are not for a dialog: E on the radio behind it must not tune it.
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });
    // A read-only sheet: the backdrop closes it only when the press and the click both began there (#51).
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from;
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>('.credits-body')?.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    this.close();
    this.dialog.remove();
  }
}
