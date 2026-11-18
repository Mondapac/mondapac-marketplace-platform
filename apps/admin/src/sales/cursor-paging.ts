// The paging of the Sales lists. Page numbers (List paging `pages`) send `page`, `pageSize`,
// `sort` and `direction`; Previous and next sends `limit` and `cursor` only (the API refuses the
// mix) and keeps a stack of the cursors that opened each page seen so far. Both are driven with a
// page number, so the kit's `ListPagination` serves either.

export type ListPagingMode = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
export const MAX_PAGE = Math.floor(MAX_PAGED_ROWS / PAGE_SIZE);

/** How many page buttons a total needs, never past the API's depth limit. */
export const pageCountOf = (total: number): number =>
  Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_SIZE)));

/** The cursor that opens the page on show: the last one of the stack, none for the first page. */
export const cursorOf = (stack: readonly string[]): string | null =>
  stack[stack.length - 1] ?? null;

/** Previous and next: the page on show, from 1. */
export const pageOfStack = (stack: readonly string[]): number => stack.length + 1;

/**
 * The stack after a move to `target`: one page on pushes the cursor the answer gave, one page
 * back drops the last. Any other target (and a step on with no cursor to follow) leaves it.
 */
export function stepStack(
  stack: readonly string[],
  target: number,
  next: string | null,
): readonly string[] {
  const page = pageOfStack(stack);
  if (target === page + 1) return next === null ? stack : [...stack, next];
  if (target === page - 1) return stack.slice(0, -1);
  return stack;
}

/**
 * The total a footer is told when the API gives none: one row past this page while another page
 * follows, so its Next button knows where the end is.
 */
export function openTotal(page: number, rows: number, hasNext: boolean): number {
  return hasNext ? page * PAGE_SIZE + 1 : (page - 1) * PAGE_SIZE + rows;
}
