/** HUD copy for command failures (M3): what went wrong and what to do about it. Pure. */

import type { CommandName } from '../net/protocol';

export interface FailureContext {
  /** The floor (session) the command was about. */
  floor?: string;
  /** The building name the command was about, or the new name. */
  name?: string;
}

/** What each command does, for "This herdr-world can't … yet". */
const DOES: Record<CommandName, string> = {
  'building.create': 'create buildings',
  'building.rename': 'rename buildings',
  'building.delete': 'delete buildings',
  'building.reorder': 'reorder buildings',
  'floor.assign': 'move floors',
  'floor.wake': 'wake floors',
  'floor.sleep': 'put floors to sleep',
  'floor.settings.set': 'store floor settings',
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
      return `${floor} is already waking up or going to sleep. Try again once it is done.`;
    case 'invalid_state':
      if (t === 'floor.wake') return `${floor} is already awake.`;
      if (t === 'floor.sleep') return `${floor} is already asleep.`;
      return `herdr-world refused it: ${why}`;
    case 'wake_failed':
      return `${floor} did not wake up: ${why || 'its server did not answer'}.`;
    case 'sleep_failed':
      return `${floor} did not go to sleep: ${why || 'herdr session stop failed'}.`;
    case 'name_taken':
      return `Another building is already called “${ctx.name ?? ''}”. Pick another name.`;
    case 'not_found':
      return 'That building no longer exists.';
    case 'unknown_session':
      return `herdr-world does not know ${ctx.floor ?? 'that floor'}: it was deleted, or this bridge does not watch it.`;
    case 'bad_request':
      return `herdr-world refused it: ${why}`;
    case 'internal':
      return `herdr-world failed: ${why}. Safe to retry.`;
  }
  return `${code}: ${why}`;
}
