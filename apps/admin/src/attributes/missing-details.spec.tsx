// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { csvCell, csvOf, MissingDetailsTab } from './missing-details-tab.tsx';
import type { MissingDetailsItem, MissingDetailsPage } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });

const item = (n: number, over: Partial<MissingDetailsItem> = {}): MissingDetailsItem => ({
  productId: id(n),
  productCode: `P${n}`,
  name: `Product ${n}`,
  sellerId: id(900 + n),
  featureSetCode: 'pantry',
  missing: ['origin'],
  ...over,
});
const page = (
  items: MissingDetailsItem[],
  over: Partial<MissingDetailsPage> = {},
): MissingDetailsPage => ({
  items,
  nextAfterId: null,
  scanned: items.length,
  unreadableFeatureSets: [],
  ...over,
});

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MissingDetailsTab />
    </NextIntlClientProvider>,
  );
}

describe('Missing details tab', () => {
  beforeEach(() => call.mockReset());
  afterEach(cleanup);

  it('lists the products with what they miss and says they stay on sale', async () => {
    call.mockResolvedValueOnce(ok(page([item(1), item(2, { missing: ['origin', 'storage'] })])));
    mount();
    expect(await screen.findByText('Product 1')).toBeTruthy();
    expect(screen.getByText('These products stay on sale')).toBeTruthy();
    expect(screen.getAllByText('origin')).toHaveLength(2);
    expect(screen.getByText('storage')).toBeTruthy();
    expect(call.mock.calls[0]?.[1]).toContain('products-missing-details?limit=50');
  });

  it('shows the empty state when nothing is missing', async () => {
    call.mockResolvedValueOnce(ok(page([])));
    mount();
    expect(await screen.findByText('No products are missing required details.')).toBeTruthy();
  });

  it('shows an error with a retry, and reads again on retry', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Product 1')).toBeTruthy();
  });

  it('loads more from the cursor and keeps the rows', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)], { nextAfterId: id(1) })));
    call.mockResolvedValueOnce(ok(page([item(2)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Product 2')).toBeTruthy();
    expect(screen.getByText('Product 1')).toBeTruthy();
    expect(call.mock.calls[1]?.[1]).toContain(`afterId=${id(1)}`);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('filters the loaded rows by search and by feature set', async () => {
    call.mockResolvedValueOnce(
      ok(page([item(1), item(2, { featureSetCode: 'snacks', name: 'Crisps' })])),
    );
    mount();
    await screen.findByText('Product 1');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'crisp' } });
    expect(screen.queryByText('Product 1')).toBeNull();
    expect(screen.getByText('Crisps')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No loaded product matches.')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Feature set'), { target: { value: 'pantry' } });
    expect(screen.queryByText('Crisps')).toBeNull();
    expect(screen.getByText('Product 1')).toBeTruthy();
  });

  it('names feature sets it could not read', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)], { unreadableFeatureSets: ['gone'] })));
    mount();
    expect(
      await screen.findByText('Products of these feature sets are not judged: gone.'),
    ).toBeTruthy();
  });

  it('sends a session that ended to sign-in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'session.ended' } });
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('exports CSV with every cell quoted and formulas neutralised', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    const text = csvOf([item(1, { name: '=cmd', missing: ['a', 'b'] })]);
    expect(text.split('\r\n')[1]).toBe(`"P1","'=cmd","${id(901)}","pantry","a b"`);
  });
});
