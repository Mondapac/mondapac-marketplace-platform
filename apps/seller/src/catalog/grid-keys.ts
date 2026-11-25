import type { KeyboardEvent } from 'react';

/** A field a seller types into: a text input that is not disabled (not a checkbox or switch). */
const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])';

/**
 * Spreadsheet keys for a table of fields (Offer page PR 5): Tab moves right as usual; Enter moves
 * to the same column one row down and Shift+Enter one row up. Enter never submits the form, so
 * prices and stock are saved only with the Save button. Rows with another shape (an open Details
 * row) are skipped.
 */
export function moveOnEnter(event: KeyboardEvent<HTMLElement>): void {
  // An input method still composing (Safari says so only with key code 229) keeps its Enter.
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches(FIELD)) return;
  const cell = target.closest('td');
  const row = cell?.parentElement;
  if (cell == null || !(row instanceof HTMLTableRowElement) || row.parentElement === null) return;
  event.preventDefault();
  const rows = Array.from(row.parentElement.children).filter(
    (item): item is HTMLTableRowElement =>
      item instanceof HTMLTableRowElement && item.cells.length === row.cells.length,
  );
  const step = event.shiftKey ? -1 : 1;
  for (let at = rows.indexOf(row) + step; at >= 0 && at < rows.length; at += step) {
    const next = rows[at]?.cells[cell.cellIndex]?.querySelector<HTMLInputElement>(FIELD);
    if (next != null) {
      next.focus();
      next.select();
      return;
    }
  }
}

/**
 * Puts the cursor in the first price field that is still empty (else the first one) inside
 * `root`: a new draft starts where the seller types first.
 */
export function focusFirstPrice(
  root: HTMLElement | null,
  selector = 'input[name^="price-"]',
): void {
  if (root === null) return;
  const fields = Array.from(root.querySelectorAll<HTMLInputElement>(selector)).filter(
    (field) => !field.disabled,
  );
  const first = fields.find((field) => field.value.trim() === '') ?? fields[0];
  if (first === undefined) return;
  first.focus({ preventScroll: true });
  first.scrollIntoView?.({ block: 'center' });
}
