import type { ReactNode, Ref } from 'react';
import { Badge } from '../form/badge.tsx';

/** The element a list's buttons are placed in, so they sit on the title's row on every page. */
export const PAGE_ACTIONS_ID = 'mp-page-actions';

export interface PageHeaderProps {
  /** The page's one h1. */
  readonly title: ReactNode;
  /** A live-state label beside the title, such as "Live · every 30 s" or "Default". */
  readonly status?: string;
  /** The record's own badges beside the title (its state, its risk), already built by the page. */
  readonly badges?: ReactNode;
  /** The page's buttons (a bulk action), at the end of the same row. */
  readonly actions?: ReactNode;
  /** Extra classes for the row, for example the space below it (`mb-4`). */
  readonly className?: string;
  /** For a page that moves focus to its heading after an action: the heading is then focusable. */
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * The one title row of every panel page: the h1, an optional live-state pill and record badges
 * beside it, and the page's buttons at the end. No line sits under the title; what a page is for
 * lives in the Help panel, and a page's own warnings stay as banners below this row.
 */
export function PageHeader({
  title,
  status,
  badges,
  actions,
  className,
  headingRef,
}: PageHeaderProps) {
  return (
    <div
      // The row keeps the control height, so the h1 does not move when buttons come and go.
      className={`flex min-h-(--mp-size-control) flex-wrap items-center justify-between gap-x-4 gap-y-3 ${className ?? ''}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1
          ref={headingRef}
          {...(headingRef === undefined ? {} : { tabIndex: -1 })}
          className={`min-w-0 break-words text-2xl font-semibold ${headingRef === undefined ? '' : 'outline-none'}`}
        >
          {title}
        </h1>
        {status === undefined ? null : <Badge tone="neutral">{status}</Badge>}
        {badges}
      </div>
      {/* Always present: a list on this page (SuperList) puts its bulk action and page buttons here. */}
      <div id={PAGE_ACTIONS_ID} className="flex flex-wrap items-center gap-2">
        {actions}
      </div>
    </div>
  );
}
