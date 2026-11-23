import type { ReactNode } from 'react';

export interface Crumb {
  readonly label: string;
  /** Absent for a crumb that names a group of pages, not a page. */
  readonly href?: string;
}

export interface TopbarProps {
  readonly pageTitle: string;
  /**
   * The pages above this one, outermost first (for example Home, then Settings). From tablets up
   * the topbar shows them with the page as a breadcrumb, so it does not repeat the page's h1.
   */
  readonly trail?: readonly Crumb[];
  /** Name of the breadcrumb landmark. */
  readonly trailLabel?: string;
  /** Replaces the page name in the phone bar (the name of the page the star pins). */
  readonly phoneTitle?: ReactNode;
  /** Next to the page name on phones only; from tablets up the pin star sits in `actions`. */
  readonly titleAction?: ReactNode;
  /** Right-hand slot: Market chip, notifications, user menu. */
  readonly actions?: ReactNode;
}

export function Topbar({
  pageTitle,
  trail = [],
  trailLabel,
  phoneTitle,
  titleAction,
  actions,
}: TopbarProps) {
  return (
    <header className="flex h-(--mp-size-topbar-phone) items-center justify-between gap-3 bg-surface pe-4 md:h-(--mp-size-topbar) md:px-6">
      {/* The page name, not a heading: each page has its own h1, so a page has one h1. On phones
       * the bar names the page; from 768 px the bar shows the parent and the page (the current crumb is the page's title), and
       * from 1024 px the whole path; it truncates before it can reach the actions. */}
      <div className="flex min-w-0 flex-1 items-center">
        <p className="min-w-0 truncate text-lg font-semibold text-fg md:hidden">
          {phoneTitle ?? pageTitle}
        </p>
        <div className="md:hidden">{titleAction}</div>
        <nav aria-label={trailLabel} className="hidden min-w-0 flex-1 overflow-hidden md:block">
          <ol className="flex min-w-0 items-center gap-2 text-sm">
            {trail.map((crumb, index) => (
              <li
                key={crumb.href ?? crumb.label}
                // From 768 px the parent and the page show; the upper levels wait for 1024 px.
                className={`min-w-0 max-w-40 items-center gap-2 ${index < trail.length - 1 ? 'hidden lg:flex' : 'flex'}`}
              >
                {crumb.href === undefined ? (
                  <span className="min-w-0 truncate text-fg-muted">{crumb.label}</span>
                ) : (
                  <a
                    href={crumb.href}
                    className="min-w-0 truncate text-fg-muted hover:text-fg hover:underline"
                  >
                    {crumb.label}
                  </a>
                )}
                <span aria-hidden="true" className="shrink-0 text-fg-muted">
                  /
                </span>
              </li>
            ))}
            <li aria-current="page" className="min-w-0 truncate font-medium text-fg">
              {pageTitle}
            </li>
          </ol>
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </header>
  );
}
