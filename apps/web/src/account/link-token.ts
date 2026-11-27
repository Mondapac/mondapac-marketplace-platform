'use client';

import { useEffect, useRef, useState } from 'react';

export type LinkToken =
  | { readonly state: 'checking' }
  | { readonly state: 'missing' }
  | { readonly state: 'present'; readonly token: string };

/**
 * Reads a mailed link's one-time token from the URL fragment, then removes the fragment from the
 * address bar and the history entry. The token stays in memory only and never reaches the server
 * of this site in a URL (identity design 6.6, I15; the same as the seller panel's).
 */
export function useLinkToken(): LinkToken {
  const [value, setValue] = useState<LinkToken>({ state: 'checking' });
  // Kept in a ref so a second run of the effect (React StrictMode in development) does not read
  // the fragment again after it has been removed from the address bar.
  const captured = useRef<string | null>(null);
  useEffect(() => {
    if (captured.current === null) {
      captured.current = window.location.hash.slice(1);
      if (captured.current !== '') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
    const token = captured.current;
    setValue(token === '' ? { state: 'missing' } : { state: 'present', token });
  }, []);
  return value;
}
