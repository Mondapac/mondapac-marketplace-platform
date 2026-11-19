// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { toast } from '@mondapac/ui';
import { servePerks } from '../../test/serve-perks.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi } from '../api/client.ts';
import { CustomerDetail } from './customer-detail.tsx';
import { CustomersExport } from './customers-export.tsx';
import { CustomersList } from './customers-list.tsx';
import {
  CustomersColumnsPanel,
  CustomersFilterPanel,
  CustomersSortPanel,
} from './customers-panels.tsx';
import { ExclusivePerks, type OwnPromotion } from './exclusive-perks.tsx';
import { InviteCustomers, inviteUrl } from './invite-customers.tsx';
import { DEFAULT_QUERY } from './query.ts';
import type { SellerCustomerPage, SellerCustomerRow } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});
const row = (over: Partial<SellerCustomerRow> = {}): SellerCustomerRow => ({
  code: 'AB12-CD34',
  firstName: 'Mina',
  orderCount: 1,
  firstOrderAt: null,
  lastOrderAt: null,
  spentMinor: '100',
  currency: 'AUD',
  follower: false,
  followedAt: null,
  exclusive: false,
  since: '2026-09-01T00:00:00.000Z',
  ...over,
});
const page = (total: number): SellerCustomerPage => ({
  items: [row()],
  counts: { all: total, buyers: total, followers: 0, referred: 0 },
  paging: { total, page: 1, pageSize: 25, maxRows: 10000 },
  nextCursor: null,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('shop not approved', () => {
  it('shows the notice for access.seller-not-approved on the list, the page and the invite link', async () => {
    call.mockResolvedValue(fail(403, 'access.seller-not-approved'));
    render(wrap(<CustomersList csrfToken="c" />));
    expect(await screen.findByText('Your shop is not approved yet')).toBeTruthy();
    cleanup();
    render(wrap(<CustomerDetail code="AB12-CD34" />));
    expect(await screen.findByText('Your shop is not approved yet')).toBeTruthy();
    cleanup();
    render(wrap(<InviteCustomers storefrontOrigin="https://s.example" csrfToken="c" />));
    expect(await screen.findByText('Your shop is not approved yet')).toBeTruthy();
  });

  it('still hides the page for any other 403', async () => {
    call.mockResolvedValue(fail(403, 'access.denied'));
    render(wrap(<CustomersList csrfToken="c" />));
    expect(await screen.findByText('Customers are not available')).toBeTruthy();
    expect(screen.queryByText('Your shop is not approved yet')).toBeNull();
  });
});

describe('filter panel', () => {
  it('sends AUD 12.50 as 1250 and JPY 1250 as 1250', () => {
    const aud = vi.fn();
    render(
      wrap(<CustomersFilterPanel filters={{}} currency="AUD" onApply={aud} close={vi.fn()} />),
    );
    const spent = screen.getAllByLabelText('From');
    fireEvent.change(spent[2] as HTMLElement, { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(aud).toHaveBeenCalledWith({ spentMin: '1250' });
    cleanup();
    const jpy = vi.fn();
    render(
      wrap(<CustomersFilterPanel filters={{}} currency="JPY" onApply={jpy} close={vi.fn()} />),
    );
    fireEvent.change(screen.getAllByLabelText('From')[2] as HTMLElement, {
      target: { value: '1250' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(jpy).toHaveBeenCalledWith({ spentMin: '1250' });
  });

  it('refuses a JPY amount with decimals and a range that ends before it starts', () => {
    const onApply = vi.fn();
    render(
      wrap(<CustomersFilterPanel filters={{}} currency="JPY" onApply={onApply} close={vi.fn()} />),
    );
    fireEvent.change(screen.getAllByLabelText('From')[2] as HTMLElement, {
      target: { value: '12.5' },
    });
    fireEvent.change(screen.getAllByLabelText('From')[1] as HTMLElement, {
      target: { value: '5' },
    });
    fireEvent.change(screen.getAllByLabelText('To')[1] as HTMLElement, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText('Use an amount like 12.50.')).toBeTruthy();
    expect(screen.getByText('The end is before the start.')).toBeTruthy();
  });

  it('applies the flags, a day range and an orders range as typed', () => {
    const onApply = vi.fn();
    render(
      wrap(<CustomersFilterPanel filters={{}} currency="AUD" onApply={onApply} close={vi.fn()} />),
    );
    fireEvent.change(screen.getByLabelText('Follower'), { target: { value: 'yes' } });
    fireEvent.change(screen.getAllByLabelText('From')[0] as HTMLElement, {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(screen.getAllByLabelText('To')[1] as HTMLElement, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({
      follower: 'yes',
      lastOrderFrom: '2026-10-01',
      ordersMax: '9',
    });
  });

  it('shows Spent disabled with a hint while no currency is known, and keeps a set bound', () => {
    const onApply = vi.fn();
    render(
      wrap(
        <CustomersFilterPanel
          filters={{ spentMin: '500' }}
          currency={null}
          onApply={onApply}
          close={vi.fn()}
        />,
      ),
    );
    const spent = screen.getAllByLabelText('From')[2] as HTMLInputElement;
    expect(spent.disabled).toBe(true);
    expect(screen.getByText(/once the list shows a customer who has bought/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ spentMin: '500' });
  });

  it('opens with Spent disabled on a followers-only list (no row has a currency)', async () => {
    call.mockResolvedValue(
      ok({
        ...page(1),
        items: [row({ spentMinor: null, currency: null, orderCount: 0, follower: true })],
      }),
    );
    render(wrap(<CustomersList csrfToken="c" />));
    await screen.findByText('AB12-CD34');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect((screen.getAllByLabelText('From')[2] as HTMLInputElement).disabled).toBe(true);
  });
});

describe('sort and column panels', () => {
  it('changes the sort field in its natural direction', () => {
    const onChange = vi.fn();
    render(wrap(<CustomersSortPanel sort="last-order" direction="desc" onChange={onChange} />));
    fireEvent.click(screen.getByLabelText('Code'));
    expect(onChange).toHaveBeenCalledWith('code', 'asc');
    fireEvent.click(screen.getByLabelText('Orders'));
    expect(onChange).toHaveBeenLastCalledWith('orders', 'desc');
  });

  it('saves the chosen columns, and puts the code first and always', () => {
    const onSave = vi.fn();
    render(
      wrap(
        <CustomersColumnsPanel columns={['firstName', 'orders']} onSave={onSave} close={vi.fn()} />,
      ),
    );
    expect(screen.getByText('Code')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Orders'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(['firstName']);
  });
});

describe('export', () => {
  it('words batch.too-large with the total, from the API answer', async () => {
    const promise = vi.spyOn(toast, 'promise').mockImplementation((work) => {
      void (work as Promise<number>).catch(() => undefined);
      return Promise.resolve(0);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
            { status: 413, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    render(
      wrap(
        <CustomersExport
          query={DEFAULT_QUERY}
          selectedCodes={[]}
          allMatching={false}
          total={12000}
          csrfToken="c"
          timeZone="Australia/Brisbane"
          disabled={false}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Export' }).at(-1) as HTMLElement);
    await waitFor(() => expect(promise).toHaveBeenCalled());
    const [work, words] = promise.mock.calls[0] as unknown as [
      Promise<number>,
      { error: (reason: unknown) => string },
    ];
    const reason: unknown = await work.catch((caught: unknown) => caught);
    expect(words.error(reason)).toBe('Too many customers to select (12,000). Narrow the filters.');
  });

  it('turns the by-codes export off above 1,000 ticked codes, with a hint', () => {
    const codes = Array.from({ length: 1001 }, (_, i) => `C${i}`);
    render(
      wrap(
        <CustomersExport
          query={DEFAULT_QUERY}
          selectedCodes={codes}
          allMatching={false}
          total={5000}
          csrfToken="c"
          timeZone={null}
          disabled={false}
        />,
      ),
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export/ }).disabled).toBe(true);
    expect(screen.getByText(/at most 1,000 selected customers/)).toBeTruthy();
  });
});

describe('paging mode', () => {
  it('shows a total and page range with page numbers, and neither with Previous and next', async () => {
    call.mockResolvedValue(ok(page(60)));
    render(wrap(<CustomersList csrfToken="c" paging="pages" />));
    expect(await screen.findByText('1 to 1 of 60')).toBeTruthy();
    cleanup();
    call.mockResolvedValue(ok(page(60)));
    render(wrap(<CustomersList csrfToken="c" paging="prev-next" />));
    await screen.findByText('AB12-CD34');
    expect(screen.queryByText(/of 60/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Next/ }).length).toBeGreaterThan(0);
  });
});

describe('invite url', () => {
  it('encodes the token', () => {
    expect(inviteUrl('https://s.example', 'a/b?c d')).toBe(
      'https://s.example/invite/a%2Fb%3Fc%20d',
    );
  });
});

describe('exclusive discount in a second Market', () => {
  const fixed = (currency: string, amountMinor: string): OwnPromotion => ({
    id: '0190a000-0000-7000-8000-0000000000e1',
    type: 'CUSTOMER_GROUP',
    status: 'ACTIVE',
    name: 'Friends',
    funding: 'SELLER',
    startsAt: '2026-11-01T00:00:00.000Z',
    endsAt: null,
    currency,
    reward: { kind: 'FIXED', bps: null, amountMinor },
    segment: { kind: 'SELLER_EXCLUSIVE' },
    pausedBy: null,
  });
  const edit = async (promotion: OwnPromotion, locale: string) => {
    servePerks(call, { discount: [ok({ items: [promotion] })], writes: [ok({})] });
    render(
      wrap(
        <ExclusivePerks
          canManage
          csrfToken="c"
          timeZone="Australia/Brisbane"
          showPromotions
          showCommission
        />,
        locale,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
  };

  it('edits a JPY fixed amount without decimals and sends it unchanged', async () => {
    await edit(fixed('JPY', '500'), 'ja-JP');
    const field = screen.getByLabelText<HTMLInputElement>('Discount (JPY)');
    expect(field.value).toBe('500');
    fireEvent.change(field, { target: { value: '750' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call.mock.calls.some((c) => c[0] === 'PATCH')).toBe(true));
    expect(call.mock.calls.find((c) => c[0] === 'PATCH')?.[2]).toMatchObject({
      reward: { kind: 'FIXED', amountMinor: '750' },
      segment: { kind: 'SELLER_EXCLUSIVE' },
    });
    // JPY has no minor unit: a decimal is refused before any request.
  });

  it('edits an AUD fixed amount in dollars and sends minor units', async () => {
    await edit(fixed('AUD', '1250'), 'en-AU');
    const field = screen.getByLabelText<HTMLInputElement>('Discount (AUD)');
    expect(field.value).toBe('12.50');
    fireEvent.change(field, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call.mock.calls.some((c) => c[0] === 'PATCH')).toBe(true));
    expect(call.mock.calls.find((c) => c[0] === 'PATCH')?.[2]).toMatchObject({
      reward: { kind: 'FIXED', amountMinor: '2000' },
    });
  });

  it('refuses a JPY amount with decimals', async () => {
    await edit(fixed('JPY', '500'), 'ja-JP');
    fireEvent.change(screen.getByLabelText('Discount (JPY)'), { target: { value: '5.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter an amount like 12.50.')).toBeTruthy();
    expect(call.mock.calls.some((c) => c[0] !== 'GET')).toBe(false);
  });
});
