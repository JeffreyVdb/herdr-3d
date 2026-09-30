/** HUD copy for command failures (M3): what went wrong and what to do about it. Pure. */

import type { CommandName } from '../net/protocol';

export interface FailureContext {
  /** The floor (session) the command was about. */
  floor?: string;
  /** M4: the desk (as shown, 1-based) or the worker the command was about. */
  desk?: number;
  worker?: string;
  /** The building name the command was about, or the new name. */
  name?: string;
  /** M7: the issue or pull request the command was about, as people name it (`#9`). */
  item?: string | undefined;
  /** M7: what the provider is called (`GitHub`). */
  provider?: string | undefined;
}

/** What each command does, for "This herdr-world can't … yet". */
const DOES: Record<CommandName, string> = {
  // M5
  'terminal.watch': 'show laptop screens',
  'terminal.unwatch': 'show laptop screens',
  'worker.keys': 'type on a worker’s laptop',
  // M16
  'transcript.watch': 'show a worker’s conversation',
  'transcript.unwatch': 'show a worker’s conversation',
  'transcript.page': 'show a worker’s conversation',
  'transcript.item': 'show a worker’s conversation',
  'building.create': 'create buildings',
  'building.rename': 'rename buildings',
  'building.delete': 'delete buildings',
  'building.reorder': 'reorder buildings',
  'floor.assign': 'move floors',
  'floor.wake': 'wake floors',
  'floor.sleep': 'put floors to sleep',
  'floor.settings.set': 'store floor settings',
  'hire.prepare': 'hire workers',
  'worker.hire': 'hire workers',
  'worker.fire.prepare': 'send workers home',
  'worker.fire': 'send workers home',
  // M5
  'worker.prompt': 'send prompts',
  'worker.answer': 'answer questions',
  'worker.changes': 'show changes',
  // M6 start
  'preset.create': 'keep team presets',
  'preset.update': 'keep team presets',
  'preset.delete': 'keep team presets',
  'run.prepare': 'start runs',
  'run.start': 'start runs',
  // M7
  'board.watch': 'show the issues and pull request boards',
  'board.unwatch': 'show the issues and pull request boards',
  'board.refresh': 'show the issues and pull request boards',
  'limits.refresh': 'read the plan limits',
  'issue.get': 'read issues',
  'issue.comment': 'comment on issues',
  'issue.close': 'close issues',
  'issue.set_status': 'move issues between columns',
  'pr.get': 'read pull requests',
  'pr.comment': 'comment on pull requests',
  'pr.merge': 'merge pull requests',
  'worker.open_pr.prepare': 'open pull requests for workers',
  'worker.open_pr': 'open pull requests for workers',
};

export function failureText(t: CommandName, code: string, message: string, ctx: FailureContext = {}): string {
  const floor = ctx.floor ?? 'This floor';
  const why = message.trim();
  switch (code) {
    case 'offline':
      return 'Not connected to herdr-world, so nothing was sent. Try again once it reconnects.';
    case 'timeout':
      return 'herdr-world did not answer in time. The change may still go through: check before you retry.';
    case 'disconnected':
      return 'The connection to herdr-world dropped before it answered. Check whether the change went through before you retry.';
    case 'unknown_command':
      return `This herdr-world can’t ${DOES[t]} yet${why && !why.startsWith('unknown command') ? ` (${why})` : ''}. Update the bridge to use it.`;
    case 'busy':
      if (t === 'worker.fire' || t === 'worker.fire.prepare') return `${ctx.worker ?? 'This worker'} is still being hired or already on the way out.`;
      return `${floor} is already waking up or going to sleep. Try again once it is done.`;
    case 'invalid_state':
      if (t === 'floor.wake') return `${floor} is already awake.`;
      if (t === 'floor.sleep') return `${floor} is already asleep.`;
      if (t === 'hire.prepare' || t === 'worker.hire' || t === 'worker.fire.prepare' || t === 'worker.fire') return `${floor} is asleep. Wake it from the elevator (L) first.`;
      return `herdr-world refused it: ${why}`;
    case 'wake_failed':
      return `${floor} did not wake up: ${why || 'its server did not answer'}.`;
    case 'sleep_failed':
      return `${floor} did not go to sleep: ${why || 'herdr session stop failed'}.`;
    case 'name_taken':
      return `Another building is already called “${ctx.name ?? ''}”. Pick another name.`;
    case 'not_found':
      if (isBoardCommand(t)) return `${ctx.item ?? 'That item'} is not on the board any more. The board shows what is there now.`;
      return 'That building no longer exists.';
    case 'unknown_session':
      return `herdr-world does not know ${ctx.floor ?? 'that floor'}: it was deleted, or this bridge does not watch it.`;
    case 'bad_request':
      return `herdr-world refused it: ${why}`;
    case 'internal':
      return `herdr-world failed: ${why}. Safe to retry.`;
    case 'desk_taken':
      return `${ctx.desk !== undefined ? `Desk ${ctx.desk}` : 'That desk'} is taken or gone${why ? ` (${why})` : ''}. Pick another free desk.`;
    case 'capacity':
      return `Over the hard cap: ${why || 'there are already as many workers as allowed'}. Send someone home first.`;
    case 'fetch_failed':
      return `git fetch origin failed${why ? ` (${why.replace(/^fetch_failed:\s*/, '')})` : ''}, so no worktree was made and nobody was hired. Fetch again, or hire without a worktree.`;
    case 'hire_failed':
      return `The hire did not go through: ${why || 'herdr-world gave no reason'}.`;
    case 'unknown_worker':
      return `${ctx.worker ?? 'That worker'} is no longer on the floor.`;
    case 'not_clean':
      return `The worktree was kept: ${why || 'it has uncommitted changes or unpushed commits'}.`;
    case 'fire_failed':
      return `${ctx.worker ?? 'The worker'} could not be sent home: ${why || 'herdr-world gave no reason'}.`;
    // M5
    case 'prompt_failed':
      return `The prompt did not reach ${ctx.worker ?? 'the worker'}: ${why.replace(/^prompt_failed:\s*/, '') || 'the agent did not start'}. Your text is still here: try again, or sit at its laptop (E).`;
    case 'stale':
      if (t === 'pr.merge') return `${ctx.item ?? 'The pull request'} changed while you decided (a new commit arrived). Read it again before you merge.`;
      return `${ctx.worker ?? 'The worker'}’s question changed before the answer arrived. The card shows the current one.`;
    case 'input_failed':
      return `herdr could not type into ${ctx.worker ?? 'the worker'}’s pane${why ? `: ${why.replace(/^input_failed:\s*/, '')}` : ''}.`;
    case 'not_a_repo':
      return `${ctx.worker ?? 'This worker'}’s folder is not a git repository, so there are no changes to show.`;
    case 'changes_failed':
      return `git did not answer in time${why ? ` (${why.replace(/^changes_failed:\s*/, '')})` : ''}. Refresh to try again.`;
    // M7: boards
    case 'confirmation_required':
      return `herdr-world wanted a confirmation for that and did not get one${why ? ` (${why})` : ''}.`;
    case 'unsupported':
      return `${ctx.provider ?? 'This provider'} can’t do that here${why ? ` (${why})` : ''}.`;
    case 'provider_failed':
      return `${ctx.provider ?? 'The provider'} refused or failed${why ? `: ${why}` : ''}. Nothing was changed as far as herdr-world knows; try again.`;
    case 'rate_limited':
      return `${ctx.provider ?? 'The provider'} is rate limiting herdr-world${why ? ` (${why})` : ''}. Try again after the reset time on the board.`;
    case 'checks_not_green':
      return `${ctx.item ?? 'The pull request'}’s checks are not passing${why ? ` (${why})` : ''}. Wait for them, or merge anyway.`;
    case 'not_mergeable':
      return `${ctx.item ?? 'The pull request'} is not mergeable${why ? ` (${why})` : ''}.`;
  }
  return `${code}: ${why}`;
}

const isBoardCommand = (t: CommandName): boolean => t.startsWith('issue.') || t.startsWith('pr.') || t.startsWith('worker.open_pr') || t.startsWith('board.');
