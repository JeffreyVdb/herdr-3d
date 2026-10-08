import type { HireOptions } from '../net/protocol';
import { HARNESS_LABEL } from '../world/hire';
import { labelsOf, modelEntries, modelLabel, modelMatches, type ModelEntry, type ModelLabels } from '../world/modelLabel';
import type { HireModelPrefs } from './hireModelPrefs';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the section reads: the bridge's catalog (as it is when the dialog opens) and the player's hidden models. */
export interface HarnessModelsHost {
  prefs: HireModelPrefs;
  options: () => HireOptions;
}

interface Row {
  slug: string;
  entry: ModelEntry;
  li: HTMLElement;
  box: HTMLInputElement;
}

interface Group {
  harness: string;
  root: HTMLElement;
  count: HTMLElement;
  showAll: HTMLButtonElement;
  search: HTMLInputElement;
  none: HTMLElement;
  rows: Row[];
  stale: HTMLElement;
  labels: ModelLabels;
}

/**
 * Settings → Harness models (#194): which models the Hire dialog offers, per harness. Every model is shown until the
 * player hides it; a hidden one stays listed with its exact slug, so it can be shown again. A hidden slug the bridge no
 * longer lists sits under "Not currently available", where it can be cleared. Models are named as Hire names them (#200: the
 * harness's readable name, else a formatted slug); the exact slug stays beside the name, and the filter takes either. The list is rebuilt when the dialog opens
 * (the catalog only arrives with the bridge's snapshot) and kept in step with the preference while it is open.
 */
export function harnessModelsSection(host: HarnessModelsHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const { prefs } = host;
    const lede = el('p', 'settings-lede', 'Hire offers every model unless you hide it here. A hidden model stays in this list, so you can show it again.');
    const groupsEl = el('div', 'hm-groups');
    let groups: Group[] = [];

    const syncCounts = () => {
      for (const g of groups) {
        const off = prefs.hidden(g.harness);
        let shown = 0;
        for (const r of g.rows) {
          r.box.checked = !off.has(r.slug);
          if (r.box.checked) shown++;
        }
        g.count.textContent = `${shown} of ${g.rows.length} shown in Hire`;
        g.showAll.disabled = off.size === 0;
        renderStale(g, off);
      }
    };

    const renderStale = (g: Group, off: ReadonlySet<string>) => {
      const listed = new Set(g.rows.map((r) => r.slug));
      const gone = [...off].filter((s) => !listed.has(s));
      g.stale.replaceChildren();
      g.stale.hidden = !gone.length;
      if (!gone.length) return;
      const title = el('h5', 'hm-stale-title', 'Not currently available');
      const hint = el('p', 'settings-field-hint', 'Hidden, and still hidden if the bridge lists it again.');
      g.stale.append(title, hint);
      for (const slug of gone) {
        const row = el('div', 'hm-row');
        const code = slugCell(slug, modelLabel(g.harness, slug, g.labels));
        const clear = el('button', 'btn btn--sm', 'Clear');
        clear.type = 'button';
        clear.setAttribute('aria-label', `Clear ${slug}`);
        clear.addEventListener('click', () => {
          prefs.setShown(g.harness, slug, true);
          // The button is gone with its row: the keyboard goes to the next one, else to the filter.
          (g.stale.querySelector<HTMLButtonElement>('button') ?? g.search).focus();
        });
        row.append(code, clear);
        g.stale.append(row);
      }
    };

    /** The name (when the slug is not already it) and the exact slug, as plain text. */
    const slugCell = (slug: string, name: string): HTMLElement => {
      const cell = el('span', 'hm-id');
      if (name !== slug) cell.append(el('span', 'hm-name', name));
      cell.append(el('code', 'hm-slug', slug));
      return cell;
    };

    const group = (harness: string, models: string[], labels: ModelLabels): Group => {
      const root = el('div', 'settings-role hm-group');
      const head = el('div', 'settings-role-head');
      const title = el('h4', 'settings-role-title', HARNESS_LABEL[harness] ?? harness);
      const count = el('span', 'settings-badge');
      const showAll = el('button', 'btn btn--sm', 'Show all');
      showAll.type = 'button';
      showAll.setAttribute('aria-label', `Show all ${HARNESS_LABEL[harness] ?? harness} models in Hire`);
      head.append(title, count, showAll);

      const field = el('div', 'settings-field');
      const search = el('input');
      search.type = 'search';
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.placeholder = `Filter ${models.length} ${models.length === 1 ? 'model' : 'models'}`;
      search.setAttribute('aria-label', `Filter ${HARNESS_LABEL[harness] ?? harness} models`);
      field.append(search);

      const list = el('ul', 'hm-list');
      const rows: Row[] = modelEntries(harness, models, labels).map((entry) => {
        const slug = entry.id;
        const li = el('li', 'hm-row');
        const box = el('input');
        box.type = 'checkbox';
        const label = el('label', 'settings-switch');
        label.append(box, slugCell(slug, entry.label), el('span', 'hm-action', 'Show in Hire'));
        li.append(label);
        box.addEventListener('change', () => prefs.setShown(harness, slug, box.checked));
        list.append(li);
        return { slug, entry, li, box };
      });
      const none = el('p', 'settings-field-hint hm-none');
      none.hidden = true;
      const stale = el('div', 'hm-stale');
      stale.hidden = true;

      const filter = () => {
        const raw = search.value.trim();
        let hits = 0;
        for (const r of rows) {
          const hit = modelMatches(raw, r.entry);
          r.li.hidden = !hit;
          if (hit) hits++;
        }
        none.textContent = raw && !hits ? `No model matches “${raw}”.` : '';
        none.hidden = !none.textContent;
      };
      search.addEventListener('input', filter);
      // Esc clears the filter before anything else closes, as in the Hire dialog's own model filter.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          e.preventDefault();
          e.stopPropagation();
          search.value = '';
          filter();
        }
      });
      showAll.addEventListener('click', () => prefs.showAll(harness));

      root.append(head, field, list, none, stale);
      return { harness, root, count, showAll, search, none, rows, stale, labels };
    };

    const build = () => {
      const cat = host.options();
      groups = Object.keys(cat).map((harness) => group(harness, cat[harness]?.models ?? [], labelsOf(cat, harness)));
      groupsEl.replaceChildren(...groups.map((g) => g.root));
      if (!groups.length) groupsEl.append(el('p', 'settings-status', 'The bridge has not listed any models yet.'));
      syncCounts();
    };

    body.append(lede, groupsEl);
    build();
    const off = prefs.onChange(syncCounts);
    return {
      open: build,
      dispose: () => void off(),
    };
  };
}
