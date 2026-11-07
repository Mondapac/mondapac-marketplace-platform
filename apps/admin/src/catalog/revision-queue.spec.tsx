// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { parseQueueParams } from './review-queue-params.ts';
import {
  QueueEmpty,
  RevisionFilters,
  RevisionQueueTable,
  SellerChip,
  revisionHref,
} from './revision-queue.tsx';
import type { RevisionRow } from './types.ts';

const SELLER = '0190a000-0000-7000-8000-0000000000f1';
const assign = vi.fn();
const row = (over: Partial<RevisionRow> = {}): RevisionRow => ({
  kind: 'product-revision',
  productId: '0190a000-0000-7000-8000-0000000000d1',
  revisionId: '0190a000-0000-7000-8000-0000000000e1',
  revisionNo: 2,
  version: 5,
  sellerId: SELLER,
  storeName: 'Cedar Lane',
  product: { productCode: 'P1', typeCode: 'grocery', name: 'Olive oil' },
  firstPublication: false,
  reasons: ['image-added-or-replaced', 'tax-category', 'future-code'],
  requiredChecks: ['photos-no-certification-mark', 'tax-category-fits'],
  hasImages: true,
  warnings: [],
  submittedAt: '2026-10-14T01:00:00.000Z',
  ...over,
});
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  assign.mockClear();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

describe('RevisionQueueTable', () => {
  it('shows the product, change, seller, reasons, checks and a named Review link', () => {
    const params = parseQueueParams({ change: 'update' });
    render(
      wrap(
        <RevisionQueueTable
          rows={[
            row(),
            row({
              revisionId: '0190a000-0000-7000-8000-0000000000e2',
              firstPublication: true,
              reasons: ['never-published'],
              requiredChecks: [],
            }),
          ]}
          params={params}
        />,
      ),
    );
    const rows = screen.getAllByRole('row').slice(1);
    const first = within(rows[0]!);
    expect(first.getByText('Olive oil')).toBeTruthy();
    expect(first.getByText('Revision 2 · P1')).toBeTruthy();
    expect(first.getByText('Update')).toBeTruthy();
    expect(first.getByText('New photos')).toBeTruthy();
    expect(first.getByText('Tax category')).toBeTruthy();
    // An unknown code shows as the code, never as an empty badge.
    expect(first.getByText('future-code')).toBeTruthy();
    expect(first.getByText('2 checks')).toBeTruthy();
    const review = first.getByRole('link', { name: 'Review Olive oil' });
    expect(review.getAttribute('href')).toBe(revisionHref(row()));
    expect(first.getByRole('link', { name: 'Show only Cedar Lane' }).getAttribute('href')).toBe(
      `/review?change=update&seller=${SELLER}`,
    );
    const second = within(rows[1]!);
    expect(second.getByText('New')).toBeTruthy();
    expect(second.getByText('First publication')).toBeTruthy();
    expect(second.getByText('No checks')).toBeTruthy();
  });

  it('names a product without a name by its code, and a store without a name as unnamed', () => {
    render(
      wrap(
        <RevisionQueueTable
          rows={[
            row({ storeName: null, product: { productCode: 'P9', typeCode: null, name: null } }),
          ]}
          params={parseQueueParams({})}
        />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Review P9' })).toBeTruthy();
    expect(screen.getByText('Unnamed store')).toBeTruthy();
  });
});

describe('RevisionFilters', () => {
  it('opens the first page with the chosen change and photos filter', () => {
    const params = parseQueueParams({ after: '1_a' });
    render(wrap(<RevisionFilters params={params} sellerName={null} />));
    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'new' } });
    expect(assign).toHaveBeenLastCalledWith('/review?change=new');
    fireEvent.change(screen.getByLabelText('Photos'), { target: { value: 'with' } });
    expect(assign).toHaveBeenLastCalledWith('/review?photos=with');
    expect(screen.queryByRole('link', { name: 'Clear filters' })).toBeNull();
  });

  it('shows the seller filter as a chip that can be removed, and Clear filters', () => {
    const params = parseQueueParams({ seller: SELLER, photos: 'with' });
    render(wrap(<RevisionFilters params={params} sellerName="Cedar Lane" />));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Seller is Cedar Lane' }));
    expect(assign).toHaveBeenLastCalledWith('/review?photos=with');
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe(
      '/review',
    );
  });
});

describe('SellerChip', () => {
  it('does not name a seller no row of the page names', () => {
    render(wrap(<SellerChip params={parseQueueParams({ seller: SELLER })} sellerName={null} />));
    expect(screen.getByRole('button', { name: 'Remove filter One seller only' })).toBeTruthy();
  });
});

describe('QueueEmpty', () => {
  it('says the tab is empty, a page is empty, or the filters keep nothing', () => {
    const { rerender } = render(
      wrap(<QueueEmpty params={parseQueueParams({})} morePages={false} />),
    );
    expect(screen.getByText('No product revisions are waiting for review.')).toBeTruthy();
    rerender(wrap(<QueueEmpty params={parseQueueParams({ type: 'offer' })} morePages={false} />));
    expect(screen.getByText('No offers are waiting for review.')).toBeTruthy();
    rerender(wrap(<QueueEmpty params={parseQueueParams({})} morePages />));
    expect(
      screen.getByText('Nothing on this page. More of the queue is on the next page.'),
    ).toBeTruthy();
    rerender(wrap(<QueueEmpty params={parseQueueParams({ change: 'new' })} morePages={false} />));
    expect(screen.getByText('Nothing matches these filters.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe(
      '/review',
    );
  });
});
