'use client';

import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { IconButton } from '../form/icon-button.tsx';
import { Select } from '../form/select.tsx';

/** One entry of the page number row: a page, or the gap "…" between far pages. */
export type PageItem = number | 'gap';

/**
 * The page numbers to show: all of them up to seven pages, else the first, the last and a window
 * around the current page (1 2 3 4 5 … 497, then 1 … 6 7 8 … 497, then 1 … 493 494 495 496 497).
 */
export function pageItems(current: number, last: number): PageItem[] {
  if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, 'gap', last];
  if (current >= last - 3) return [1, 'gap', last - 4, last - 3, last - 2, last - 1, last];
  return [1, 'gap', current - 1, current, current + 1, 'gap', last];
}

export interface ListPaginationLabels {
  readonly rowsPerPage: string;
  readonly previous: string;
  readonly next: string;
  /** The name of the page number row's landmark ("Pages"). */
  readonly pages: string;
  /** "Page 3", the name of a page button. */
  readonly page: (page: number) => string;
  /** The title and the body of the notice shown at the last page that can be reached. */
  readonly narrowTitle: string;
  readonly narrowBody: string;
}

export interface ListPaginationProps {
  /** `pages` shows page numbers, `prev-next` only Previous and Next (the Market's List paging). */
  readonly mode: 'pages' | 'prev-next';
  readonly page: number;
  readonly pageSize: number;
  readonly pageSizes: readonly number[];
  readonly total: number;
  /** The rows past which the API refuses a page (10,000). */
  readonly maxRows: number;
  /** "1–25 of 143 products", already worded. */
  readonly range: string;
  readonly labels: ListPaginationLabels;
  readonly disabled?: boolean;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (pageSize: number) => void;
}

/**
 * The footer of a list (Figma "Pagination"): the range and total, the rows per page, then page
 * numbers or Previous and next. Past `maxRows` there is no further page: the last reachable page
 * says "Narrow the list to see more".
 */
export function ListPagination({
  mode,
  page,
  pageSize,
  pageSizes,
  total,
  maxRows,
  range,
  labels,
  disabled = false,
  onPage,
  onPageSize,
}: ListPaginationProps) {
  const reachable = Math.min(total, maxRows);
  const last = Math.max(1, Math.ceil(reachable / pageSize));
  const atEnd = page >= last;
  const capped = total > maxRows && atEnd;
  return (
    <div className="flex flex-col gap-3">
      {capped ? (
        <Banner tone="info" title={labels.narrowTitle}>
          <p>{labels.narrowBody}</p>
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="text-sm text-fg-muted">{range}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <span aria-hidden="true">{labels.rowsPerPage}</span>
            <div className="w-20 [&_label]:sr-only">
              <Select
                label={labels.rowsPerPage}
                value={String(pageSize)}
                disabled={disabled}
                onChange={(event) => onPageSize(Number(event.target.value))}
                options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
              />
            </div>
          </div>
          {mode === 'prev-next' ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={disabled || page <= 1}
                onClick={() => onPage(page - 1)}
              >
                {labels.previous}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled || atEnd}
                onClick={() => onPage(page + 1)}
              >
                {labels.next}
              </Button>
            </div>
          ) : (
            <nav aria-label={labels.pages} className="flex flex-wrap items-center gap-1">
              <IconButton
                icon="chevron-left"
                label={labels.previous}
                disabled={disabled || page <= 1}
                onClick={() => onPage(page - 1)}
              />
              {pageItems(page, last).map((item, index) =>
                item === 'gap' ? (
                  <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-fg-muted">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    aria-label={labels.page(item)}
                    aria-current={item === page ? 'page' : undefined}
                    disabled={disabled}
                    onClick={() => onPage(item)}
                    className={`inline-flex h-(--mp-size-control-sm) min-w-(--mp-size-control-sm) items-center justify-center rounded-md px-2 text-sm font-medium disabled:cursor-not-allowed ${
                      item === page ? 'bg-accent text-on-accent' : 'text-fg enabled:hover:bg-muted'
                    }`}
                  >
                    {item}
                  </button>
                ),
              )}
              <IconButton
                icon="chevron-right"
                label={labels.next}
                disabled={disabled || atEnd}
                onClick={() => onPage(page + 1)}
              />
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
