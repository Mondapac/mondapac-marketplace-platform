// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { formatInstant } from './format.ts';
import { SellersList } from './sellers-list.tsx';
import type { SellerListPage, SellerRow } from './types.ts';

const call = vi.mocked(callApi);
const row = (over: Partial<SellerRow> = {}): SellerRow => ({
  sellerId: '0190a000-0000-7000-8000-000000000001',
  storeName: 'Cedar Lane Halal Meats',
  slug: 'cedar-lane',
  status: 'awaiting-review',
  origin: 'self',
  kind: 'onboarding',
  submittedAt: '2026-10-08T01:00:00.000Z',
  serviceAreaCode: 'AU-QLD-BNE',
  timezone: 'Australia/Brisbane',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastChangedAt: '2026-10-08T01:00:00.000Z',
  ...over,
});
const page = (items: SellerRow[], next: string | null = null): SellerListPage => ({
  tab: 'awaiting-review',
  items,
  next,
  counts: { awaitingReview: { onboarding: 2, identityChange: 1 }, incomplete: 4, all: 9 },
});
const answer = (body: SellerListPage) =>
  call.mockResolvedValueOnce({ ok: true, status: 200, body });

function mount() {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellersList csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

describe('admin seller list', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('loads the awaiting-review tab first and shows rows and tab counts', async () => {
    answer(page([row()]));
    mount();
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'sellers/admin/list',
      { tab: 'awaiting-review', limit: 25 },
      'csrf-1',
    );
    expect(screen.getByRole('button', { name: 'Awaiting review (3)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Incomplete (4)' })).toBeTruthy();
    expect(screen.getAllByText('New application').length).toBe(2); // the filter option and the row
  });

  it('switches tab and asks for that tab', async () => {
    answer(page([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    answer({ ...page([]), tab: 'incomplete' });
    fireEvent.click(screen.getByRole('button', { name: /^Incomplete/ }));
    expect(await screen.findByText('No incomplete applications.')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'sellers/admin/list',
      { tab: 'incomplete', limit: 25 },
      'csrf-1',
    );
  });

  it('sends the search term and the kind filter in the body', async () => {
    answer(page([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    answer(page([]));
    fireEvent.change(screen.getByLabelText('Submission'), { target: { value: 'identity-change' } });
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        'sellers/admin/list',
        { tab: 'awaiting-review', limit: 25, kind: 'identity-change' },
        'csrf-1',
      ),
    );
    answer(page([]));
    fireEvent.change(screen.getByLabelText(/Store name or shop address/), {
      target: { value: ' cedar ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        'sellers/admin/list',
        { tab: 'awaiting-review', limit: 25, kind: 'identity-change', search: 'cedar' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('No sellers match that search.')).toBeTruthy();
  });

  it('does not search for one character', async () => {
    answer(page([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(screen.getByLabelText(/Store name or shop address/), {
      target: { value: 'c' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Enter at least 2 characters.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('appends the next page with the cursor', async () => {
    answer(page([row()], 'cursor-1'));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    answer(page([row({ sellerId: 'b', storeName: 'Olive Grove Bakehouse' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Olive Grove Bakehouse')).toBeTruthy();
    expect(screen.getByText('Cedar Lane Halal Meats')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'sellers/admin/list',
      { tab: 'awaiting-review', limit: 25, after: 'cursor-1' },
      'csrf-1',
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it.each([
    ['search.too-broad', 400, 'That search matches too many sellers. Add more letters.'],
    ['access.denied', 403, "You don't have access to the seller list."],
    ['sellers.unavailable', 503, "We couldn't load the sellers. Try again in a moment."],
  ])('shows %s as a message', async (code, status, text) => {
    call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('shows a hidden status as a dash and an unknown one as Unknown', async () => {
    answer(page([row({ status: 'hidden' }), row({ sellerId: 'c', status: 'new-state' })]));
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.queryByText('hidden')).toBeNull();
  });

  it('renders a store name as text, not markup', async () => {
    answer(page([row({ storeName: '<img src=x onerror=alert(1)>' })]));
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('formats instants in UTC and survives bad input', () => {
    expect(formatInstant('2026-10-09T23:30:00.000Z')).toContain('UTC');
    expect(formatInstant(null)).toBe('-');
    expect(formatInstant('nope')).toBe('-');
  });

  it('shows the Sellers nav item only with sellers.seller.view', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('sellers');
    expect(ids(['sellers.seller.view'])).toContain('sellers');
  });
});
