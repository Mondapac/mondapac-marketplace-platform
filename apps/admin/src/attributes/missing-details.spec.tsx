// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { csvCell, csvOf, MissingDetailsTab } from './missing-details-tab.tsx';
import type { EmailSellersAnswer, MissingDetailsItem, MissingDetailsPage } from './types.ts';

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

describe('Email sellers', () => {
  beforeEach(() => {
    call.mockReset();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(cleanup);

  const answer = (over: Partial<EmailSellersAnswer> = {}): EmailSellersAnswer => ({
    dryRun: true,
    throttleDays: 7,
    sellers: [
      {
        sellerId: id(901),
        sellerName: 'Fresh Co',
        products: [
          {
            productId: id(1),
            productCode: 'P1',
            name: 'Product 1',
            missing: ['Country of origin', 'Storage'],
            status: 'will-send',
            lastRequestedAt: null,
          },
        ],
      },
      {
        sellerId: id(902),
        sellerName: 'Dates Ltd',
        products: [
          {
            productId: id(2),
            productCode: 'P2',
            name: 'Product 2',
            missing: ['Storage'],
            status: 'recently-emailed',
            lastRequestedAt: '2026-11-08T03:00:00.000Z',
          },
        ],
      },
    ],
    ignored: [],
    ...over,
  });

  function mountEditable() {
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MissingDetailsTab canEdit csrfToken="csrf" />
      </NextIntlClientProvider>,
    );
  }

  it('is not offered to a reader', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mount();
    await screen.findByText('Product 1');
    expect(screen.queryByRole('button', { name: 'Email sellers' })).toBeNull();
  });

  it('stays off until a seller product is selected', async () => {
    call.mockResolvedValueOnce(ok(page([item(1), item(2, { sellerId: null })])));
    mountEditable();
    await screen.findByText('Product 1');
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Email sellers' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Select products to email their sellers.')).toBeTruthy();
    // A platform product has no seller to ask.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P2' }));
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P1' }));
    expect(button.disabled).toBe(false);
    expect(screen.getByText('1 product selected for email.')).toBeTruthy();
  });

  it('previews who is emailed, then sends and tells how many sellers', async () => {
    call.mockResolvedValueOnce(ok(page([item(1), item(2)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P2' }));
    call.mockResolvedValueOnce(ok(answer()));
    fireEvent.click(screen.getByRole('button', { name: 'Email sellers' }));
    expect(await screen.findByRole('heading', { name: 'Email 2 sellers?' })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'catalog/admin/reports/products-missing-details/email-sellers',
      { productIds: [id(1), id(2)], dryRun: true },
      'csrf',
    );
    expect(await screen.findByText('Will be emailed')).toBeTruthy();
    expect(screen.getByText('Skipped: emailed 2026-11-08')).toBeTruthy();
    expect(screen.getByText('1 of your products needs more details')).toBeTruthy();
    expect(screen.getByText(/- Product 1: Country of origin, Storage/)).toBeTruthy();
    expect(screen.getByText(/Sent in English/)).toBeTruthy();
    call.mockResolvedValueOnce(
      ok(
        answer({
          dryRun: false,
          sellers: answer().sellers.map((s, i) => ({
            ...s,
            products: s.products.map((p) => ({
              ...p,
              status: i === 0 ? ('queued' as const) : ('recently-emailed' as const),
            })),
          })),
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Email 1 seller' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        'catalog/admin/reports/products-missing-details/email-sellers',
        { productIds: [id(1), id(2)] },
        'csrf',
      ),
    );
    expect(await screen.findByText('1 seller will get an email within a minute.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cannot send when every seller was emailed in the last 7 days', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P1' }));
    call.mockResolvedValueOnce(
      ok(
        answer({
          sellers: answer().sellers.slice(1),
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Email sellers' }));
    const send = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Email 0 sellers',
    });
    expect(send.disabled).toBe(true);
  });

  it('explains a Market without the seller panel link', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P1' }));
    call.mockResolvedValueOnce(fail503('missing-details-email.unconfigured'));
    fireEvent.click(screen.getByRole('button', { name: 'Email sellers' }));
    expect(await screen.findByText(/no seller panel link set/)).toBeTruthy();
  });
});

const fail503 = (code: string): ApiResult<never> => ({ ok: false, failure: { status: 503, code } });
