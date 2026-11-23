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
      heading={{ embedded: true, note: '143 people' }}
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
      status={{ skeleton: false, slow: false, stalled: false, refreshing: false }}
      loadingLabel="Loading"
      slowLabel="Still loading…"
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

  it('shows the loading status before the first answer and the banner with Retry on a failure', () => {
    const loadingHtml = list({ ready: false, loading: true });
    expect(loadingHtml).toContain('Loading');
    expect(loadingHtml).not.toContain('TABLE');
    const failed = list({
      failure: { message: 'Could not load', retry: { label: 'Retry', onClick: () => {} } },
    });
    expect(failed).toContain('Could not load');
    expect(failed).toContain('Retry');
    // A failure after a first page keeps the rows' place; the banner is above them.
    expect(failed).toContain('TABLE');
  });

  it('shows the load error in place of the list when the first load failed', () => {
    const html = list({
      ready: false,
      firstLoadError: true,
      failure: { message: 'Try again', retry: { label: 'Retry', onClick: () => {} } },
    });
    expect(html).toContain('Try again');
    expect(html).not.toContain('TABLE');
  });

  it('keeps the toolbar but disables it while the skeleton rows show', () => {
    const html = list({
      ready: false,
      loading: true,
      status: { skeleton: true, slow: false, stalled: false, refreshing: false },
    });
    expect(html).toContain('<fieldset disabled');
    expect(html).toContain('TABLE');
  });

  it('marks the list busy and dims the rows while a later page loads', () => {
    const html = list({
      loading: true,
      status: { skeleton: false, slow: false, stalled: false, refreshing: true },
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('opacity-60');
  });

  it('shows a page title and a notice, and a page-made toolbar in place of the three tools', () => {
    const html = list({
      heading: { title: 'People' },
      notice: <p>View only</p>,
      toolbar: <fieldset>OWN TOOLS</fieldset>,
    });
    expect(html).toContain('<h1');
    expect(html).toContain('People');
    expect(html).toContain('View only');
    expect(html).toContain('OWN TOOLS');
    expect(html).not.toContain('>Columns<');
  });

  it('has no info icon or intro line: the title row has the h1, a live status and the actions', () => {
    const titled = list({
      heading: {
        title: 'People',
        status: 'Live · every 30 s',
        note: '5 people',
        actions: <button>Bulk</button>,
      },
    });
    expect(titled.match(/<h1/g)).toHaveLength(1);
    expect(titled).not.toContain('About ');
    expect(titled).toContain('Live · every 30 s');
    // A page's list draws no line under its title, even when a note is given.
    expect(titled).not.toContain('5 people');
    expect(titled).toContain('<button>Bulk</button>');
    expect(list({ heading: { embedded: true, note: '5 people' } })).not.toContain('<h1');
  });

  it('puts anything the page gives after the search box', () => {
    const html = list({
      heading: { embedded: true, note: '143 people' },
      search: {
        label: 'Search',
        placeholder: 'Search people',
        value: '',
        maxLength: 100,
        onChange: () => {},
        onSubmit: () => {},
        extra: <span>SCOPE</span>,
      },
    });
    expect(html.indexOf('Search people')).toBeLessThan(html.indexOf('SCOPE'));
    expect(list()).not.toContain('SCOPE');
  });

  it('draws no tab row for a compact list that leaves the views out', () => {
    const html = list({ views: undefined });
    expect(html).not.toContain('aria-label="Views"');
    expect(html).not.toContain('Manage filters');
    expect(html).toContain('Search people');
    expect(html).toContain('TABLE');
  });

  it('gives a tab its pointer hint when it has one', () => {
    const html = list({
      views: {
        label: 'Views',
        activeId: 'all',
        onSelect: () => {},
        items: [
          { id: 'all', label: 'All' },
          { id: 'cut', label: 'Cut', title: 'Cut in full' },
        ],
        manage: null,
      },
    });
    expect(html).toContain('title="Cut in full"');
    expect(html.match(/title=/g)).toHaveLength(1);
  });
});
