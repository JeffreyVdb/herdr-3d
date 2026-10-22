# Keyboard shortcuts

<!-- Generated from game/src/input/shortcuts.ts by `game/src/input/shortcuts.test.ts`: edit the table there, then run `H3D_WRITE_SHORTCUTS_DOC=1 make game-test`. -->

Press **?** in the game for the same list, with the keys named as your keyboard labels them (⌘ on a Mac, where this page says Ctrl/⌘).

Single keys work only when the scene has the keyboard: they pause while a text field, a list or a dialog has it (WCAG 2.1.4). **Ctrl/⌘+/** opens the list from inside a field, and **Ctrl/⌘+P** opens the command palette from every view (a laptop included). In it, type to find a command, or start with **@** to jump to a floor. Seated at a laptop every key goes to the terminal except the few below, and there is no help key there: **Esc**, then **?**.

## On a floor

Walking around an office, its lobby or the street.

| Keys | Does |
| --- | --- |
| `?` | This shortcut list (over any dialog; not at a laptop or the whiteboard) |
| `Ctrl/⌘` + `P` | The command palette: type to run a command, @ to jump to a floor (from every view, a text field and a laptop too) |
| `Ctrl/⌘` + `Shift` + `Space` | The dictation bar: say, type or paste a command, Enter reads it (from every view, a text field, a dialog and a laptop too; again closes it) |
| `N` | Next worker who needs you |
| `Shift` + `N` | Inbox list: who needs you or is done |
| `Shift` + `L` | Plan limits |
| `B` | Battery saver |
| `,` | Settings |
| `O` | Overview: everyone on this floor and what they are doing; off an office floor, every floor’s |
| `W A S D` or `↑ ← ↓ →` | Walk (the arrows turn left and right) |
| `Page Up` or `Page Down` | Look up and down |
| `Home` | Level the view |
| `H` | Hire a worker at the first free desk |
| `I` | Issues board |
| `G` | Pull requests board |
| `Shift` + `R` | Start a run at the first free desk |
| `L` | Elevator |
| `Tab` | Floor plan |
| `Shift` + `Tab` | Into the top bar (then Tab and Enter) |
| `Backspace` | Back to the city |
| `Esc` | Get up from your desk |
| `Esc` | Close the floor plan |

## In the city

The view from above, before you go inside.

| Keys | Does |
| --- | --- |
| `?` | This shortcut list (over any dialog; not at a laptop or the whiteboard) |
| `Ctrl/⌘` + `P` | The command palette: type to run a command, @ to jump to a floor (from every view, a text field and a laptop too) |
| `Ctrl/⌘` + `Shift` + `Space` | The dictation bar: say, type or paste a command, Enter reads it (from every view, a text field, a dialog and a laptop too; again closes it) |
| `N` | Next worker who needs you |
| `Shift` + `N` | Inbox list: who needs you or is done |
| `Shift` + `L` | Plan limits |
| `B` | Battery saver |
| `,` | Settings |
| `O` | Overview: everyone on this floor and what they are doing; off an office floor, every floor’s |
| `M` | Buildings |
| `Tab` or `Enter` | Tab reaches the floors, then the buildings; Enter goes inside |
| `Esc` | Let go of the focused building |

## Aimed at something

Look at it with the crosshair, or pick it without the mouse: T and Shift+T cycle the workers, desks and props.

| Keys | Does |
| --- | --- |
| `Esc` | Let go of what you picked (moving or turning does too) |
| `T` | Pick the next worker, desk or prop, and turn to it |
| `Shift` + `T` | Pick the previous one |
| `E` | Worker: sit at their laptop |
| `P` | Worker: send a prompt |
| `C` | Worker: their Changes (again closes it) |
| `X` | Worker: send them home |
| `F` | Worker: file their last reply as a handoff, as written (no AI call) |
| `1–9` or `0` | Worker: answer their question with that choice; 0 denies |
| `E` | Empty desk: hire here |
| `E` | Your desk: sit down |
| `E` | Issues or pull requests board: open it |
| `E` | Elevator: ride |
| `E` | Reception: the floor directory |
| `E` | Whiteboard: draw |
| `E` | Lounge screen: the floor overview, growing out of it |
| `E` | Departures board: its floor’s scheduled agents (in a lobby: a floor’s group, that floor’s; elsewhere on the board, every floor’s) |
| `E` | Filing cabinet: the floor’s handoffs (search, read, copy, hire from one) |
| `E` | Radio: next genre |
| `R` | Radio: next track |

## Dialogs and fields

Open dialogs and their fields own the keyboard.

| Keys | Does |
| --- | --- |
| `Ctrl/⌘` + `P` | The command palette: type to run a command, @ to jump to a floor (from every view, a text field and a laptop too) |
| `Ctrl/⌘` + `Shift` + `Space` | The dictation bar: say, type or paste a command, Enter reads it (from every view, a text field, a dialog and a laptop too; again closes it) |
| `Ctrl/⌘` + `/` | The shortcut list, from inside a text field |
| `Esc` | Close the dialog |
| `Ctrl/⌘` + `Enter` | Submit: hire, Start Run, open a pull request, a board comment, confirm a secrets review |
| `Enter` | Send, in the conversation’s prompt box |
| `F` | On the overview page: active workers only, or everyone |
| `A` | On a floor’s overview page: every floor’s |
| `Shift` + `Enter` | A new line, in the hire task and the prompt boxes |
| `↑ ↓` or `Tab` | In a prompt box’s suggestion list (after / or @): ↑ ↓ choose, Tab or Enter picks, Esc closes only the list |
| `Ctrl/⌘` + `Shift` + `X` | In a prompt box, or any text that goes to an agent, a model or a saved prompt (a hire’s task, a run, a schedule, an answer, a handoff instruction): review its possible secrets now, to mark one the scan missed (with “Review prompt secrets” on) |
| `N` or `Shift` + `N` | In the secrets review: the next or the previous match |
| `Space` | In the secrets review, on a match: protect it as a file, or ignore it (Enter too) |
| `← →` or `Shift` + `← →` | In the secrets review, on a match: move its end, or (with Shift) its start, by one character |
| `M` or `Delete` | In the secrets review: mark the text selected in the prompt as a secret; Delete takes a mark you made away |

## At a laptop

Every key goes to the terminal or the conversation, except these. Esc stands you up; then ? opens this list.

| Keys | Does |
| --- | --- |
| `Esc` | Stand up (from a subagent’s conversation: back to its worker’s first) |
| `Ctrl` + `Esc` | Terminal or conversation |
| `Ctrl/⌘` + `P` | The command palette (the terminal no longer gets Ctrl+P; ↑ is still previous history) |
| `Ctrl/⌘` + `Shift` + `Space` | The dictation bar (the terminal does not get this chord) |
| `O` | The floor overview, over the conversation (Esc comes back) |
| `Q` | The questions waiting for you, from the conversation (while its questions button shows). In them: 1–9, ↑ ↓ and Enter pick, Ctrl/⌘+Enter sends, Esc closes, Ctrl+Esc goes to the terminal |
| `Ctrl` + `,` | The terminal’s preset and zoom controls |
| `Ctrl` + `+` or `Ctrl` + `−` or `Ctrl` + `0` | Zoom in, out and back to 100% |
