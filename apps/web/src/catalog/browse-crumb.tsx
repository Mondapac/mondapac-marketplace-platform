'use client';

import { useStore } from '../shell/store-context.tsx';

/** "Browse products" in a trail: there is no browse page, so it opens the Browse panel. */
export function BrowseCrumb({ label }: { readonly label: string }) {
  const { setBrowseOpen } = useStore();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-controls="browse-panel"
      onClick={() => setBrowseOpen(true)}
    >
      {label}
    </button>
  );
}
