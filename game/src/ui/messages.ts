/** HUD copy for command failures (M3): what went wrong and what to do about it. Pure. */

import type { CommandName } from '../net/protocol';
import { kaneoFailureText } from '../world/kaneo';
import { scheduleHold } from '../world/hire';

/** The logo requests are HTTP, not commands, but fail with the same codes. */
export type LogoAction = 'logo.set' | 'logo.clear';

export interface FailureContext {
  /** The floor the command was about: its name (#58: never a virtual floor's id). */
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
const DOES: Record<CommandName | LogoAction, string> = {
  // M3d
  'logo.set': 'store building logos',
  'logo.clear': 'store building logos',
  // M5
  'terminal.watch': 'show laptop screens',
  'terminal.unwatch': 'show laptop screens',
  'terminal.zoom': 'show a laptop screen fullscreen',
  'worker.keys': 'type on a worker’s laptop',
  // M16
  'transcript.watch': 'show a worker’s conversation',
  'transcript.unwatch': 'show a worker’s conversation',
  'transcript.page': 'show a worker’s conversation',
  'transcript.item': 'show a worker’s conversation',
  'transcript.image': 'show the images of a conversation',
  'transcript.images': 'show the images of a conversation',
  'building.create': 'create buildings',
  'building.rename': 'rename buildings',
  'building.delete': 'delete buildings',
  'building.reorder': 'reorder buildings',
  'floor.assign': 'move floors',
  'floor.wake': 'wake floors',
  'floor.sleep': 'put floors to sleep',
  'floor.settings.set': 'store floor settings',
  'session.create': 'start new herdr sessions', // #58
  'floor.create': 'add virtual floors', // #58
  'floor.rename': 'rename virtual floors',
  'floor.delete': 'delete virtual floors',
  'floor.hide': 'hide floors',
  'hire.prepare': 'hire workers',
  'hire.interpret': 'understand dictated commands',
  'worker.hire': 'hire workers',
  'worker.fire.prepare': 'send workers home',
  'worker.fire': 'send workers home',
  'worker.wrapup': 'wrap up workers',
  'worker.wrapup.cancel': 'wrap up workers',
  // M5
  'worker.prompt': 'send prompts',
  'worker.answer': 'answer questions',
  'worker.answer_ask': 'answer questions from the transcript',
  'worker.changes': 'show changes',
  'worker.commands': 'list slash commands and skills', // #136
  'worker.files': 'search files', // #137
  'worker.repos': 'list repositories on other floors', // #247
  'hire.commands': 'list skills before a hire', // #39
  'hire.files': 'search files before a hire', // #39
  'hire.repos': 'list repositories before a hire', // #39
  // M6 start
  'preset.create': 'keep team presets',
  'preset.update': 'keep team presets',
  'preset.delete': 'keep team presets',
  'run.prepare': 'start runs',
  'run.start': 'start runs',
  // M7
  'board.watch': 'show the issues and pull request boards',
  'board.unwatch': 'show the issues and pull request boards',
  'host.watch': 'read the server rack’s host stats',
  'host.unwatch': 'read the server rack’s host stats',
  'board.refresh': 'show the issues and pull request boards',
  'limits.refresh': 'read the plan limits',
  'ai.get': 'keep the AI integration',
  'ai.models': 'keep the AI integration',
  'ai.test': 'keep the AI integration',
  'ai.set': 'keep the AI integration',
  'ai.clear': 'keep the AI integration',
  'followups.get': 'keep the follow-up questions',
  'followups.set': 'keep the follow-up questions',
  'followups.test': 'test the follow-up questions',
  'worker.answer_followup': 'answer follow-up questions',
  'worker.dismiss_followup': 'dismiss follow-up questions',
  'worker.retry_followup': 'read follow-up questions again',
  'worker.followup_message': 'show the agent’s message',
  // #223
  'worker.handoff_preview': 'file handoffs',
  'worker.handoff': 'file handoffs',
  'worker.handoff_cancel': 'cancel handoff requests',
  'handoff.list': 'open the filing cabinet',
  'handoff.get': 'open the filing cabinet',
  'handoff.delete': 'delete handoffs',
  // #110
  'packup.get': 'keep pack up on request',
  'packup.set': 'keep pack up on request',
  'packup.test': 'test pack up on request',
  'packup.detect': 'check prompts for pack up on request',
  // #106
  'inbox.dismiss': 'dismiss inbox rows',
  // #98
  'activity.get': 'classify unknown commands',
  'activity.set': 'classify unknown commands',
  // #184
  'kaneo.get': 'connect to Kaneo',
  'kaneo.test': 'connect to Kaneo',
  'kaneo.set': 'connect to Kaneo',
  'kaneo.clear': 'connect to Kaneo',
  'kaneo.workspaces': 'list Kaneo workspaces',
  'kaneo.projects': 'list Kaneo projects',
  'codex_server.get': 'give Codex workers their own server', // #155
  'codex_server.set': 'give Codex workers their own server',
  'repo_refs.get': 'list repositories from other buildings', // #247
  'repo_refs.set': 'list repositories from other buildings',
  'repo_discovery.get': 'scan for repositories', // #54
  'repo_discovery.set': 'scan for repositories',
  'repo_discovery.refresh': 'scan for repositories',
  'worker.answer_async': "answer a Codex worker's question", // #156
  'worker.dismiss_async': "dismiss a Codex worker's question",
  // #118
  'digest.get': 'keep the floor overview summaries',
  'digest.set': 'keep the floor overview summaries',
  'digest.test': 'test the floor overview summaries',
  'digest.retry': 'retry the floor overview summary',
  // #9
  'handoff_llm.get': 'write handoffs with the configured LLM',
  'handoff_llm.set': 'write handoffs with the configured LLM',
  'handoff_llm.test': 'test LLM handoffs',
  'issue.get': 'read issues',
  'issue.comment': 'comment on issues',
  'issue.close': 'close issues',
  'issue.set_status': 'move issues between columns',
  'pr.get': 'read pull requests',
  'pr.comment': 'comment on pull requests',
  'pr.merge': 'merge pull requests',
  'worker.open_pr.prepare': 'open pull requests for workers',
  'worker.open_pr': 'open pull requests for workers',
  // M13 screen
  'screen.share': 'show a shared screen to agents',
  'screen.frame': 'show a shared screen to agents',
  'screen.grab': 'show a shared screen to agents',
  // M13 whiteboard
  'whiteboard.get': 'keep whiteboards',
  'whiteboard.clear': 'keep whiteboards',
  'drops.list': 'list recent drops',
};

export function failureText(t: CommandName | LogoAction, code: string, message: string, ctx: FailureContext = {}): string {
  const floor = ctx.floor ?? 'This floor';
  const why = message.trim();
  if (t === 'worker.answer_async' || t === 'worker.dismiss_async') {
    const asyncWhy = asyncFailure(t, code, why);
    if (asyncWhy) return asyncWhy;
  }
  // #58: the bridge words a refused or failed new session itself (the name rule, what took the name, herdr's error).
  if (t === 'session.create') {
    const which = ctx.name ? `“${ctx.name}”` : 'The floor';
    if (code === 'bad_request' || code === 'name_taken') return why || `${which} can’t be used as a session name. Pick another one.`;
    if (code === 'busy') return why ? `${why} Wait for it to finish.` : `${which} is being started already. Wait for it to finish.`;
    if (code === 'session_create_failed') return why || `herdr did not start ${which}.`;
    if (code === 'unsupported') return `This herdr-world can’t start herdr sessions${why ? ` (${why})` : ''}.`;
  }
  // #58 stage 4: virtual floors. The bridge says what is wrong (the name rule, who works on a floor); its error's
  // prefix ("invalid state: ") is no word for a person.
  if (t === 'floor.create' || t === 'floor.rename' || t === 'floor.delete' || t === 'floor.hide') {
    const which = ctx.floor ? `“${ctx.floor}”` : 'That floor';
    const said = sentence(why.replace(/^(?:invalid state|busy|not found|invalid argument|unknown session|name taken):\s*/i, ''));
    switch (code) {
      case 'bad_request':
      case 'invalid_state':
        return said || 'herdr-world refused it. Nothing changed.';
      case 'busy':
        return said || `${which} is hiring. Try again once the hire is done.`;
      case 'not_found':
        return `${which} no longer exists. The list shows the floors there are now.`;
      case 'unknown_session':
        return t === 'floor.create' ? said || 'That session is gone, or this bridge does not watch it.' : `${which} is gone: its herdr session is away.`;
    }
  }
  // #184: the Kaneo connection's own failures, and a floor's Kaneo link checked at save.
  if ((t.startsWith('kaneo.') || t === 'floor.settings.set') && KANEO_CODES.has(code)) return kaneoFailureText(code, why);
  if (isBoardCommand(t) && code === 'unauthorized') {
    return `${ctx.provider ?? 'The provider'} refused herdr-world’s key (it may be out of its request quota). Nothing changed. Test the connection again in Settings.`;
  }
  if (isBoardCommand(t) && code === 'forbidden') {
    return `${ctx.provider ?? 'The provider'} does not let this key ${DOES[t]}${ctx.item ? ` (${ctx.item})` : ''}: a permission problem there, not a failure. Nothing changed.`;
  }
  switch (code) {
    // #223 handoffs: nothing was filed (or sent home) on any of these.
    case 'handoff_unavailable':
      return `${ctx.worker ?? 'The worker'}’s last reply can’t be filed now: ${why.replace(/^no such handoff candidate:\s*/, '') || 'a newer turn started'}. Nothing was filed.`;
    case 'handoff_source':
      return `The reply in ${ctx.worker ?? 'the worker'}’s transcript is not what it was (the file was replaced, cut or changed), so nothing was filed.`;
    case 'handoff_skill_missing': // #224: nothing was sent to the agent
      return `${ctx.worker ?? 'The worker'}’s agent can’t be asked for a handoff: ${why.replace(/^no handoff skill:\s*/, '') || 'it has no handoff skill'}. Nothing was sent; save its last message instead.`;
    case 'handoff_failed':
      return `The handoff was not filed: ${why.replace(/^filing the handoff failed:\s*/, '') || 'writing it failed'}. Nobody was sent home.`;
    // #9 LLM handoffs: nothing was sent (unavailable) or filed (invalid, stale); the dialog stays open.
    case 'handoff_llm_unavailable':
      return `${why || 'LLM handoffs are not available'}. Nothing was sent; choose another way to file, or fix it in Settings › LLM handoffs.`;
    case 'handoff_llm_invalid':
    case 'handoff_llm_stale':
    case 'handoff_llm_interrupted':
      return why || 'The LLM handoff was not filed.';
    case 'too_large':
      if (why && (t === 'worker.handoff' || t === 'worker.handoff_preview') && /budget/.test(why)) return `${why}.`;
      if (t === 'worker.handoff' || t === 'worker.handoff_preview') return 'That reply is larger than 1 MB: a literal handoff never cuts it, so it can’t be filed.';
      break;
    case 'offline':
      return 'Not connected to herdr-world, so nothing was sent. Try again once it reconnects.';
    case 'unavailable':
      // #187: the game's own refusal for a seat whose worker is away: its message says why.
      return why;
    case 'timeout':
      return 'herdr-world did not answer in time. The change may still go through: check before you retry.';
    case 'disconnected':
      return 'The connection to herdr-world dropped before it answered. Check whether the change went through before you retry.';
    case 'unknown_command':
      return `This herdr-world can’t ${DOES[t]} yet${why && !why.startsWith('unknown command') ? ` (${why})` : ''}. Update the bridge to use it.`;
    case 'busy':
      if (t === 'worker.fire' || t === 'worker.fire.prepare') return `${ctx.worker ?? 'This worker'} is still being hired or already on the way out.`;
      if (t === 'worker.wrapup') return `${ctx.worker ?? 'This worker'} is already wrapping up, being hired or on the way out.`;
      if (t === 'worker.wrapup.cancel') return `${ctx.worker ?? 'This worker'} already reported CLEAN and is on the way out.`;
      return `${floor} is already waking up or going to sleep. Try again once it is done.`;
    case 'invalid_state': {
      if (t === 'floor.wake') return `${floor} is already awake.`;
      if (t === 'floor.sleep') return `${floor} is already asleep.`;
      // #63: a scheduled agent holds the worktree a delete was asked for; the floor is awake.
      const hold = t === 'worker.fire' || t === 'worker.wrapup' ? scheduleHold(why) : null;
      if (hold && t === 'worker.fire') return `${ctx.worker ?? 'The worker'} was not sent home: its worktree is ${hold}. Keep the worktree to send ${ctx.worker ?? 'it'} home now.`;
      if (hold) return `Nothing was sent: the worktree is ${hold}. Keep the worktree to wrap up now.`;
      if (t === 'hire.prepare' || t === 'worker.hire' || t === 'worker.fire.prepare' || t === 'worker.fire') return `${floor} is asleep. Wake it from the elevator (L) first.`;
      return `herdr-world refused it: ${why}`;
    }
    case 'wake_failed':
      return `${floor} did not wake up: ${why || 'its server did not answer'}.`;
    case 'sleep_failed':
      return `${floor} did not go to sleep: ${why || 'herdr session stop failed'}.`;
    case 'name_taken':
      return `Another building is already called “${ctx.name ?? ''}”. Pick another name.`;
    case 'not_found':
      if (isBoardCommand(t)) return `${ctx.item ?? 'That item'} is not on the board any more. The board shows what is there now.`;
      if (t === 'logo.set' || t === 'logo.clear') return `${ctx.name ?? 'That building'} no longer exists, so its logo was not ${t === 'logo.set' ? 'saved' : 'cleared'}.`;
      return 'That building no longer exists.';
    // M3d: logos
    case 'logo_too_large':
      return `That logo is too big${why ? ` (${why.replace(/^logo too large:\s*/, '')})` : ''}. Logos can be up to 1 MB and 8192 px a side: export it smaller, or as an SVG.`;
    case 'logo_unsupported': {
      const reason = why.replace(/^logo unsupported:\s*/, '');
      return `That file can’t be used as a logo${reason ? `: ${reason}` : ''}. Use a PNG, WebP or SVG drawn with plain shapes and paths (no text, images or scripts inside).`;
    }
    case 'logo_invalid':
      return `The bridge could not read that image${why ? ` (${why.replace(/^logo invalid:\s*/, '')})` : ''}. Export it again, or pick another file.`;
    case 'logo_busy':
      return 'herdr-world is busy turning other logos into images. Try again in a moment.';
    case 'forbidden':
      return 'The helper refused the logo request. Reload the game from the helper’s address, then try again.';
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
      if (t === 'worker.wrapup') return `Nothing was sent: ${why.replace(/^not clean:\s*/, '') || 'the worktree has uncommitted changes or unpushed commits'}.`;
      return `The worktree was kept: ${why || 'it has uncommitted changes or unpushed commits'}.`;
    case 'fire_failed':
      return `${ctx.worker ?? 'The worker'} could not be sent home: ${why || 'herdr-world gave no reason'}.`;
    // M5
    case 'prompt_failed':
      return `The prompt did not reach ${ctx.worker ?? 'the worker'}: ${why.replace(/^prompt_failed:\s*/, '') || 'the agent did not start'}. Your text is still here: try again, or sit at its laptop (E).`;
    case 'stale':
      if (t === 'issue.set_status') return `The board changed while you moved ${ctx.item ?? 'the card'}. It shows what is there now; try again.`;
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
      // A move can fail halfway (the status written, the place not): the board refreshes after either.
      if (t === 'issue.set_status') return `${ctx.provider ?? 'The provider'} refused or failed${why ? `: ${why}` : ''}. The board shows where ${ctx.item ?? 'the card'} is now.`;
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

const KANEO_CODES = new Set(['unauthorized', 'forbidden', 'bad_url', 'key_required', 'test_required', 'not_configured', 'unreachable', 'not_found', 'stale', 'rate_limited', 'provider_failed', 'unsupported']);

const isBoardCommand = (t: CommandName | LogoAction): boolean => t.startsWith('issue.') || t.startsWith('pr.') || t.startsWith('worker.open_pr') || t.startsWith('board.');

/**
 * #157: a Codex async question's answer or hiding refused by the bridge (docs/protocol.md "Codex async questions"):
 * nothing reached Codex. The card keeps the answer; these say why and what to do. `stale` is no failure: the question
 * had moved on already (often a send of ours the card was not shown yet), and the card shows where it is now.
 */
function asyncFailure(t: 'worker.answer_async' | 'worker.dismiss_async', code: string, why: string): string | null {
  const answer = t === 'worker.answer_async';
  switch (code) {
    case 'stale':
      return answer
        ? 'Already sent, answered or hidden — nothing more went to Codex. The card shows where it is now.'
        : 'Not hidden: the question changed meanwhile. The card shows it as it is now.';
    case 'invalid_state':
      return answer
        ? 'Not sent: herdr-3d is not connected to this Codex thread right now (or the question cannot be answered from here). Answer in the terminal.'
        : 'Not hidden: this is not a Codex worker with its own server.';
    case 'input_failed':
      return `Not sent: Codex refused it${why ? ` (${why.replace(/^input_failed:\s*/, '')})` : ''}. Send it again.`;
    case 'bad_request':
      return `Not sent: ${why.replace(/^bad (request|args):\s*/, '') || 'herdr-world refused the answer'}.`;
  }
  return null;
}

/** `s` as a sentence: a capital first letter, a full stop at the end ('' stays ''). */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? '' : '.'}`;
}
