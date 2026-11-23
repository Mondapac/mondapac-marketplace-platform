// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from '../help/page-header.tsx';
import { SuperList, type SuperListProps } from './super-list.tsx';

afterEach(cleanup);

const base = {
  views: {
    label: 'Views',
    activeId: 'all',
    onSelect: () => {},
    items: [{ id: 'all', label: 'All' }],
    manage: null,
  },
  chips: null,
  failure: null,
  loading: false,
  status: { skeleton: false, slow: false, stalled: false, refreshing: false },
  loadingLabel: 'Loading',
  slowLabel: 'Still loading…',
  ready: true,
  table: <p>TABLE</p>,
  pagination: null,
} as const;

/**
 * Guards the Orders layout (john, 23 Nov 2026): on every page the h1 and the list's buttons share
 * one row, the buttons at the end, with no line between the title and the tabs.
 */
function listUnder(heading: SuperListProps['heading'], withHeader: boolean) {
  const props: SuperListProps = { ...base, heading };
  return render(
    <div>
      {withHeader ? <PageHeader title="Shipments" /> : null}
      <SuperList {...props} />
    </div>,
  );
}

describe('page header layout', () => {
  it("puts a list page's buttons in the title row, not in a row of their own", () => {
    const { container } = listUnder({ actions: <button type="button">Bulk action</button> }, true);
    const row = container.querySelector('h1')?.closest('div[class*="justify-between"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Shipments');
    expect(row?.textContent).toContain('Bulk action');
  });

  it('draws no subtitle line for a count: the tabs carry counts', () => {
    const { container } = listUnder({ actions: <button type="button">Bulk action</button> }, true);
    expect(container.textContent).not.toMatch(/products in the/);
    expect(container.querySelector('h1 + p')).toBeNull();
  });

  it("keeps an embedded list's buttons in its own row", () => {
    const { container } = listUnder(
      { embedded: true, actions: <button type="button">Export</button> },
      true,
    );
    const row = container.querySelector('h1')?.closest('div[class*="justify-between"]');
    expect(row?.textContent).not.toContain('Export');
    expect(container.textContent).toContain('Export');
  });
});
