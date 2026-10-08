'use client';

import { useEffect, useState } from 'react';

export type LinkToken =
  | { readonly state: 'checking' }
  | { readonly state: 'missing' }
  | { readonly state: 'present'; readonly token: string };

/**
 * Reads the one-time token from the URL fragment, then removes the fragment from the address bar
 * and the history entry. The token stays in memory only (identity design 6.6, I15).
 */
export function useLinkToken(): LinkToken {
  const [value, setValue] = useState<LinkToken>({ state: 'checking' });
  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (token !== '') window.history.replaceState(null, '', window.location.pathname);
    setValue(token === '' ? { state: 'missing' } : { state: 'present', token });
  }, []);
  return value;
}
