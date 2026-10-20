'use client';

import { useEffect } from 'react';

/**
 * After "Show more", moves keyboard focus to the first store it added, so focus is not lost when
 * the button goes and the new cards are announced by their link names.
 */
export function FocusNewStores({ first }: { readonly first: number }) {
  useEffect(() => {
    if (first === 0) return;
    const link = document.querySelectorAll<HTMLElement>('.sl-grid .slc h3 a')[first];
    link?.focus();
  }, [first]);
  return null;
}
