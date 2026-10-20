// Model responses shared by the loopback provider fakes and the optional in-process UI fixture. These UI cases
// exercise the feature's classification, cutting and confirmation flow; provider latency and timeout behavior have
// separate HTTP and client tests. Settings still tests and saves the real loopback endpoints before these replies run.

export type FixtureModel = 'packup' | 'hiring';
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const CUTS: Array<[RegExp, (p: string) => string]> = [
  [/TAMPER/, () => ' and finish your day'],
  [/^Go home and clean up/, (p) => p],
  [/ and end your turn$/, () => ' and end your turn'],
  [/ and stop working$/, () => ' and stop working'],
  [/, leave the office and clean up the worktree$/, () => ', leave the office and clean up the worktree'],
  [/, then go home\.?$/, () => ', then go home'],
];

export const packupScore = (prompt: string): number => /end your turn|stop working|leave the office|go home|Go home|finish the day/.test(prompt) ? 0.97 : 0.03;
export const hiringScore = (prompt: string): number => /\bstart\b.*\bagent\b/i.test(prompt) ? 0.97 : 0.03;

export function packupParts(prompt: string): string[] {
  const cut = CUTS.find(([re]) => re.test(prompt));
  return cut ? [cut[1](prompt)] : [];
}

/** Only runtime feature requests are answered here; model lists and Settings' test requests still use HTTP. */
export function fixtureModelResponse(model: FixtureModel, method: string, url: string, body: unknown): { status: number; json: unknown } | null {
  if (method !== 'POST' || !object(body)) return null;
  const path = new URL(url).pathname;
  if (path.endsWith('/systemone') && object(body.state) && typeof body.state.prompt === 'string') {
    // Explicit slow-provider cases keep their HTTP delay and the real classifier timeout.
    if (model === 'packup' && body.state.prompt.includes('SLOW')) return null;
    return { status: 200, json: { answers: { question: { noul: (model === 'packup' ? packupScore : hiringScore)(body.state.prompt) } } } };
  }
  if (model === 'packup' && path.endsWith('/chat/completions') && Array.isArray(body.messages)) {
    const last: unknown = body.messages.at(-1);
    if (object(last) && typeof last.content === 'string' && last.content.startsWith('The prompt:\n\n')) {
      const content = JSON.stringify({ remove: packupParts(last.content.slice('The prompt:\n\n'.length)) });
      return { status: 200, json: { choices: [{ message: { content } }] } };
    }
  }
  return null;
}
