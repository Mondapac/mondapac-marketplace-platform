import { orderPageHref, placeFromSearch } from './slide-order.ts';
import { SLIDES_PATH } from './slide-types.ts';

const SEGMENT =
  'flex min-h-(--mp-size-control) items-center whitespace-nowrap px-3.5 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The two views of the Slides page, as links to two pages: "All slides" and "Order by position".
 * The current page is marked with aria-current. "Order by position" opens at the first position,
 * or at the one the caller names.
 */
export function SlidesViewSwitch({
  labels,
  active,
  orderHref = orderPageHref(placeFromSearch({})),
}: {
  readonly labels: {
    readonly nav: string;
    readonly all: string;
    readonly order: string;
  };
  readonly active: 'all' | 'order';
  readonly orderHref?: string;
}) {
  const items = [
    { id: 'all', href: SLIDES_PATH, label: labels.all },
    { id: 'order', href: orderHref, label: labels.order },
  ] as const;
  return (
    <nav
      aria-label={labels.nav}
      className="inline-flex max-w-full self-start overflow-hidden rounded-md border border-line-control bg-surface"
    >
      {items.map((item, index) => {
        const on = item.id === active;
        return (
          <a
            key={item.id}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            className={`${SEGMENT} ${index > 0 ? 'border-s border-line-control' : ''} ${on ? 'bg-selected font-semibold text-link' : 'text-fg-secondary hover:bg-muted'}`}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
