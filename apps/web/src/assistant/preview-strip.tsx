'use client';

import { useEffect } from 'react';
import { takePreview } from './preview.ts';

/**
 * Always mounted in the shell, whether or not the buyer assistant is on: a preview token in the
 * URL fragment never lingers in the address bar, the history entry or a copied link. The token is
 * kept in this tab's sessionStorage (so the assistant, if it is on, finds it there); stripping
 * happens regardless. Renders nothing.
 */
export function PreviewFragmentStrip() {
  useEffect(() => {
    const store = (): Storage | null => {
      try {
        return window.sessionStorage;
      } catch {
        return null;
      }
    };
    takePreview(window.location, window.history, store());
  }, []);
  return null;
}
