// After a Pay press that cannot go on, the first field to fix is scrolled into view and focused.

/** Text-like fields a buyer fills in: not a radio, a checkbox, a hidden or a read-only input. */
const FIELDS =
  'input:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=button]):not([type=submit]):not([readonly]):not([disabled])';

/** The first field under `root`, in page order, that is marked invalid or empty; null when none is. */
export function firstFieldToFix(root: ParentNode): HTMLInputElement | null {
  return (
    [...root.querySelectorAll<HTMLInputElement>(FIELDS)].find(
      (input) => input.getAttribute('aria-invalid') === 'true' || input.value.trim() === '',
    ) ?? null
  );
}

/**
 * Brings a field into view above the sticky Pay bar and gives it the focus. The scroll is instant
 * for a buyer who asked for reduced motion; the focus never scrolls a second time.
 */
export function revealField(field: HTMLElement): void {
  const calm =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  field.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  field.focus({ preventScroll: true });
}
