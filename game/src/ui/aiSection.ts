import type { AiClassifier, AiFields, AiLlm, AiModel, AiModelsAck, AiRole, AiRoleState, AiState, AiTestAck, CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { aiFailureText } from '../world/ai';
import type { AiBook } from '../world/ai';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the AI integration section needs: the bridge's state, and the commands. */
export interface AiSectionHost {
  book: AiBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The features using each model, for the line under its name. None until the first one (#90) registers. */
  usedBy?: Record<AiRole, string[]>;
}

const BADGE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };
const LLM_PLACEHOLDER = 'https://api.xiaomimimo.com/v1';
const CLASSIFIER_DEFAULT = 'jev-latest';
const CONFIRM_MS = 4000;

let serial = 0;

const timeText = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

function field(id: string, label: string, control: HTMLElement, hint: HTMLElement): HTMLElement {
  const f = el('div', 'settings-field');
  const l = el('label', 'settings-field-label', label);
  l.htmlFor = id;
  control.id = id;
  control.setAttribute('aria-describedby', (hint.id = `${id}-hint`));
  f.append(l, control, hint);
  return f;
}

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * One role's controls: the fields, Load models, Test, Save and Clear, and a status line. Save is only enabled once
 * a test passed for exactly what the fields hold now (the bridge insists too). A key is typed here, sent once and
 * never shown again: the field is emptied after a save, and a blank key means “keep the current one”.
 */
class RoleForm {
  readonly root = el('div', 'settings-role');
  private readonly id = `settings-ai-${++serial}`;
  private readonly badge = el('span', 'settings-badge');
  private readonly key = el('input');
  private readonly keyHint = el('p', 'settings-field-hint');
  private readonly base = el('input');
  private readonly baseHint = el('p', 'settings-field-hint');
  private readonly modelSel = el('select');
  private readonly modelIn = el('input');
  private readonly modelList = el('datalist');
  private readonly modelHint = el('p', 'settings-field-hint');
  private readonly extra = el('textarea');
  private readonly extraHint = el('p', 'settings-field-hint');
  private readonly load = button('Load models');
  private readonly test = button('Test');
  private readonly save = button('Save', 'btn btn--sm btn--primary');
  private readonly clear = button('Clear');
  private readonly status = el('p', 'settings-status');
  private models: AiModel[] = [];
  private testedSig: string | null = null;
  private busy = false;
  private dirty = false;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private note: { text: string; error: boolean } | null = null;

  constructor(
    private readonly role: AiRole,
    private readonly host: AiSectionHost,
  ) {
    const llm = role === 'llm';
    const head = el('div', 'settings-role-head');
    const h = el('h4', 'settings-role-title', llm ? 'LLM (OpenAI-compatible)' : 'Classification model (Jev)');
    h.id = `${this.id}-h`;
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-labelledby', h.id);
    this.badge.dataset.state = 'off';
    head.append(h, this.badge);
    const used = host.usedBy?.[role] ?? [];
    const usedLine = el('p', 'settings-field-hint settings-used', used.length ? `Used by ${used.join(', ')}.` : 'Used by no feature yet.');
    this.root.append(head, usedLine);

    for (const input of [this.key, this.base, this.modelIn]) {
      input.autocomplete = 'off';
      input.spellcheck = false;
    }
    this.key.type = 'password';
    this.key.autocomplete = 'new-password';
    this.key.setAttribute('data-lpignore', 'true');
    this.base.type = 'url';
    this.base.inputMode = 'url';
    this.base.placeholder = LLM_PLACEHOLDER;
    this.modelIn.type = 'text';
    this.modelIn.placeholder = 'Load models, or type a model id';
    this.modelList.id = `${this.id}-models`;
    this.modelIn.setAttribute('list', this.modelList.id);
    this.extra.rows = 3;
    this.extra.spellcheck = false;
    this.extra.placeholder = '{"thinking": {"type": "disabled"}}';

    const body: HTMLElement[] = [];
    if (llm) body.push(field(`${this.id}-base`, 'Base URL', this.base, this.baseHint));
    body.push(field(`${this.id}-key`, llm ? 'API key' : 'Key', this.key, this.keyHint));
    const modelControl = el('div', 'settings-row');
    const picker = llm ? this.modelIn : this.modelSel;
    modelControl.append(picker, this.load);
    const modelField = el('div', 'settings-field');
    const ml = el('label', 'settings-field-label', 'Model');
    ml.htmlFor = `${this.id}-model`;
    picker.id = `${this.id}-model`;
    picker.setAttribute('aria-describedby', (this.modelHint.id = `${this.id}-model-hint`));
    modelField.append(ml, modelControl, this.modelHint);
    if (llm) modelField.append(this.modelList);
    body.push(modelField);
    if (llm) {
      const adv = el('details', 'settings-advanced');
      adv.append(el('summary', '', 'Advanced'));
      adv.append(field(`${this.id}-extra`, 'Extra request fields (JSON)', this.extra, this.extraHint));
      body.push(adv);
    }
    const actions = el('div', 'settings-actions');
    actions.append(this.test, this.save, this.clear);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.root.append(...body, actions, this.status);

    const edited = () => {
      this.dirty = true;
      this.refresh();
    };
    for (const c of [this.key, this.base, this.modelIn, this.extra, this.modelSel]) {
      c.addEventListener('input', edited);
      c.addEventListener('change', edited);
    }
    for (const c of [this.key, this.base, this.modelIn]) {
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!this.test.disabled) void this.runTest();
        }
      });
    }
    this.load.addEventListener('click', () => void this.loadModels());
    this.test.addEventListener('click', () => void this.runTest());
    this.save.addEventListener('click', () => void this.runSave());
    this.clear.addEventListener('click', () => this.runClear());
  }

  private get st(): AiState | null {
    return this.host.book.state;
  }

  private get cur() {
    const s = this.st;
    return s ? (this.role === 'llm' ? s.llm : s.classifier) : null;
  }

  private get llmCur(): AiLlm | null {
    return this.role === 'llm' ? (this.st?.llm ?? null) : null;
  }

  private locked(name: string): boolean {
    return this.cur?.env.includes(name) ?? false;
  }

  /** The value of the model control. */
  private model(): string {
    return (this.role === 'llm' ? this.modelIn.value : this.modelSel.value).trim();
  }

  /** What the fields say, as the request names it; a locked field is left out, a blank key too. */
  private fields(): { args: AiFields } | { error: string } {
    const args: AiFields = { role: this.role };
    if (this.role === 'llm' && !this.locked('base_url')) args.base_url = this.base.value.trim();
    if (!this.locked('model') && this.model()) args.model = this.model();
    const key = this.key.value.trim();
    if (key && !this.locked('key')) args.key = key;
    if (this.role === 'llm') {
      const text = this.extra.value.trim();
      if (text) {
        try {
          const v: unknown = JSON.parse(text);
          if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
          args.extra_body = v as Record<string, unknown>;
        } catch {
          return { error: 'Extra request fields must be a JSON object, like {"thinking": {"type": "disabled"}}.' };
        }
      } else if (this.llmCur?.extra_body) args.extra_body = null;
    }
    return { args };
  }

  private sig(): string | null {
    const f = this.fields();
    return 'args' in f ? JSON.stringify(f.args) : null;
  }

  /** Whether there is enough to test: the model, the base URL (LLM), and a key (the classifier; an LLM may run without one). */
  private complete(): boolean {
    const cur = this.cur;
    if (!cur) return false;
    if (!this.model()) return false;
    if (this.role === 'llm') return this.locked('base_url') || !!this.base.value.trim();
    return !!(this.key.value.trim() || cur.key_set);
  }

  /** Syncs buttons and hints with the fields; `force` also reloads the fields from the bridge's state. */
  refresh(force = false): void {
    const cur = this.cur;
    const known = !!cur;
    this.root.hidden = !known;
    if (!cur) return;
    if (force || !this.dirty) this.fill();
    this.badge.dataset.state = cur.state;
    this.badge.textContent = BADGE[cur.state];
    const sig = this.sig();
    const tested = sig !== null && sig === this.testedSig;
    const idle = !this.busy;
    this.test.disabled = !idle || !this.complete() || sig === null;
    this.save.disabled = !idle || !tested;
    this.clear.disabled = !idle || !(cur.state !== 'off' && (cur.key_set || cur.model !== '' || (this.llmCur?.base_url ?? '') !== ''));
    this.load.disabled = !idle || (this.role === 'classifier' ? !(this.key.value.trim() || cur.key_set) : !(this.locked('base_url') ? true : this.base.value.trim()));
    this.key.disabled = this.locked('key');
    this.base.disabled = this.locked('base_url');
    this.modelIn.disabled = this.modelSel.disabled = this.locked('model');
    this.hints(cur);
    this.paintStatus(cur, tested);
  }

  /** Puts the bridge's settings into the fields (never a key: the bridge has none to send). */
  private fill(): void {
    const cur = this.cur;
    if (!cur) return;
    const llm = this.llmCur;
    if (llm) {
      this.base.value = llm.base_url;
      this.modelIn.value = llm.model;
      this.extra.value = llm.extra_body ? JSON.stringify(llm.extra_body) : '';
    } else {
      this.setSelect(cur.model);
    }
    if (!this.key.disabled) this.key.value = '';
  }

  private setSelect(want: string): void {
    const ids = new Set(this.models.map((m) => m.id));
    if (want) ids.add(want);
    const sel = this.modelSel;
    sel.replaceChildren();
    if (!ids.size) {
      const o = el('option', '', 'Load models to choose');
      o.value = '';
      sel.append(o);
    }
    for (const m of this.models) sel.append(Object.assign(el('option', '', m.description ? `${m.id} — ${m.description}` : m.id), { value: m.id }));
    if (want && !this.models.some((m) => m.id === want)) sel.append(Object.assign(el('option', '', want), { value: want }));
    sel.value = want && ids.has(want) ? want : (sel.options[0]?.value ?? '');
  }

  private hints(cur: NonNullable<AiSectionHandleCur>): void {
    const lockText = 'Set by the bridge environment.';
    this.keyHint.textContent = this.locked('key')
      ? `${lockText}${cur.key_hint ? ` Ends in ${cur.key_hint}.` : ''}`
      : cur.key_set
        ? `A key${cur.key_hint ? ` ending in ${cur.key_hint}` : ''} is saved on the bridge. Leave blank to keep it.`
        : this.role === 'llm'
          ? 'Kept on the bridge, never shown again. Leave blank for an endpoint that needs none.'
          : 'Kept on the bridge, never shown again.';
    this.baseHint.textContent = this.locked('base_url') ? lockText : 'The address up to /v1. The bridge adds /v1 if the endpoint needs it.';
    this.modelHint.textContent = this.locked('model') ? lockText : this.modelNote ?? (this.role === 'llm' ? 'Pick from the list, or type the model id.' : 'Load models with your key, then pick one.');
    this.modelHint.classList.toggle('settings-field-error', this.modelErr);
    const f = this.fields();
    this.extraHint.textContent = 'error' in f ? f.error : 'Added to every request, for what an endpoint needs beyond the standard body.';
    this.extraHint.classList.toggle('settings-field-error', 'error' in f);
    this.extra.setAttribute('aria-invalid', 'error' in f ? 'true' : 'false');
  }

  private modelNote: string | null = null;
  private modelErr = false;

  private paintStatus(cur: NonNullable<AiSectionHandleCur>, tested: boolean): void {
    let text = '';
    let error = false;
    if (this.note) ({ text, error } = this.note);
    else if (tested) text = 'Test passed. Save to use it.';
    else if (cur.state === 'invalid') {
      const le = this.st?.last_error;
      text = `Paused${le && le.role === this.role ? `: ${aiFailureText(le.kind, le.message)}` : '.'} Test again, or enter a new key.`;
      error = true;
    } else if (cur.state === 'incomplete') text = 'A part is missing: fill in the rest, then test.';
    this.status.textContent = text;
    this.status.classList.toggle('settings-field-error', error);
    this.status.hidden = !text;
  }

  private say(text: string, error = false): void {
    this.note = text ? { text, error } : null;
    this.refresh();
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.refresh();
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  private async loadModels(): Promise<void> {
    const f = this.fields();
    if ('error' in f) return this.say(f.error, true);
    const args: AiFields = { role: this.role };
    if (f.args.key) args.key = f.args.key;
    if (f.args.base_url) args.base_url = f.args.base_url;
    this.note = null;
    this.modelNote = 'Loading models…';
    this.modelErr = false;
    const r = await this.run(() => this.host.send('ai.models', args));
    if (!r.ok) {
      this.modelNote = aiFailureText(r.code, r.message);
      this.modelErr = true;
      return this.refresh();
    }
    const data = r.data as Partial<AiModelsAck>;
    this.models = Array.isArray(data.models) ? data.models.filter((m) => typeof m?.id === 'string') : [];
    this.modelErr = false;
    this.modelNote = `${this.models.length} model${this.models.length === 1 ? '' : 's'} loaded.`;
    if (this.role === 'llm') {
      this.modelList.replaceChildren(...this.models.map((m) => Object.assign(el('option'), { value: m.id })));
      if (data.base_url && data.base_url !== this.base.value.trim() && !this.locked('base_url')) {
        this.base.value = data.base_url;
        this.modelNote += ` Using ${data.base_url}.`;
      }
    } else {
      const have = this.model();
      const pick = this.models.some((m) => m.id === have) ? have : this.models.some((m) => m.id === CLASSIFIER_DEFAULT) ? CLASSIFIER_DEFAULT : (this.models[0]?.id ?? '');
      this.setSelect(pick);
    }
    this.dirty = true;
    this.refresh();
  }

  private async runTest(): Promise<void> {
    const f = this.fields();
    if ('error' in f) return this.say(f.error, true);
    const sig = JSON.stringify(f.args);
    this.testedSig = null;
    this.note = { text: 'Testing…', error: false };
    const r = await this.run(() => this.host.send('ai.test', f.args));
    if (!r.ok) return this.say(aiFailureText(r.code, r.message), true);
    const d = r.data as Partial<AiTestAck>;
    if (d.base_url && this.role === 'llm' && !this.locked('base_url') && d.base_url !== this.base.value.trim()) {
      // The bridge added /v1: the fields now say what was tested.
      this.base.value = d.base_url;
      const g = this.fields();
      this.testedSig = 'args' in g ? JSON.stringify(g.args) : null;
    } else this.testedSig = sig;
    const jsonNote = d.json_mode === false ? ' This endpoint ignores JSON mode: answers are read from plain text.' : '';
    this.say(`Test passed in ${timeText(d.latency_ms ?? 0)}.${jsonNote} Save to use it.`);
  }

  private async runSave(): Promise<void> {
    const f = this.fields();
    if ('error' in f) return this.say(f.error, true);
    this.note = { text: 'Saving…', error: false };
    const r = await this.run(() => this.host.send('ai.set', f.args));
    if (!r.ok) {
      this.testedSig = null;
      return this.say(aiFailureText(r.code, r.message), true);
    }
    this.testedSig = null;
    this.dirty = false;
    this.key.value = '';
    this.note = { text: 'Saved. Ready to use.', error: false };
    this.refresh(true);
  }

  /** Clear asks twice: the first click arms it for a few seconds. */
  private runClear(): void {
    if (this.clearTimer === null) {
      this.clear.textContent = 'Click again to clear';
      this.clearTimer = setTimeout(() => this.disarm(), CONFIRM_MS);
      return;
    }
    this.disarm();
    this.note = { text: 'Clearing…', error: false };
    void this.run(() => this.host.send('ai.clear', { role: this.role })).then((r) => {
      if (!r.ok) return this.say(aiFailureText(r.code, r.message), true);
      this.testedSig = null;
      this.dirty = false;
      this.models = [];
      this.modelList.replaceChildren();
      this.modelNote = null;
      this.key.value = '';
      this.note = { text: 'Cleared.', error: false };
      this.refresh(true);
    });
  }

  private disarm(): void {
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.clear.textContent = 'Clear';
  }

  /** The dialog opens: show the bridge's settings, drop an old note and any half-typed key. */
  open(): void {
    this.dirty = false;
    this.note = null;
    this.key.value = '';
    this.disarm();
    this.refresh(true);
  }

  dispose(): void {
    this.disarm();
  }
}

type AiSectionHandleCur = AiClassifier | AiLlm;

/**
 * #92: the “AI integration” section of the Settings window: the bridge-wide classification model (Jev) and
 * OpenAI-compatible LLM. Nothing is sent by configuring: only Load models and Test call out, on the bridge.
 */
export function aiSection(host: AiSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const intro = el('p', 'settings-lede', 'Models the bridge can call for features. A feature has to be switched on separately and says what it sends; nothing is sent until you press Load models or Test.');
    const missing = el('p', 'settings-field-hint', 'This bridge has no AI integration. Update it to use this.');
    const forms = (['classifier', 'llm'] as const).map((r) => new RoleForm(r, host));
    body.append(intro, missing, ...forms.map((f) => f.root));
    const sync = () => {
      missing.hidden = host.book.known;
      for (const f of forms) f.refresh();
    };
    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        missing.hidden = host.book.known;
        for (const f of forms) f.open();
      },
      dispose() {
        off();
        for (const f of forms) f.dispose();
      },
    };
  };
}
