import type { ReactNode } from 'react';

export interface TopbarProps {
  readonly pageTitle: string;
  /** Right-hand slot: Market chip, notifications, user menu. */
  readonly actions?: ReactNode;
}

export function Topbar({ pageTitle, actions }: TopbarProps) {
  return (
    <header className="flex h-(--mp-size-topbar-phone) items-center justify-between gap-3 bg-surface pe-4 md:h-(--mp-size-topbar) md:px-6">
      {/* The section name, not a heading: each page has its own h1, so a page has one h1. */}
      <p className="min-w-0 truncate text-lg font-semibold text-fg">{pageTitle}</p>
      <div className="flex shrink-0 items-center gap-3">{actions}</div>
    </header>
  );
}
