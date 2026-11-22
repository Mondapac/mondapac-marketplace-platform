import type { ReactNode } from 'react';

/**
 * The h1 of a settings page. The pin star is not drawn here: it lives in the top bar, like on every
 * other panel page.
 */
export function SettingsTitle({ children }: { readonly children: ReactNode }) {
  return <h1 className="min-w-0 break-words text-2xl font-semibold text-fg">{children}</h1>;
}
