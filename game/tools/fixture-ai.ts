// #92: the AI integration, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules, like
// herdr-world's (docs/protocol.md "AI integration"):
// - the snapshot's `ai` holds both roles; no key is ever in it, only `key_set` and `key_hint`;
// - `ai.models` / `ai.test` really call the endpoint: Jev at `simjev=<url>` (the real API when absent) and the
//   LLM at the base URL the game sends; the fakes the e2e starts answer them. 401/403 is `auth_failed`, a missing
//   `/models` is `no_models_endpoint` (after trying `/v1`);
// - `ai.set` is `test_required` unless exactly that config passed `ai.test`, as submitted or as resolved (the base
//   URL with /v1 added); a blank key keeps the stored one;
// - every change is an `ai.update` event with the state flat in it;
// - `simai=off` plays a bridge without the service: `ai.*` is `unsupported`; `simfail=no_ai` a bridge before #92.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

interface Cls {
  model: string;
  key: string;
}
interface Llm {
  base_url: string;
  model: string;
  key: string;
  extra: Obj | null;
  json_mode: boolean | null;
}

class AiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const hint = (k: string) => (k.length >= 8 ? k.slice(-4) : '');
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export class AiSim {
  private cls: Cls | null = null;
  private llm: Llm | null = null;
  private readonly invalid = new Set<string>();
  private readonly passed = new Map<string, { fps: string[]; base_url: string; json_mode: boolean | null }>();
  /** #90: told after every change of the state (the follow-up questions' own state follows it). */
  onChange: ((send: Send) => void) | null = null;

  constructor(
    private readonly jev: string,
    private readonly mode: 'on' | 'off' | 'old',
    private readonly emit: (send: Send, m: Obj) => void,
    private readonly error: (code: string, message: string) => Error,
  ) {}

  private conv(e: unknown): unknown {
    return e instanceof AiError ? this.error(e.code, e.message) : e;
  }

  private state(role: 'classifier' | 'llm'): string {
    if (role === 'classifier') {
      const c = this.cls;
      if (!c || (!c.model && !c.key)) return 'off';
      if (!c.model || !c.key) return 'incomplete';
      return this.invalid.has(role) ? 'invalid' : 'ready';
    }
    const l = this.llm;
    if (!l || (!l.base_url && !l.model && !l.key)) return 'off';
    if (!l.base_url || !l.model) return 'incomplete';
    return this.invalid.has(role) ? 'invalid' : 'ready';
  }

  view(): Obj {
    const c = this.cls;
    const l = this.llm;
    return {
      classifier: { state: this.state('classifier'), model: c?.model ?? '', key_set: !!c?.key, key_hint: hint(c?.key ?? ''), env: [] },
      llm: {
        state: this.state('llm'),
        base_url: l?.base_url ?? '',
        model: l?.model ?? '',
        key_set: !!l?.key,
        key_hint: hint(l?.key ?? ''),
        json_mode: l?.json_mode ?? null,
        ...(l?.extra ? { extra_body: l.extra } : {}),
        env: [],
      },
    };
  }

  decorate(world: Obj): void {
    if (this.mode === 'on') world.ai = this.view();
  }

  /** The config a request means: the stored one with the named fields over it. */
  private draft(role: 'classifier' | 'llm', a: Obj): { key: string; model: string; base_url: string; extra: Obj | null } {
    const cur = role === 'llm' ? this.llm : this.cls;
    const key = str(a.key) ? (a.key as string) : (cur?.key ?? '');
    const model = str(a.model) ?? cur?.model ?? '';
    const llm = this.llm;
    let base_url = role === 'llm' ? (str(a.base_url) ?? llm?.base_url ?? '').trim().replace(/\/+$/, '') : '';
    if (role === 'llm' && base_url && !/^https?:\/\/[^/@?#\s]+/.test(base_url)) throw new AiError('bad_request', 'the base URL must be an http:// or https:// address');
    let extra: Obj | null = role === 'llm' ? (llm?.extra ?? null) : null;
    if (role === 'llm' && 'extra_body' in a) {
      if (a.extra_body === null) extra = null;
      else if (isObj(a.extra_body)) extra = a.extra_body;
      else throw new AiError('bad_request', 'extra_body must be a JSON object');
    }
    base_url = base_url || '';
    return { key, model, base_url, extra };
  }

  private fp(role: string, d: { key: string; model: string; base_url: string; extra: Obj | null }): string {
    return JSON.stringify([role, d.base_url, d.model, d.key, d.extra]);
  }

  private async call(method: string, url: string, key: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        redirect: 'manual',
        headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AiError('unreachable', 'the endpoint cannot be reached');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) throw new AiError('auth_failed', `the key was rejected (HTTP ${res.status})`);
    return { status: res.status, json };
  }

  private async listLlm(base: string, key: string): Promise<{ base: string; models: Array<{ id: string }> }> {
    const tryList = async (b: string) => {
      const r = await this.call('GET', `${b}/models`, key);
      if (r.status === 404) return null;
      const data = isObj(r.json) && Array.isArray(r.json.data) ? r.json.data : null;
      if (r.status !== 200 || !data) throw new AiError('bad_response', 'the model list is not the expected shape');
      return data.filter(isObj).map((m) => ({ id: String(m.id) }));
    };
    const first = await tryList(base);
    if (first) return { base, models: first };
    const second = base.endsWith('/v1') ? null : await tryList(`${base}/v1`);
    if (second) return { base: `${base}/v1`, models: second };
    throw new AiError('no_models_endpoint', 'the endpoint has no /models: type the model id');
  }

  private async models(a: Obj): Promise<Obj> {
    const role = this.role(a);
    const d = this.draft(role, a);
    if (role === 'classifier') {
      if (!d.key) throw new AiError('incomplete', 'enter the key first');
      const r = await this.call('GET', `${this.jev}/v1/models`, d.key);
      const list = isObj(r.json) && Array.isArray(r.json.models) ? r.json.models : null;
      if (!list) throw new AiError('bad_response', 'the model list is not the expected shape');
      return { models: list.filter(isObj).map((m) => ({ id: String(m.name), description: str(m.description) ?? '' })) };
    }
    if (!d.base_url) throw new AiError('incomplete', 'enter the base URL first');
    const { base, models } = await this.listLlm(d.base_url, d.key);
    return { models: models.sort((x, y) => x.id.localeCompare(y.id)), base_url: base };
  }

  private async test(a: Obj): Promise<Obj> {
    const role = this.role(a);
    const d = this.draft(role, a);
    const t0 = Date.now();
    let res: Obj;
    let pass: { base_url: string; json_mode: boolean | null };
    try {
      if (role === 'classifier') {
        if (!d.key || !d.model) throw new AiError('incomplete', 'the key and the model are both needed');
        const r = await this.call('POST', `${this.jev}/v1/systemone`, d.key, {
          model: d.model,
          state: { message: 'Hello, how are you today?' },
          questions: { question: { type: 'noul', instructions: 'Is the message a greeting?' } },
        });
        const score = isObj(r.json) && isObj(r.json.answers) && isObj(r.json.answers.question) ? r.json.answers.question.noul : undefined;
        if (typeof score !== 'number' || score < 0 || score > 1) throw new AiError('bad_response', 'the answer has no score in [0,1]');
        res = { ok: true, score };
        pass = { base_url: '', json_mode: null };
      } else {
        if (!d.base_url || !d.model) throw new AiError('incomplete', 'the base URL and the model are both needed');
        let base = d.base_url;
        try {
          base = (await this.listLlm(d.base_url, d.key)).base;
        } catch (e) {
          if (e instanceof AiError && ['auth_failed', 'unreachable'].includes(e.code)) throw e;
        }
        const chat = (json: boolean) =>
          this.call('POST', `${base}/chat/completions`, d.key, {
            model: d.model,
            messages: [{ role: 'user', content: 'Reply with exactly this JSON object and nothing else: {"ok": true}' }],
            max_tokens: 64,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            ...(d.extra ?? {}),
          });
        let mode = true;
        let r = await chat(true);
        if (r.status === 400) {
          mode = false;
          r = await chat(false);
        }
        if (r.status !== 200) throw new AiError('provider_failed', `the provider answered HTTP ${r.status}`);
        res = { ok: true, json_mode: mode, base_url: base };
        pass = { base_url: base, json_mode: mode };
      }
    } catch (e) {
      if (e instanceof AiError && e.code === 'auth_failed') this.markInvalidIfInUse(role, d);
      throw e;
    }
    res.latency_ms = Date.now() - t0;
    const fps = [this.fp(role, d)];
    if (role === 'llm' && pass.base_url !== d.base_url) fps.push(this.fp(role, { ...d, base_url: pass.base_url }));
    this.passed.set(role, { fps, ...pass });
    return res;
  }

  private markInvalidIfInUse(role: 'classifier' | 'llm', d: { key: string; model: string; base_url: string; extra: Obj | null }): void {
    const cur = role === 'llm' ? this.llm : this.cls;
    if (cur && cur.key === d.key && cur.model === d.model) this.invalid.add(role);
  }

  private set(a: Obj): void {
    const role = this.role(a);
    const d = this.draft(role, a);
    const p = this.passed.get(role);
    if (!p || !p.fps.includes(this.fp(role, d))) throw new AiError('test_required', 'test these settings first: they have not passed a test');
    this.invalid.delete(role);
    if (role === 'classifier') this.cls = { model: d.model, key: d.key };
    else this.llm = { base_url: p.base_url || d.base_url, model: d.model, key: d.key, extra: d.extra, json_mode: p.json_mode };
  }

  private role(a: Obj): 'classifier' | 'llm' {
    if (a.role === 'classifier' || a.role === 'llm') return a.role;
    throw new AiError('bad_request', 'role must be classifier or llm');
  }

  /** Runs one `ai.*` command; true when it is one. The answer may come later (the fakes are called over HTTP). */
  handle(t: unknown, a: Obj, send: Send, ack: (data?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t === 'sim.ai') {
      // Not a bridge command: plays a feature's call getting the key of `reject` refused.
      const role = this.role(a.reject === undefined ? {} : { role: a.reject });
      this.rejectKey(send, role);
      ack();
      return true;
    }
    if (typeof t !== 'string' || !t.startsWith('ai.') || !['ai.get', 'ai.models', 'ai.test', 'ai.set', 'ai.clear'].includes(t)) return false;
    if (this.mode === 'old') throw this.error('unknown_command', `unknown command: "${t}"`);
    if (this.mode === 'off') throw this.error('unsupported', 'unsupported: the bridge has no AI integration');
    const changed = () => {
      this.emit(send, { t: 'ai.update', ...this.view() });
      this.onChange?.(send);
    };
    const run = async (): Promise<unknown> => {
      switch (t) {
        case 'ai.get':
          return this.view();
        case 'ai.models':
          return this.models(a);
        case 'ai.test': {
          const before = JSON.stringify(this.view());
          const r = await this.test(a);
          if (JSON.stringify(this.view()) !== before) changed();
          return r;
        }
        case 'ai.set':
          this.set(a);
          changed();
          return this.view();
        default: {
          const role = this.role(a);
          if (role === 'llm') this.llm = null;
          else this.cls = null;
          this.passed.delete(role);
          this.invalid.delete(role);
          changed();
          return this.view();
        }
      }
    };
    run().then(ack, (e) => {
      if (JSON.stringify(this.view()).includes('invalid')) changed();
      fail(this.conv(e));
    });
    return true;
  }

  /** Test hook: the stored key of a role is revoked at the provider (a feature's call got a 401). */
  rejectKey(send: Send, role: 'classifier' | 'llm'): void {
    this.invalid.add(role);
    this.emit(send, { t: 'ai.update', ...this.view(), last_error: { role, kind: 'auth_failed', message: 'the key was rejected (HTTP 401)', at: Date.now(), runtime: true } });
    this.onChange?.(send);
  }

  // ---- #90: what a feature calls (tools/fixture-followup.ts) ------------------------------------------

  /** Whether the service exists and the role is ready (a role that is not makes no call). */
  ready(role: 'classifier' | 'llm'): boolean {
    return this.mode === 'on' && this.state(role) === 'ready';
  }

  /** The role's config in use, as a feature's test remembers it. */
  fingerprint(role: 'classifier' | 'llm'): string {
    return JSON.stringify(role === 'llm' ? this.llm : this.cls);
  }

  /** The classifier's score for a yes/no question about `state`. */
  async classify(state: Obj, question: string): Promise<number> {
    const c = this.cls;
    if (!c || !this.ready('classifier')) throw new AiError('not_ready', 'the AI model is not ready');
    const r = await this.call('POST', `${this.jev}/v1/systemone`, c.key, { model: c.model, state, questions: { question: { type: 'noul', instructions: question } } });
    const score = isObj(r.json) && isObj(r.json.answers) && isObj(r.json.answers.question) ? r.json.answers.question.noul : undefined;
    if (typeof score !== 'number' || score < 0 || score > 1) throw new AiError('bad_response', 'the answer has no score in [0,1]');
    return score;
  }

  /** The LLM's completion (JSON mode where the endpoint takes it). */
  async complete(messages: Array<{ role: string; content: string }>, json: boolean): Promise<string> {
    const l = this.llm;
    if (!l || !this.ready('llm')) throw new AiError('not_ready', 'the AI model is not ready');
    const r = await this.call('POST', `${l.base_url}/chat/completions`, l.key, {
      model: l.model,
      messages,
      ...(json && l.json_mode !== false ? { response_format: { type: 'json_object' } } : {}),
      ...(l.extra ?? {}),
    });
    const choice = isObj(r.json) && Array.isArray(r.json.choices) ? r.json.choices[0] : undefined;
    const text = isObj(choice) && isObj(choice.message) ? choice.message.content : undefined;
    // #213: an HTTP failure is the provider's (as `ai.test` and the bridge's ai.KindFailed say), a 200 without text a bad response.
    if (r.status !== 200) throw new AiError('provider_failed', `the provider answered HTTP ${r.status}`);
    if (typeof text !== 'string') throw new AiError('bad_response', 'the answer has no text');
    return text;
  }

  /** Whether the bridge has the service at all. */
  get present(): boolean {
    return this.mode === 'on';
  }
}
