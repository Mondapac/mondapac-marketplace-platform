import type { ReactNode } from 'react';

export interface TopbarProps {
  readonly pageTitle: string;
  /** Right-hand slot: Market chip, notifications, user menu. */
  readonly actions?: ReactNode;
}

export function Topbar({ pageTitle, actions }: TopbarProps) {
  return (
    <header className="flex h-(--mp-size-topbar) items-center justify-between border-b border-line bg-surface px-6">
      <h1 className="text-lg font-semibold text-fg">{pageTitle}</h1>
      <div className="flex items-center gap-3">{actions}</div>
    </header>
  );
}
