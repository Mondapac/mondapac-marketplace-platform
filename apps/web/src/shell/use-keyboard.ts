'use client';

import { useEffect } from 'react';

/**
 * Whether the on-screen keyboard is open on a touch device: a text field has focus and the
 * pointer is coarse, or (an extra signal for browsers that shrink the visual viewport) the
 * visual viewport lost this much of the layout viewport's height. The tab bar hides while it is
 * open so the field under it stays in view.
 */
export const KEYBOARD_MIN_DROP = 150;

/** The attribute on <html> while the keyboard is open (`data-keyboard="open"`). */
export const KEYBOARD_ATTRIBUTE = 'data-keyboard';

/** Input types that do not bring up the keyboard. */
const NO_KEYBOARD = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'file',
  'hidden',
  'image',
  'month',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'week',
]);

/** A field that takes typing or a choice: a text-like input, a textarea, a select, an editable element. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement)
    return !target.disabled && !target.readOnly && !NO_KEYBOARD.has(target.type);
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (target instanceof HTMLSelectElement) return !target.disabled;
  const editable = target.getAttribute('contenteditable');
  return target.isContentEditable === true || (editable !== null && editable !== 'false');
}

/** Whether the visual viewport is much shorter than the layout viewport (zoomed in does not count). */
function viewportShrunk(): boolean {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale > 1.01) return false;
  return window.innerHeight - viewport.height >= KEYBOARD_MIN_DROP;
}

/**
 * Sets `data-keyboard="open"` on <html> while the on-screen keyboard is up on a touch device and
 * removes it on blur, so CSS can hide the tab bar. Does nothing for a mouse (a fine pointer).
 */
export function useKeyboardOpen(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const root = document.documentElement;
    const coarse = window.matchMedia('(pointer: coarse)');
    let focused = false;

    const update = () => {
      const open = coarse.matches && (focused || viewportShrunk());
      if (open) root.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
      else root.removeAttribute(KEYBOARD_ATTRIBUTE);
    };
    const onFocusIn = (event: FocusEvent) => {
      focused = isTextEntry(event.target);
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      // Moving from one field to another keeps the keyboard up: the next focusin decides.
      if (isTextEntry(event.relatedTarget)) return;
      focused = false;
      update();
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    coarse.addEventListener('change', update);
    window.visualViewport?.addEventListener('resize', update);
    // The page may load with a field already focused (autofocus).
    focused = isTextEntry(document.activeElement);
    update();
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      coarse.removeEventListener('change', update);
      window.visualViewport?.removeEventListener('resize', update);
      root.removeAttribute(KEYBOARD_ATTRIBUTE);
    };
  }, []);
}
