import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SuperList, type SuperListProps } from './super-list.tsx';
import { SuperTable, type SuperTableProps } from './super-table.tsx';
import type { RowSelectionState } from './use-row-selection.ts';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly total: number;
}
const rows: Row[] = [
  { id: 'a', name: 'Ada', status: 'Active', total: 3 },
  { id: 'b', name: 'Bo', status: 'Paused', total: 12 },
];
const selection: RowSelectionState = {
  selected: new Set(['b']),
  allMatching: false,
  full: false,
  toggleRow: () => {},
  togglePage: () => {},
  selectAllMatching: () => {},
  clear: () => {},
};

const table = (over: Partial<SuperTableProps<Row>> = {}) =>
  renderToStaticMarkup(
    <SuperTable<Row>
      caption="People"
      rows={rows}
      rowId={(row) => row.id}
      rowName={(row) => row.name}
      columns={[
        { id: 'name', header: 'Name', primary: true, cell: (row) => row.name },
        { id: 'status', header: 'Status', corner: true, cell: (row) => row.status },
        { id: 'total', header: 'Total', numeric: true, cell: (row) => row.total },
      ]}
      {...over}
    />,
  );

describe('SuperTable', () => {
  it('has no buttons in a row unless there is a select box or the Actions menu', () => {
    const html = table();
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });

  it('puts the Actions menu last, sticky, with the row name in its label, and no menu on a row without items', () => {
    const html = table({
      actions: {
        header: 'Actions',
        label: (name) => `Actions for ${name}`,
        items: (row) => (row.id === 'a' ? [{ id: 'open', label: 'Open', onSelect: () => {} }] : []),
      },
    });
    expect(html.match(/aria-label="Actions for/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Actions for Ada"');
    expect(html).toContain('lg:sticky');
    const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    expect(head.lastIndexOf('Actions')).toBeGreaterThan(head.lastIndexOf('Total'));
  });

  it('moves the status under the title when the corner belongs to the Actions menu', () => {
    const withMenu = table({
      actions: { header: 'Actions', label: (n) => n, items: () => [] },
    });
    expect(withMenu).toContain('max-lg:col-span-2');
    expect(table()).toContain('max-lg:col-start-2');
  });

  it('adds a select box per row and one in the header, ticking the selected ones', () => {
    const html = table({
      selection: {
        state: selection,
        labels: { page: 'Select page', pageShort: 'Select page', row: (n) => `Select ${n}` },
      },
    });
    expect(html).toContain('Select Ada');
    expect(html).toContain('Select Bo');
    expect(html).toContain('bg-selected');
  });

  it('ends a number column with its header', () => {
    expect(table()).toContain('lg:text-end lg:tabular-nums');
  });

  it('shows the empty state under the headers', () => {
    const html = table({ rows: [], empty: <p>Nothing here</p> });
    expect(html).toContain('Nothing here');
    expect(html).toContain('<thead');
  });
});

const list = (over: Partial<SuperListProps> = {}) =>
  renderToStaticMarkup(
    <SuperList
      heading={{ subtitle: '143 people' }}
      views={{
        label: 'Views',
        activeId: 'all',
        onSelect: () => {},
        items: [{ id: 'all', label: 'All' }],
        manage: { label: 'Manage filters…', onClick: () => {} },
      }}
      search={{
        label: 'Search',
        placeholder: 'Search people',
        value: '',
        maxLength: 100,
        onChange: () => {},
        onSubmit: () => {},
      }}
      filter={{ label: 'Filter', panel: () => null }}
      sort={{ label: 'Sort', panel: () => null }}
      columns={{ label: 'Columns', panel: () => null }}
      chips={null}
      failure={null}
      loading={false}
      loadingLabel="Loading"
      ready
      table={<p>TABLE</p>}
      pagination={null}
      {...over}
    />,
  );

describe('SuperList', () => {
  it('lays out the views, search, the three tools and the table', () => {
    const html = list();
    for (const text of [
      '143 people',
      'Manage filters…',
      'Search people',
      'Filter',
      'Sort',
      'Columns',
      'TABLE',
    ])
      expect(html).toContain(text);
  });

  it('shows the loading rows before the first answer and the banner with Retry on a failure', () => {
    expect(list({ ready: false, loading: true })).toContain('Loading');
    expect(list({ ready: false, loading: true })).not.toContain('TABLE');
    const failed = list({
      failure: { message: 'Could not load', retry: { label: 'Retry', onClick: () => {} } },
    });
    expect(failed).toContain('Could not load');
    expect(failed).toContain('Retry');
    expect(failed).not.toContain('TABLE');
  });

  it('dims the table while the next answer loads', () => {
    expect(list({ loading: true })).toContain('opacity-60');
  });
});
