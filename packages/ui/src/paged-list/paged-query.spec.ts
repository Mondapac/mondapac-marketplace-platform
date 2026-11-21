import { describe, expect, it } from 'vitest';
import { pagedQueryString } from './paged-super-list.tsx';
import type { PagedDateRanges, PagedQuery } from './types.ts';

const config = { tabs: ['all'] } as const;
const query = (filters: Record<string, string>): PagedQuery => ({
  tab: 'all',
  q: '',
  filters,
  page: 1,
  sort: 'name',
  direction: 'asc',
});
const dates: PagedDateRanges = {
  fields: [
    { id: 'status', label: 'Status', options: [] },
    {
      id: 'created',
      label: 'Created',
      options: [],
      range: { from: 'createdFrom', to: 'createdTo' },
    },
  ],
  resolve: (preset) =>
    preset === 'today'
      ? { from: '2026-11-21T00:00:00+10:00', to: '2026-11-22T00:00:00+10:00' }
      : null,
};

describe('pagedQueryString date fields', () => {
  it('asks for the instants a preset means, never for the preset itself', () => {
    const params = new URLSearchParams(
      pagedQueryString(config, query({ created: 'today', status: 'active' }), 'pages', dates),
    );
    expect(params.get('createdFrom')).toBe('2026-11-21T00:00:00+10:00');
    expect(params.get('createdTo')).toBe('2026-11-22T00:00:00+10:00');
    expect(params.has('created')).toBe(false);
    expect(params.get('status')).toBe('active');
  });

  it('leaves the filter out when the preset cannot be turned into instants', () => {
    const params = new URLSearchParams(
      pagedQueryString(config, query({ created: 'x' }), 'pages', dates),
    );
    expect(params.has('createdFrom')).toBe(false);
    expect(params.has('created')).toBe(false);
  });

  it('passes plain filters through when there are no date fields', () => {
    const params = new URLSearchParams(
      pagedQueryString(config, query({ created: 'today' }), 'pages'),
    );
    expect(params.get('created')).toBe('today');
  });
});
