import type { ReactNode } from 'react';
import { PinButton } from '../palette/panel-tools.tsx';

/**
 * The h1 of a settings page with the pin star beside it (not in the top bar): the star pins the
 * page to the sidebar and is absent outside the panel tools or on a page that cannot be pinned.
 */
export function SettingsTitle({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 break-words text-2xl font-semibold text-fg">{children}</h1>
      <div className="-my-1.5 shrink-0">
        <PinButton />
      </div>
    </div>
  );
}
