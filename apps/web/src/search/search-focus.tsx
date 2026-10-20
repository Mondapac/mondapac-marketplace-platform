'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type FormEvent } from 'react';

// A search sent from the header box or the phone and tablet search panel lands keyboard focus on
// the results heading (approved design search-a-teal v4), so the keyboard closes and a screen
// reader starts at the results.

export const RESULTS_HEADING_ID = 'sr-title';

let focusPending = false;

function focusHeading(): boolean {
  const heading = document.getElementById(RESULTS_HEADING_ID);
  if (!heading) return false;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
  return true;
}

/**
 * The submit handler of a search form: hides the keyboard, runs `before` (the panel closes) and
 * opens the results for the words typed, with focus on their heading.
 */
export function useSearchSubmit(before?: () => void) {
  const router = useRouter();
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('q');
    const q = typeof value === 'string' ? value.trim() : '';
    form.querySelector('input')?.blur();
    before?.();
    const href = `/search?q=${encodeURIComponent(q)}`;
    const here = `${window.location.pathname}${window.location.search}`;
    if (here === href && focusHeading()) return;
    focusPending = true;
    router.push(href);
  };
}

/** Put on the results page: takes the focus a search form asked for once the results are in. */
export function FocusResultsHeading() {
  // No dependencies: a search for the same words with another filter renders the same props.
  useEffect(() => {
    if (!focusPending) return;
    focusPending = false;
    // After the search panel's own close, which gives focus back to the button that opened it.
    requestAnimationFrame(() => focusHeading());
  });
  return null;
}
