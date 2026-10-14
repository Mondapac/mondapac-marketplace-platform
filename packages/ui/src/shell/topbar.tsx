import type { ReactNode } from 'react';

export interface TopbarProps {
  readonly pageTitle: string;
  /** Right-hand slot: Market chip, notifications, user menu. */
  readonly actions?: ReactNode;
}

export function Topbar({ pageTitle, actions }: TopbarProps) {
  return (
    <header className="flex h-(--mp-size-topbar-phone) items-center justify-between gap-3 bg-surface pe-4 md:h-(--mp-size-topbar) md:px-6">
      <h1 className="min-w-0 truncate text-lg font-semibold text-fg">{pageTitle}</h1>
      <div className="flex shrink-0 items-center gap-3">{actions}</div>
    </header>
  );
}
