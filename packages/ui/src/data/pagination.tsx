import { Button } from '../form/button.tsx';

/** What a page-number bar shows: page numbers and `gap` where numbers are left out. */
export type PageItem = number | 'gap';

/**
 * The page numbers to show: the first and last page, the current one with `around` on each side,
 * and a gap wherever pages are left out (never a gap for a single page: the number is shown).
 */
export function pageWindow(page: number, pageCount: number, around = 1): readonly PageItem[] {
  const last = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), last);
  const shown = new Set<number>([1, last]);
  for (let n = current - around; n <= current + around; n += 1) {
    if (n >= 1 && n <= last) shown.add(n);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const items: PageItem[] = [];
  sorted.forEach((n, index) => {
    const before = sorted[index - 1];
    if (before !== undefined && n - before === 2) items.push(before + 1);
    else if (before !== undefined && n - before > 2) items.push('gap');
    items.push(n);
  });
  return items;
}

export interface PaginationLabels {
  /** The name of the navigation landmark ("Pages"). */
  readonly nav: string;
  readonly previous: string;
  readonly next: string;
  /** The accessible name of the button for page `n` ("Page 3"). */
  readonly page: (n: number) => string;
  /** The text between the numbers where pages are left out. Decoration, read as nothing. */
  readonly gap?: string;
}

/**
 * Page numbers with Previous and Next (List paging: Page numbers). The current page is marked with
 * `aria-current="page"`. Nothing shows for a single page. The caller keeps the page in its state.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  labels,
  disabled = false,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly onPage: (page: number) => void;
  readonly labels: PaginationLabels;
  /** True while a page loads: every button waits. */
  readonly disabled?: boolean;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={labels.nav} className="flex flex-wrap items-center gap-1">
      <Button variant="secondary" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
        {labels.previous}
      </Button>
      {pageWindow(page, pageCount).map((item, index) =>
        item === 'gap' ? (
          <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-fg-muted">
            {labels.gap ?? '…'}
          </span>
        ) : (
          <Button
            key={item}
            variant={item === page ? 'primary' : 'secondary'}
            aria-label={labels.page(item)}
            aria-current={item === page ? 'page' : undefined}
            disabled={disabled}
            className="min-w-(--mp-size-control) px-2 tabular-nums"
            onClick={() => (item === page ? undefined : onPage(item))}
          >
            {item}
          </Button>
        ),
      )}
      <Button
        variant="secondary"
        disabled={disabled || page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {labels.next}
      </Button>
    </nav>
  );
}

/** Previous and Next only (List paging: Previous and next): for lists of any length. */
export function PrevNext({
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  labels,
  disabled = false,
}: {
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly labels: Pick<PaginationLabels, 'nav' | 'previous' | 'next'>;
  readonly disabled?: boolean;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav aria-label={labels.nav} className="flex items-center gap-2">
      <Button variant="secondary" disabled={disabled || !hasPrevious} onClick={onPrevious}>
        {labels.previous}
      </Button>
      <Button variant="secondary" disabled={disabled || !hasNext} onClick={onNext}>
        {labels.next}
      </Button>
    </nav>
  );
}
