import type { ReactNode } from 'react';
import { Badge } from '../form/badge.tsx';

export interface PageHeaderProps {
  /** The page's one h1. */
  readonly title: string;
  /** A live-state label beside the title, such as "Live · every 30 s" or "Default". */
  readonly status?: string;
  /** The page's buttons (a bulk action), at the end of the same row. */
  readonly actions?: ReactNode;
}

/**
 * The one title row of every panel page: the h1, an optional live-state pill beside it and the
 * page's buttons at the end. No line sits under the title; what a page is for lives in the Help
 * panel, and a page's own warnings stay as banners below this row.
 */
export function PageHeader({ title, status, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{title}</h1>
        {status === undefined ? null : <Badge tone="neutral">{status}</Badge>}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
