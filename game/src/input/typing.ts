/**
 * #124: is the keyboard a text field's? A letter typed there is the field's, never a shortcut (WCAG 2.1.4: a
 * single-character shortcut must not fire while a component that takes characters has focus).
 *
 * Every kind of field the game has: `<input>`, `<textarea>`, `<select>` (type-ahead), anything contenteditable (the
 * hire / Start Run composer, whose editor is one), and the ARIA text roles a custom widget may use. The seat bar's hidden
 * keyboard (`.seat-input`, the terminal's own) is a field too: the laptop owns its keys before the game looks.
 */
const FIELD = 'input, textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]';
const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

export function typingIn(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // A field of a dialog that has just closed keeps the focus until the next frame: nobody types there, the keys are the game's.
  if (t.closest('dialog:not([open])')) return false;
  // `isContentEditable` follows the inheritance (a child of a contenteditable) and `contenteditable="false"` (not one); the selector is jsdom's, which has no such property.
  return t.isContentEditable === true || t.closest(`${FIELD}, ${EDITABLE}`) !== null;
}
