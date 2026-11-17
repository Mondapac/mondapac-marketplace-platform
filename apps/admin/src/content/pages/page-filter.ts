import type { PageSummary } from './page-types.ts';

export interface PageFilters {
  readonly kind: 'all' | 'system' | 'dynamic';
  readonly status: string;
  readonly search: string;
}

export const NO_PAGE_FILTERS: PageFilters = { kind: 'all', status: '', search: '' };

/** The type, the status and the title narrow the list in the browser (all pages are loaded). */
export function filterPages(
  pages: readonly PageSummary[],
  filters: PageFilters,
): readonly PageSummary[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  return pages.filter((page) => {
    if (filters.kind !== 'all' && page.kind !== filters.kind) return false;
    if (filters.status !== '' && page.status !== filters.status) return false;
    if (needle !== '') {
      const hay = `${page.title} ${page.path}`.toLocaleLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
