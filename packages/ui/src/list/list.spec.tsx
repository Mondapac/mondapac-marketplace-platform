import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BottomSheet } from '../overlay/bottom-sheet.tsx';
import { ListColumnsPanel } from './list-columns-panel.tsx';
import { ListFilterPanel } from './list-filter-panel.tsx';
import { ListPagination, pageItems, type ListPaginationProps } from './list-pagination.tsx';
import { ListSortPanel } from './list-sort-panel.tsx';
import { ListThumb } from './list-thumb.tsx';

describe('pageItems', () => {
  it('lists every page up to seven pages', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('opens with 1 2 3 4 5 … last, as in the design frame', () => {
    expect(pageItems(1, 497)).toEqual([1, 2, 3, 4, 5, 'gap', 497]);
    expect(pageItems(4, 497)).toEqual([1, 2, 3, 4, 5, 'gap', 497]);
  });

  it('keeps a window around a middle page and closes with the last five', () => {
    expect(pageItems(6, 497)).toEqual([1, 'gap', 5, 6, 7, 'gap', 497]);
    expect(pageItems(494, 497)).toEqual([1, 'gap', 493, 494, 495, 496, 497]);
    expect(pageItems(497, 497)).toEqual([1, 'gap', 493, 494, 495, 496, 497]);
  });
});

const labels: ListPaginationProps['labels'] = {
  rowsPerPage: 'Rows per page',
  previous: 'Previous',
  next: 'Next',
  pages: 'Pages',
  page: (page) => `Page ${page}`,
  narrowTitle: 'Narrow the list to see more.',
  narrowBody: 'Lists stop at row 10,000.',
};
const pagination = (over: Partial<ListPaginationProps> = {}) =>
  renderToStaticMarkup(
    <ListPagination
      mode="pages"
      page={1}
      pageSize={25}
      pageSizes={[25, 50, 100]}
      total={143}
      maxRows={10_000}
      range="1–25 of 143 products"
      labels={labels}
      onPage={() => {}}
      onPageSize={() => {}}
      {...over}
    />,
  );

describe('ListPagination', () => {
  it('shows the range, the rows per page and page numbers with the current one marked', () => {
    const html = pagination();
    expect(html).toContain('1–25 of 143 products');
    expect(html).toContain('<option value="25" selected="">25</option>');
    expect(html).toContain('aria-label="Pages"');
    expect(html).toContain('aria-label="Page 1" aria-current="page"');
    expect(html).toContain('aria-label="Page 6"');
    expect(html).not.toContain('aria-label="Page 7"');
    // Previous is disabled on the first page; Next is not.
    expect(html).toMatch(/aria-label="Previous"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Next"[^>]*disabled=""/);
  });

  it('shows only Previous and Next in that mode, with no page numbers', () => {
    const html = pagination({ mode: 'prev-next', page: 2 });
    expect(html).not.toContain('aria-label="Pages"');
    expect(html).not.toContain('Page 2');
    expect(html).toContain('>Previous<');
    expect(html).toContain('>Next<');
  });

  it('disables Next on the last page', () => {
    expect(pagination({ page: 6 })).toMatch(/aria-label="Next"[^>]*disabled=""/);
    expect(pagination({ mode: 'prev-next', page: 6 })).toMatch(/disabled=""[^>]*>Next</);
  });

  it('stops at row 10,000: the last reachable page says to narrow the list', () => {
    const last = pagination({ total: 12_408, page: 400 });
    expect(last).toContain('Narrow the list to see more.');
    expect(last).toContain('aria-label="Page 400"');
    expect(last).not.toContain('aria-label="Page 401"');
    expect(last).toMatch(/aria-label="Next"[^>]*disabled=""/);
    expect(pagination({ total: 12_408, page: 399 })).not.toContain('Narrow the list');
    expect(pagination({ total: 10_000, page: 400 })).not.toContain('Narrow the list');
    expect(pagination({ total: 12_408, page: 100, pageSize: 100 })).toContain('Narrow the list');
  });
});

describe('list panels', () => {
  it('lists the fixed columns, the optional ones in order with the shown ones checked', () => {
    const html = renderToStaticMarkup(
      <ListColumnsPanel
        columns={['b']}
        optional={['a', 'b']}
        defaults={['a']}
        fixed={[{ id: 'name', label: 'Name' }]}
        optionalLabel={(column) => `Column ${column}`}
        labels={{
          title: 'Columns',
          help: 'Pick.',
          always: 'Always shown',
          up: (column) => `Up ${column}`,
          down: (column) => `Down ${column}`,
          reset: 'Reset',
          save: 'Save',
        }}
        onSave={() => {}}
        close={() => {}}
      />,
    );
    expect(html).toContain('Name');
    expect(html).toContain('Always shown');
    // The shown column comes first, then the hidden one.
    expect(html.indexOf('Column b')).toBeLessThan(html.indexOf('Column a'));
    expect(html).toContain('aria-label="Up Column b"');
    expect(html).not.toContain('aria-label="Up Column a"');
  });

  it('starts a sort in its natural direction and names both directions', () => {
    const html = renderToStaticMarkup(
      <ListSortPanel
        sort="name"
        direction="asc"
        fields={[
          { id: 'name', label: 'Name' },
          { id: 'updated', label: 'Updated' },
        ]}
        defaultDirection={(sort) => (sort === 'name' ? 'asc' : 'desc')}
        orderLabels={() => ['A to Z', 'Z to A']}
        labels={{ by: 'Sort by', order: 'Order' }}
        name="x"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Sort by');
    expect(html).toMatch(/checked="" value="name"/);
    expect(html).toMatch(/checked="" value="asc"/);
    expect(html.indexOf('A to Z')).toBeLessThan(html.indexOf('Z to A'));
  });

  it('opens a filter with one row per condition set, and one empty row when none is', () => {
    const props = {
      fields: [
        { id: 'status', label: 'Status', options: [{ value: 'on', label: 'On' }] },
        { id: 'kind', label: 'Kind', options: [{ value: 'k', label: 'K' }] },
      ],
      labels: {
        title: 'Filter',
        matchAll: 'Match all',
        field: 'Field',
        fieldPlaceholder: 'Field',
        is: 'is',
        value: 'Value',
        valuePlaceholder: 'Value',
        remove: 'Remove',
        add: 'Add condition',
        cancel: 'Cancel',
        apply: 'Apply',
      },
      onApply: () => {},
      close: () => {},
    };
    const none = renderToStaticMarkup(<ListFilterPanel {...props} values={{}} />);
    expect(none.match(/<li/g)).toHaveLength(1);
    expect(none).toContain('Add condition');
    const both = renderToStaticMarkup(
      <ListFilterPanel {...props} values={{ status: 'on', kind: 'k' }} />,
    );
    expect(both.match(/<li/g)).toHaveLength(2);
    // Every field is in use: nothing more to add.
    expect(both).not.toContain('Add condition');
  });
});

describe('ListThumb and BottomSheet', () => {
  it('shows a tile without a photo and the photo with one', () => {
    expect(renderToStaticMarkup(<ListThumb src={null} />)).not.toContain('<img');
    expect(renderToStaticMarkup(<ListThumb src="/api/x/thumb" />)).toContain('src="/api/x/thumb"');
  });

  it('holds its content only while open, named by its title, with a close button', () => {
    const sheet = (open: boolean) =>
      renderToStaticMarkup(
        <BottomSheet open={open} title="Filter" closeLabel="Close" onClose={() => {}}>
          <p>Body</p>
        </BottomSheet>,
      );
    expect(sheet(false)).not.toContain('Body');
    const html = sheet(true);
    expect(html).toContain('Body');
    expect(html).toContain('Filter');
    expect(html).toContain('aria-label="Close"');
  });
});
