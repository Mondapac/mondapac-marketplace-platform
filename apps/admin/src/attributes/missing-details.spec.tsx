// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { csvCell, csvOf, MissingDetailsList } from './missing-details-list.tsx';
import type { EmailSellersAnswer, MissingDetailsItem } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });

type Row = MissingDetailsItem & { actions: string[] };
const item = (n: number, over: Partial<Row> = {}): Row => ({
  productId: id(n),
  productCode: `P${n}`,
  name: `Product ${n}`,
  sellerId: id(900 + n),
  featureSetCode: 'pantry',
  missing: ['origin'],
  lastEmailedAt: null as string | null,
  actions: ['open-product', 'email-seller'],
  ...over,
});
const page = (items: Row[], over: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  nextAfterId: null,
  scanned: items.length,
  complete: true,
  unreadableFeatureSets: [],
  ...over,
});

function mount(canEdit = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MissingDetailsList
        paging="pages"
        accountId="acct"
        marketId="AU"
        canEdit={canEdit}
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue(ok(page([])));
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('Missing details list', () => {
  it('lists the products with what they miss and says they stay on sale', async () => {
    call.mockResolvedValue(ok(page([item(1), item(2, { missing: ['origin', 'storage'] })])));
    mount();
    expect(await screen.findByText('Product 1')).toBeTruthy();
    expect(screen.getByText('These products stay on sale')).toBeTruthy();
    expect(screen.getAllByText('origin')).toHaveLength(2);
    expect(screen.getByText('storage')).toBeTruthy();
    expect(call.mock.calls[0]?.[1]).toContain('products-missing-details?');
    expect(call.mock.calls[0]?.[1]).toContain('sort=missing');
  });

  it('shows when the seller was last emailed, or that they were not', async () => {
    call.mockResolvedValue(
      ok(page([item(1, { lastEmailedAt: '2026-11-08T03:00:00.000Z' }), item(2)])),
    );
    mount();
    await screen.findByText('Product 1');
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText('Not emailed yet')).toBeTruthy();
  });

  it('shows the empty state when nothing is missing', async () => {
    call.mockResolvedValue(ok(page([])));
    mount();
    expect(await screen.findByText('No products are missing required details')).toBeTruthy();
  });

  it('says a partial read covers only part of the Market, and names unreadable feature sets', async () => {
    call.mockResolvedValue(
      ok(page([item(1)], { complete: false, unreadableFeatureSets: ['broken-set'] })),
    );
    mount();
    await screen.findByText('Product 1');
    expect(screen.getByText('Only part of the Market was read')).toBeTruthy();
    expect(screen.getByText(/broken-set/)).toBeTruthy();
  });

  it('does not show the partial banner for a complete read', async () => {
    call.mockResolvedValue(ok(page([item(1)])));
    mount();
    await screen.findByText('Product 1');
    expect(screen.queryByText('Only part of the Market was read')).toBeNull();
  });

  it('exports CSV with every cell quoted and formulas neutralised', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    const text = csvOf([item(1, { name: '=cmd', missing: ['a', 'b'] })]);
    expect(text.split('\r\n')[1]).toBe(`"P1","'=cmd","${id(901)}","pantry","a b"`);
  });
});

describe('Email sellers', () => {
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

  const mountEditable = () => mount(true);
  async function openBulkEmail() {
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Email sellers…' }));
  }

  it('offers the whole filtered list as a file from the Bulk action menu', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mount();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    expect(
      await screen.findByRole('dialog', { name: 'Export products missing details' }),
    ).toBeTruthy();
  });

  it('is not offered to a reader, in the bulk menu or the row menu', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mount();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    expect(await screen.findByRole('menuitem', { name: 'Export selected as CSV' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Email sellers…' })).toBeNull();
  });

  it('emails one seller from the row menu, and a platform product has no such action', async () => {
    call.mockResolvedValueOnce(
      ok(page([item(1), item(2, { sellerId: null, actions: ['open-product'] })])),
    );
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Product 2' }));
    expect(await screen.findByRole('menuitem', { name: 'Open product' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Email seller…' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    call.mockResolvedValueOnce(ok(answer()));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Product 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Email seller…' }));
    await screen.findByRole('dialog');
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'catalog/admin/reports/products-missing-details/email-sellers',
      { productIds: [id(1)], dryRun: true },
      'csrf',
    );
  });

  it('previews who is emailed, then sends and tells how many sellers', async () => {
    call.mockResolvedValueOnce(ok(page([item(1), item(2)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 2' }));
    call.mockResolvedValueOnce(ok(answer()));
    await openBulkEmail();
    expect(await screen.findByRole('heading', { name: 'Email 1 seller?' })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'catalog/admin/reports/products-missing-details/email-sellers',
      { productIds: [id(1), id(2)], dryRun: true },
      'csrf',
    );
    expect(await screen.findByText('Will be emailed')).toBeTruthy();
    expect(screen.getByText(/Skipped: emailed .*2026/)).toBeTruthy();
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
    await expectToast('1 seller will get an email within a minute.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a title without a count while the preview loads', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    call.mockReturnValueOnce(new Promise(() => undefined));
    await openBulkEmail();
    expect(await screen.findByRole('heading', { name: 'Email sellers?' })).toBeTruthy();
  });

  it('says a seller was emailed recently when no date is known', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    const [, skipped] = answer().sellers;
    call.mockResolvedValueOnce(
      ok(
        answer({
          sellers: skipped
            ? [
                {
                  ...skipped,
                  products: skipped.products.map((p) => ({ ...p, lastRequestedAt: null })),
                },
              ]
            : [],
        }),
      ),
    );
    await openBulkEmail();
    expect(await screen.findByText('Skipped: emailed recently')).toBeTruthy();
  });

  it('cannot send when every seller was emailed in the last 7 days', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    call.mockResolvedValueOnce(
      ok(
        answer({
          sellers: answer().sellers.slice(1),
        }),
      ),
    );
    await openBulkEmail();
    const send = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Email 0 sellers',
    });
    expect(send.disabled).toBe(true);
  });

  it('explains a Market without the seller panel link', async () => {
    call.mockResolvedValueOnce(ok(page([item(1)])));
    mountEditable();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Product 1' }));
    call.mockResolvedValueOnce(fail503('missing-details-email.unconfigured'));
    await openBulkEmail();
    expect(await screen.findByText(/no seller panel link set/)).toBeTruthy();
  });
});

const fail503 = (code: string): ApiResult<never> => ({ ok: false, failure: { status: 503, code } });
