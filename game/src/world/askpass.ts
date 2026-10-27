/**
 * #213: the password dialog's sudo rewrite, a port of the bridge's `internal/manual/askpass/rewrite.go` (the authority).
 * `askpass.test.ts` checks every case of the bridge's `testdata/eligibility.json`. A simple, top-level `sudo` invocation
 * gets ` -A` right after `sudo`; nothing else changes (leading blanks and a trailing line break stay as they were).
 * Shell operators, substitutions, a second line and sudo's own -A, -S and -n are left to the terminal.
 */

const LONG_WITH_VALUE = new Set(['--user', '--group', '--host', '--prompt', '--chdir', '--chroot', '--role', '--type', '--close-from', '--command-timeout', '--auth-type']);
const FORBIDDEN_LONG = ['--askpass', '--stdin', '--non-interactive'];

/** The launched form, or null when the command cannot use the password dialog. */
export function askpassRewrite(full: string): string | null {
  const cmd = full.replace(/[ \t\r\n]+$/, '');
  let i = 0;
  while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
  if (!cmd.startsWith('sudo', i) || i + 4 >= cmd.length || (cmd[i + 4] !== ' ' && cmd[i + 4] !== '\t')) return null;
  const fields = simpleWords(cmd.slice(i + 4));
  if (!fields?.length) return null;
  let command = false;
  for (let j = 0; j < fields.length && !command; j++) {
    const f = fields[j]!;
    if (f === '--') {
      if (j + 1 >= fields.length) return null;
      command = true;
      continue;
    }
    if (!f.startsWith('-') || f === '-') {
      command = true;
      break;
    }
    if (f.startsWith('--')) {
      const name = f.split('=')[0]!;
      // sudo takes an unambiguous abbreviation of a long option: `--non` is --non-interactive.
      if (FORBIDDEN_LONG.some((forbidden) => forbidden.startsWith(name))) return null;
      if (LONG_WITH_VALUE.has(f) && ++j >= fields.length) return null;
      continue;
    }
    for (let k = 1; k < f.length; k++) {
      if ('ASn'.includes(f[k]!)) return null;
      if ('ughpCDRrtTa'.includes(f[k]!)) {
        if (k === f.length - 1 && ++j >= fields.length) return null;
        break;
      }
    }
  }
  return command ? `${full.slice(0, i + 4)} -A${full.slice(i + 4)}` : null;
}

/** Shell words without evaluating them; null when an operator, a substitution or a line break shows up. */
function simpleWords(input: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  const flush = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '\n' || c === '\r') return null;
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= input.length || input[i + 1] === '\n' || input[i + 1] === '\r') return null;
      word += input[++i];
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '$' || c === '`') return null;
      else word += c;
      continue;
    }
    if (c === ' ' || c === '\t') flush();
    else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (';|&<>()$`'.includes(c)) return null;
    else if (c === '#' && !started) return null;
    else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  flush();
  return words;
}

export const askpassEligible = (command: string): boolean => askpassRewrite(command) !== null;
/** The launched form of an eligible command (the command itself when it is not). */
export const askpassForm = (command: string): string => askpassRewrite(command) ?? command;
