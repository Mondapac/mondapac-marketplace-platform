// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/customers/x',
  useSearchParams: () => new URLSearchParams(),
}));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomerMoney } from './customer-money.tsx';
import { CustomersList } from './customers-list.tsx';
import type { CustomerRow, CustomersPage } from './list-types.ts';
import type {
  DisputeRow,
  ListAnswer,
  PaymentRow,
  PaymentsAnswer,
  PromotionUsage,
  RefundRow,
} from './money-types.ts';
import type { CustomerOverview } from './page-types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages}>
    <StepUpProvider>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const ID = '0190a000-0000-7000-8000-0000000000a1';
const ORDER = '0190a000-0000-7000-8000-0000000000c1';
const VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
const PAY = 'payments.customer-payment.view';
const ORDERS = 'ordering.order.view';
const PROMO = 'promotions.promotion.view';
const ALL = new Set([VIEW, EXPORT, PAY, ORDERS, PROMO]);

const customer = (currency: string): CustomerOverview => ({
  accountId: ID,
  email: 'sara@example.com',
  displayName: 'Sara Ahmadi',
  status: 'active',
  emailVerified: true,
  signedUpAt: '2026-10-01T02:30:00.000Z',
  lastOrderAt: '2026-11-10T02:30:00.000Z',
  orderCount: 3,
  spentMinor: '12550',
  currency,
  refundCount: 1,
  firstOrderAt: '2026-10-05T02:30:00.000Z',
  refundedMinor: '1000',
});

const props = (currency = 'AUD', zone = 'Australia/Brisbane', marketId = 'AU') => ({
  customer: customer(currency),
  adminAccountId: 'admin-1',
  marketId,
  csrfToken: 'csrf',
  keys: ALL as ReadonlySet<string>,
  zone,
  paging: 'pages' as const,
  walletBalance: null,
});

const list = <T,>(items: readonly T[], total = items.length): ListAnswer<T> => ({
  items,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  total,
  hasNext: false,
});
const payment = (currency: string, amount: string, over: Partial<PaymentRow> = {}): PaymentRow => ({
  orderId: ORDER,
  status: 'confirmed',
  paymentState: 'captured',
  amount: { amount, currency },
  providerPaymentId: 'pi_123',
  createdAt: '2026-11-02T01:00:00.000Z',
  confirmedAt: '2026-11-02T01:05:00.000Z',
  ...over,
});
const dispute = (currency: string, amount: string): DisputeRow => ({
  disputeId: 'dp-1',
  orderId: ORDER,
  status: 'needs_response',
  reason: 'fraudulent',
  amount: { amount, currency },
  openedAt: '2026-11-03T01:00:00.000Z',
  evidenceDueBy: '2026-11-20T01:00:00.000Z',
  outcome: null,
});
const refund = (currency: string, amount: string): RefundRow => ({
  refundId: 'rf-1',
  orderId: ORDER,
  sellerOrderId: 'so-1',
  state: 'succeeded',
  reason: 'damaged',
  amount: { amount, currency },
  requestedAt: '2026-11-04T01:00:00.000Z',
  settledAt: '2026-11-04T02:00:00.000Z',
  creditNoteId: 'CN-0001',
});
const usage = (over: Partial<PromotionUsage> = {}): PromotionUsage => ({
  id: 'u-1',
  orderId: ORDER,
  kind: 'PROMOTION',
  promotionId: 'p-1',
  promotionName: 'Eid sale',
  amountMinor: '500',
  currency: 'AUD',
  usedCode: true,
  status: 'CONFIRMED',
  releaseReason: null,
  usedAt: '2026-11-05T01:00:00.000Z',
  confirmedAt: '2026-11-05T01:05:00.000Z',
  releasedAt: null,
  ...over,
});

interface Answers {
  payments?: ApiResult<unknown>;
  disputes?: ApiResult<unknown>;
  refunds?: ApiResult<unknown>;
  usages?: (cursor: string | null) => ApiResult<unknown>;
}

function route(answers: Answers = {}, currency = 'AUD') {
  call.mockImplementation((method, path) => {
    if (method === 'POST' && path === `payments/admin/customers/${ID}/payments`) {
      return Promise.resolve(
        (answers.payments ??
          ok({
            ...list([payment(currency, '12550')]),
            paid: [{ amount: '12550', currency }],
          } satisfies PaymentsAnswer)) as ApiResult<never>,
      );
    }
    if (method === 'POST' && path === `payments/admin/customers/${ID}/disputes`) {
      return Promise.resolve(
        (answers.disputes ?? ok(list([dispute(currency, '2500')]))) as ApiResult<never>,
      );
    }
    if (method === 'POST' && path === `ordering/admin/customers/${ID}/refunds`) {
      return Promise.resolve(
        (answers.refunds ?? ok(list([refund(currency, '1000')]))) as ApiResult<never>,
      );
    }
    if (method === 'GET' && path.startsWith(`promotions/admin/customers/${ID}/usages`)) {
      const cursor = new URL(`http://x/${path}`).searchParams.get('cursor');
      return Promise.resolve(
        (answers.usages?.(cursor) ??
          ok({ items: [usage({ currency })], nextCursor: null })) as ApiResult<never>,
      );
    }
    // The promotion credits are a phase 1 section, not under test here.
    if (method === 'GET' && path.startsWith(`promotions/admin/customers/${ID}/credits`)) {
      return Promise.resolve(ok({ items: [], nextCursor: null }) as ApiResult<never>);
    }
    return Promise.resolve(refused(404, 'unknown'));
  });
}

const bodiesTo = (path: string) =>
  call.mock.calls.filter((args) => args[0] === 'POST' && args[1] === path).map((args) => args[2]);

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the Money tab sections of phase 2b', () => {
  it('loads payments, disputes, refunds and promotion usages, each on its own', async () => {
    route();
    render(wrap(<CustomerMoney {...props()} />));
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Disputes' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Refunds and credit notes' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Promotions used' })).toBeTruthy();
    // Payments: the order links back to this tab, the paid sum is under the heading.
    const link = (await screen.findAllByRole('link', { name: /^Order 000000C1/ }))[0]!;
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER}?customer=${ID}&from=money`);
    expect(await screen.findByText('Paid, before refunds: $125.50')).toBeTruthy();
    expect(bodiesTo(`payments/admin/customers/${ID}/payments`)[0]).toEqual({
      sort: 'created',
      direction: 'desc',
      page: 1,
      pageSize: 25,
      paging: 'pages',
    });
    expect(bodiesTo(`ordering/admin/customers/${ID}/refunds`)[0]).toMatchObject({
      sort: 'requested',
      paging: 'pages',
    });
    expect(screen.getByText('Needs response')).toBeTruthy();
    expect(screen.getByText('CN-0001')).toBeTruthy();
    // The usage row: the promotion's name, that a code was used (never the code), the status.
    expect(screen.getByText('Eid sale')).toBeTruthy();
    expect(screen.getByText('with a code')).toBeTruthy();
    expect(screen.getAllByText('Used')).toHaveLength(2);
    expect(
      call.mock.calls.some(
        (args) => args[1] === `ordering/admin/customers/${ID}/refunds` && args[0] === 'GET',
      ),
    ).toBe(false);
  });

  it('shows amounts in the Market currency, never AUD by default (NZD and JPY)', async () => {
    route({}, 'NZD');
    render(wrap(<CustomerMoney {...props('NZD', 'Pacific/Auckland', 'NZ')} />, 'en-NZ'));
    expect(await screen.findByText(/Paid, before refunds: .*125\.50/)).toBeTruthy();
    expect((await screen.findAllByText(/\$10\.00/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/A\$/)).toBeNull();
    cleanup();
    route({}, 'JPY');
    render(wrap(<CustomerMoney {...props('JPY', 'Asia/Tokyo', 'JP')} />, 'en-AU'));
    // JPY has no minor unit: 12550 is ¥12,550, not 125.50.
    expect(await screen.findByText(/Paid, before refunds: .*12,550/)).toBeTruthy();
    expect(screen.queryByText(/125\.50/)).toBeNull();
  });

  it('says each list is empty, and the usages too', async () => {
    route({
      payments: ok({ ...list<PaymentRow>([]), paid: [] }),
      disputes: ok(list<DisputeRow>([])),
      refunds: ok(list<RefundRow>([])),
      usages: () => ok({ items: [], nextCursor: null }),
    });
    render(wrap(<CustomerMoney {...props()} />));
    expect(await screen.findByText('No payments yet.')).toBeTruthy();
    expect(await screen.findByText('No disputes.')).toBeTruthy();
    expect(await screen.findByText('No refunds')).toBeTruthy();
    expect(await screen.findByText('No promotions used yet.')).toBeTruthy();
  });

  it('names a failed section with Retry and leaves the others working', async () => {
    route({ disputes: refused(503, 'unavailable'), usages: () => refused(503, 'unavailable') });
    render(wrap(<CustomerMoney {...props()} />));
    expect(await screen.findByText('This list could not be loaded.')).toBeTruthy();
    expect(await screen.findByText('Promotions used could not be loaded.')).toBeTruthy();
    // The payments and refunds still show.
    expect(await screen.findByText('CN-0001')).toBeTruthy();
    route();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    expect(await screen.findByText('Needs response')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Eid sale')).toBeTruthy();
  });

  it('hides a section the API answers 403 for, without an error', async () => {
    route({ payments: refused(403, 'access.denied'), usages: () => refused(403, 'access.denied') });
    render(wrap(<CustomerMoney {...props()} />));
    expect(await screen.findByText('CN-0001')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Payments' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Promotions used' })).toBeNull();
    expect(screen.queryByText('This list could not be loaded.')).toBeNull();
  });

  it('asks for no section whose key the admin lacks', async () => {
    route();
    render(wrap(<CustomerMoney {...props()} keys={new Set([VIEW, PAY])} />));
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Refunds and credit notes' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Promotions used' })).toBeNull();
    expect(call.mock.calls.some((args) => String(args[1]).startsWith('ordering/'))).toBe(false);
    expect(call.mock.calls.some((args) => String(args[1]).startsWith('promotions/'))).toBe(false);
    // No export without the export key.
    expect(screen.queryByRole('button', { name: 'Export…' })).toBeNull();
  });

  it('turns a state view and a day range into the API filters, days as instants in the admin zone', async () => {
    route();
    render(wrap(<CustomerMoney {...props('AUD', 'Australia/Brisbane')} />));
    await screen.findByText('Paid, before refunds: $125.50');
    const payments = within(screen.getByRole('heading', { name: 'Payments' }).closest('section')!);
    fireEvent.click(payments.getByRole('button', { name: 'Authorised' }));
    await waitFor(() =>
      expect(bodiesTo(`payments/admin/customers/${ID}/payments`).at(-1)).toMatchObject({
        filters: { paymentState: ['authorised'] },
      }),
    );
    fireEvent.click(payments.getByRole('button', { name: /^Filter/ }));
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // Brisbane is UTC+10 all year: 1 Nov 00:00 local is 31 Oct 14:00Z; the end is the next day's start.
    await waitFor(() =>
      expect(bodiesTo(`payments/admin/customers/${ID}/payments`).at(-1)).toMatchObject({
        filters: {
          paymentState: ['authorised'],
          from: '2026-10-31T14:00:00.000Z',
          to: '2026-11-03T14:00:00.000Z',
        },
      }),
    );
  });
});

describe('the Money tab loading and throttling', () => {
  it('shows a loading skeleton in each new list before its answer', () => {
    call.mockImplementation(() => new Promise(() => undefined));
    render(wrap(<CustomerMoney {...props()} />));
    for (const name of ['Payments', 'Disputes', 'Refunds and credit notes', 'Promotions used']) {
      expect(screen.getByText(new RegExp(`^Loading ${name}`))).toBeTruthy();
    }
  });

  it('says how long to wait when a money list is throttled (429), with Try again', async () => {
    route({ payments: refused(429, 'request.throttled', { retryAfterSeconds: 150 }) });
    render(wrap(<CustomerMoney {...props()} />));
    expect(await screen.findByText('Too many requests. Try again in 3 minutes.')).toBeTruthy();
    expect(await screen.findByText('CN-0001')).toBeTruthy();
  });

  it('hides a money list that is refused (403) on a later page, not only the first', async () => {
    let page2 = false;
    route();
    const inner = call.getMockImplementation()!;
    call.mockImplementation((method, path, body, csrf) => {
      if (path === `payments/admin/customers/${ID}/payments`) {
        const wanted = (body as { page?: number }).page ?? 1;
        if (wanted > 1) return Promise.resolve(refused(403, 'access.denied'));
        page2 = true;
        return Promise.resolve(
          ok({
            ...list([payment('AUD', '12550')], 60),
            paid: [{ amount: '12550', currency: 'AUD' }],
          }) as ApiResult<never>,
        );
      }
      return inner(method, path, body, csrf);
    });
    render(wrap(<CustomerMoney {...props()} keys={new Set([VIEW, PAY])} />));
    const section = (await screen.findByRole('heading', { name: 'Payments' })).closest('section')!;
    await within(section).findByRole('table');
    expect(page2).toBe(true);
    fireEvent.click(within(section).getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Payments' })).toBeNull());
  });

  it('hides the wallet and promotion credits on a 403, as an absent section', async () => {
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path.startsWith('wallet/admin/') || path.startsWith('promotions/admin/customers/')
          ? refused(403, 'access.denied')
          : refused(404, 'unknown'),
      ),
    );
    render(
      wrap(
        <CustomerMoney
          {...props()}
          keys={new Set([VIEW, 'wallet.credit.view', 'promotions.promotion.view'])}
        />,
      ),
    );
    await waitFor(() => expect(call).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Wallet history' })).toBeNull(),
    );
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('the Money tab export', () => {
  const createObjectURL = vi.fn(() => 'blob:x');
  beforeEach(() => {
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  // The step-up round trip and the file download take a few seconds on a loaded runner.
  it(
    'exports payments: asks for the code, sends the same request again and downloads it',
    { timeout: 15_000 },
    async () => {
      route();
      call.mockImplementation((method, path) =>
        path === 'identity/admin/step-up/verify'
          ? Promise.resolve(ok({}) as ApiResult<never>)
          : Promise.resolve(
              path === `payments/admin/customers/${ID}/payments`
                ? (ok({
                    ...list([payment('AUD', '12550')]),
                    paid: [{ amount: '12550', currency: 'AUD' }],
                  }) as ApiResult<never>)
                : refused(404, 'unknown'),
            ),
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: 'second-factor.required',
              details: { actionKey: 'customers.customers.export' },
            }),
            { status: 403 },
          ),
        )
        .mockResolvedValueOnce(new Response('﻿order,amount\r\n'));
      vi.stubGlobal('fetch', fetchMock);
      render(wrap(<CustomerMoney {...props()} keys={new Set([VIEW, EXPORT, PAY])} />));
      await screen.findByText('Paid, before refunds: $125.50');
      const payments = within(
        screen.getByRole('heading', { name: 'Payments' }).closest('section')!,
      );
      fireEvent.click(payments.getAllByRole('button', { name: 'Export…' })[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Export payments' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
      await screen.findByRole('dialog', { name: 'Confirm it is you' });
      fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0]!, {
        clipboardData: { getData: () => '123456' },
      });
      expect(
        await screen.findByText('Payments exported.', undefined, { timeout: 10_000 }),
      ).toBeTruthy();
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/step-up/verify',
        { actionKey: 'customers.customers.export', code: '123456' },
        'csrf',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/payments/admin/customers/${ID}/payments/export`);
      expect(JSON.parse(init.body as string)).toEqual({
        format: 'csv',
        sort: 'created',
        direction: 'desc',
      });
      expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(init.body);
      expect(createObjectURL).toHaveBeenCalledOnce();
    },
  );

  it('says how long to wait when the export is throttled (429)', async () => {
    route();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'request.throttled', details: { retryAfterSeconds: 300 } }),
        {
          status: 429,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<CustomerMoney {...props()} keys={new Set([VIEW, EXPORT, ORDERS])} />));
    await screen.findByText('CN-0001');
    fireEvent.click(screen.getAllByRole('button', { name: 'Export…' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Export refunds' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(
      await screen.findByText('Too many requests. Try again in 5 minutes.', undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
  });

  it('says how many rows can be exported when the filter is too large', async () => {
    route();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
          { status: 413 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<CustomerMoney {...props()} keys={new Set([VIEW, EXPORT, ORDERS])} />));
    await screen.findByText('CN-0001');
    fireEvent.click(screen.getAllByRole('button', { name: 'Export…' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Export refunds' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(
      await screen.findByText(/Up to 10,000 rows can be exported at once/, undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect((fetchMock.mock.calls[0]![0] as string).endsWith('/refunds/export')).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('promotion usages', () => {
  const only = new Set([VIEW, PROMO]);

  it('loads more with the cursor, appends the rows and drops the button on the last page', async () => {
    route({
      usages: (cursor) =>
        cursor === null
          ? ok({ items: [usage({ id: 'u-1' })], nextCursor: 'c1.2' })
          : ok({
              items: [
                usage({
                  id: 'u-2',
                  kind: 'FIRST_ORDER',
                  promotionId: null,
                  promotionName: null,
                  usedCode: false,
                  status: 'RELEASED',
                  releaseReason: 'ORDER_CANCELLED',
                }),
              ],
              nextCursor: null,
            }),
    });
    render(wrap(<CustomerMoney {...props()} keys={only} />));
    expect(await screen.findByText('Eid sale')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    // A settings-based offer has no name: the kind's name stands in; a release says why.
    expect(await screen.findByText('First-order offer')).toBeTruthy();
    expect(screen.getByText('Order cancelled')).toBeTruthy();
    expect(screen.getByText('Eid sale')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const paths = call.mock.calls.map((args) => String(args[1]));
    expect(paths).toContain(`promotions/admin/customers/${ID}/usages?limit=25`);
    expect(paths).toContain(`promotions/admin/customers/${ID}/usages?limit=25&cursor=c1.2`);
    // No total, no page numbers: it is a plain list.
    expect(screen.queryByRole('navigation', { name: /pagination/i })).toBeNull();
  });

  it('keeps the rows and offers a retry when Load more fails', async () => {
    let fail = true;
    route({
      usages: (cursor) =>
        cursor === null
          ? ok({ items: [usage()], nextCursor: 'c1.2' })
          : fail
            ? refused(503, 'unavailable')
            : ok({ items: [usage({ id: 'u-2', promotionName: 'Ramadan' })], nextCursor: null }),
    });
    render(wrap(<CustomerMoney {...props()} keys={only} />));
    await screen.findByText('Eid sale');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('More rows could not be loaded.')).toBeTruthy();
    expect(screen.getByText('Eid sale')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ramadan')).toBeTruthy();
  });

  it('announces the rows a Load more added', async () => {
    route({
      usages: (cursor) =>
        cursor === null
          ? ok({ items: [usage({ id: 'u-1' })], nextCursor: 'c1.2' })
          : ok({ items: [usage({ id: 'u-2', promotionName: 'Ramadan' })], nextCursor: null }),
    });
    render(wrap(<CustomerMoney {...props()} keys={only} />));
    await screen.findByText('Eid sale');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Ramadan');
    const note = screen.getByText('1 more row loaded');
    expect(note.getAttribute('role')).toBe('status');
  });

  it('shows the wait when the first read or Load more is throttled (429)', async () => {
    route({ usages: () => refused(429, 'request.throttled', { retryAfterSeconds: 120 }) });
    const first = render(wrap(<CustomerMoney {...props()} keys={only} />));
    expect(await screen.findByText('Too many requests. Try again in 2 minutes.')).toBeTruthy();
    first.unmount();
    cleanup();
    route({
      usages: (cursor) =>
        cursor === null
          ? ok({ items: [usage()], nextCursor: 'c1.2' })
          : refused(429, 'request.throttled', { retryAfterSeconds: 60 }),
    });
    render(wrap(<CustomerMoney {...props()} keys={only} />));
    await screen.findByText('Eid sale');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Too many requests. Try again in 1 minute.')).toBeTruthy();
    expect(screen.getByText('Eid sale')).toBeTruthy();
  });

  it('shows the discount in the usage currency (JPY has no minor unit)', async () => {
    route({
      usages: () =>
        ok({ items: [usage({ amountMinor: '500', currency: 'JPY' })], nextCursor: null }),
    });
    render(wrap(<CustomerMoney {...props('JPY', 'Asia/Tokyo', 'JP')} keys={only} />));
    expect(await screen.findByText(/500/)).toBeTruthy();
    expect(screen.queryByText(/5\.00/)).toBeNull();
  });
});

describe('the Customers list order number search', () => {
  const row: CustomerRow = {
    accountId: ID,
    email: 'sara@example.com',
    displayName: 'Sara Ahmadi',
    status: 'active',
    emailVerified: true,
    signedUpAt: '2026-10-01T02:30:00.000Z',
    lastOrderAt: null,
    orderCount: 1,
    spentMinor: '100',
    currency: 'AUD',
    refundCount: 0,
  };
  const page: CustomersPage = {
    items: [row],
    counts: {
      all: 1,
      new: 0,
      active: 1,
      inactive: 0,
      'never-ordered': 0,
      disabled: 0,
      'pending-deletion': 0,
    },
    paging: { total: 1, page: 1, pageSize: 25, maxRows: 10_000 },
    nextCursor: null,
  };
  const listProps = {
    accountId: 'admin-1',
    marketId: 'AU',
    marketName: 'Test',
    zone: 'Australia/Brisbane',
    paging: 'pages' as const,
    csrfToken: 'csrf',
  };
  const listBodies = () => bodiesTo('customers/admin/list');
  const answer = () =>
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path === 'customers/admin/list'
          ? (ok(page) as ApiResult<never>)
          : path.startsWith('customers/admin/saved-filters')
            ? (ok({
                items: [],
                canShare: false,
                limits: { perOwner: 50, shared: 20 },
              }) as ApiResult<never>)
            : refused(404, 'unknown'),
      ),
    );

  it('sends orderNumber in the list body, shows a chip and clears it', async () => {
    answer();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW, ORDERS]} />));
    await screen.findByText('Sara Ahmadi');
    expect('orderNumber' in (listBodies()[0] as object)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.change(await screen.findByLabelText('Order number'), {
      target: { value: '  0190A000-0000-7000-8000-0000000000C1 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(listBodies().at(-1)).toMatchObject({
        orderNumber: '0190A000-0000-7000-8000-0000000000C1',
        view: 'all',
        page: 1,
      }),
    );
    expect(await screen.findByText(/Order: 0190A000/)).toBeTruthy();
    // Not a saved filter: the API's saved document has no order number.
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Remove filter Order/ }));
    await waitFor(() => expect('orderNumber' in (listBodies().at(-1) as object)).toBe(false));
  });

  it('offers no order number field without the orders key (the API would refuse it)', async () => {
    answer();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    await screen.findByText('Sara Ahmadi');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    await screen.findByLabelText('Status');
    expect(screen.queryByLabelText('Order number')).toBeNull();
  });
});
