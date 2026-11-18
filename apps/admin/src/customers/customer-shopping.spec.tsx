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
import { CustomerShopping } from './customer-shopping.tsx';
import { ASSISTANT_VIEW, BEHAVIOUR_VIEW, CART_VIEW, REMINDER_VIEW, tabsFor } from './page-types.ts';

// Customers management phase 2b, part C: the Shopping tab. Two Markets: Australia (AUD, Brisbane)
// and Japan (JPY, no minor digits), so no currency or zone is assumed.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
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
const OFFER = '0190a000-0000-7000-8000-0000000000c1';
const VARIANT = '0190a000-0000-7000-8000-0000000000d1';
const ALL = new Set([CART_VIEW, REMINDER_VIEW, BEHAVIOUR_VIEW, ASSISTANT_VIEW]);
const base = {
  accountId: ID,
  adminAccountId: '0190a000-0000-7000-8000-0000000000ad',
  marketId: 'AU',
  csrfToken: 'csrf',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  keys: ALL as ReadonlySet<string>,
};

const page = <T,>(items: T[], extra: object = {}) => ({
  items,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  total: items.length,
  hasNext: false,
  ...extra,
});
const cart = (currency: string, amount: string) => ({
  savedCount: 2,
  cart: {
    createdAt: '2026-11-01T00:00:00.000Z',
    lastChangedAt: '2026-11-10T02:30:00.000Z',
    lines: [
      {
        offerId: OFFER,
        variantId: VARIANT,
        quantity: 3,
        priceAtAdd: { amount, currency },
        addedAt: '2026-11-09T02:30:00.000Z',
      },
    ],
  },
});
const behaviour = {
  personalization: { enabled: true, changedAt: '2026-10-01T00:00:00.000Z' },
  summary: {
    productViews: 1200,
    categoryViews: 340,
    cartAdditions: 12,
    topCategories: [{ categoryId: '0190a000-0000-7000-8000-0000000000e1', views: 40 }],
  },
  // Not part of the contract: a stray field must never reach the screen.
  searchText: 'halal chicken wings',
};

type Over = Partial<Record<string, ApiResult<unknown>>>;
function route(over: Over = {}, currency = 'AUD', amount = '1250') {
  call.mockImplementation((_method, path) => {
    const name = path.slice(`customers/admin/customers/${ID}/`.length);
    if (over[name] !== undefined) return Promise.resolve(over[name] as ApiResult<never>);
    const answers: Record<string, unknown> = {
      cart: cart(currency, amount),
      behaviour,
      'saved-items': page([
        {
          savedItemId: 's1',
          offerId: OFFER,
          variantId: VARIANT,
          savedAt: '2026-11-05T02:30:00.000Z',
        },
      ]),
      'cart-reminders': page([
        { sentAt: '2026-11-11T02:30:00.000Z', stage: 2, cartChangedAt: '2026-11-10T02:30:00.000Z' },
      ]),
      'cart-additions': page([
        { offerId: OFFER, variantId: VARIANT, addedAt: '2026-11-09T02:30:00.000Z' },
      ]),
      'assistant-conversations': page(
        [
          {
            startedAt: '2026-11-02T02:30:00.000Z',
            lastMessageAt: '2026-11-02T03:30:00.000Z',
            message: 'my secret question',
          },
        ],
        { conversationCount: 7 },
      ),
    };
    return Promise.resolve(ok(answers[name]) as ApiResult<never>);
  });
}
const title = (name: string) => screen.findByRole('heading', { name });
const noTitle = (name: string) => screen.queryByRole('heading', { name });

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

describe('the Shopping tab', () => {
  it('shows a tab only to an admin who holds one of its keys', () => {
    expect(tabsFor(new Set())).not.toContain('shopping');
    expect(tabsFor(new Set([ASSISTANT_VIEW]))).toContain('shopping');
    expect(tabsFor(new Set([CART_VIEW]))).not.toContain('reviews');
  });

  it('loads every section under its own key, with money in the Market currency (AUD)', async () => {
    route();
    render(wrap(<CustomerShopping {...base} />));
    for (const name of [
      'Current cart',
      'Saved for later',
      'Abandoned-cart reminders sent',
      'Added to cart in the last 12 months',
      'Behaviour summary',
      'Assistant conversations',
    ]) {
      expect(await title(name)).toBeTruthy();
    }
    expect(await screen.findByText('$12.50')).toBeTruthy();
    expect(await screen.findByText('Reminder 2')).toBeTruthy();
    expect(await screen.findByText('1,200')).toBeTruthy();
    expect(await screen.findByText('7 conversations in all')).toBeTruthy();
    // Times are in the admin's zone, with its name (Brisbane has no daylight saving).
    expect((await screen.findAllByText(/10 Nov 2026.*AEST/)).length).toBeGreaterThan(0);
  });

  it('shows the price in yen without minor digits in another Market (JPY)', async () => {
    route({}, 'JPY', '1250');
    render(wrap(<CustomerShopping {...base} marketId="JP" zone="Asia/Tokyo" />));
    expect(await screen.findByText(/JPY\s?1,250(?![.,]\d)/)).toBeTruthy();
    expect(screen.queryByText('$12.50')).toBeNull();
  });

  it('shows no search text and no assistant message, even if the API sent one', async () => {
    route();
    render(wrap(<CustomerShopping {...base} />));
    await title('Assistant conversations');
    await screen.findByText('1,200');
    await screen.findByText('Reminder 2');
    expect(document.body.textContent).not.toContain('halal chicken wings');
    expect(document.body.textContent).not.toContain('my secret question');
  });

  it('says so when the cart and the lists are empty', async () => {
    route({
      cart: ok({ savedCount: 0, cart: null }),
      'saved-items': ok(page([])),
      'cart-reminders': ok(page([])),
      'cart-additions': ok(page([])),
      'assistant-conversations': ok(page([], { conversationCount: 0 })),
    });
    render(wrap(<CustomerShopping {...base} />));
    expect(await screen.findByText('The cart is empty.')).toBeTruthy();
    expect(await screen.findByText('Nothing saved for later.')).toBeTruthy();
    expect(await screen.findByText('No reminders in the last 30 days.')).toBeTruthy();
    expect(await screen.findByText('Nothing added to a cart in the last 12 months.')).toBeTruthy();
    expect(await screen.findByText('No assistant conversations.')).toBeTruthy();
  });

  it('keeps a failed section inside itself, with Retry, and the others working', async () => {
    route({ cart: refused(503, 'access.unavailable'), 'cart-reminders': refused(500, 'x') });
    render(wrap(<CustomerShopping {...base} />));
    expect(await screen.findByText('Current cart could not be loaded.')).toBeTruthy();
    expect(await title('Saved for later')).toBeTruthy();
    await screen.findByText('1,200');
    // Retry reads the section again and shows it.
    route();
    const cartCard = (await title('Current cart')).closest('section')!;
    fireEvent.click(within(cartCard).getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByText('$12.50')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Current cart could not be loaded.')).toBeNull());
  });

  it('retries a list that failed on its first load', async () => {
    route({ 'saved-items': refused(503, 'access.unavailable') });
    render(wrap(<CustomerShopping {...base} />));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    route();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect((await screen.findAllByText(/Nov 2026/)).length).toBeGreaterThan(0);
  });

  it('hides a section whose key the API refuses (403), and only that one', async () => {
    route({
      cart: refused(403, 'access.denied'),
      'saved-items': refused(403, 'access.denied'),
      behaviour: refused(403, 'access.denied'),
      'assistant-conversations': refused(403, 'access.denied'),
    });
    render(wrap(<CustomerShopping {...base} />));
    await title('Abandoned-cart reminders sent');
    await title('Added to cart in the last 12 months');
    await waitFor(() => expect(noTitle('Current cart')).toBeNull());
    expect(noTitle('Saved for later')).toBeNull();
    expect(noTitle('Behaviour summary')).toBeNull();
    expect(noTitle('Assistant conversations')).toBeNull();
  });

  it('does not ask for a section whose key the admin lacks', async () => {
    route();
    render(wrap(<CustomerShopping {...base} keys={new Set([CART_VIEW])} />));
    await title('Current cart');
    await title('Saved for later');
    const paths = call.mock.calls.map((entry) => entry[1]);
    expect(paths.some((path) => path.endsWith('/behaviour'))).toBe(false);
    expect(paths.some((path) => path.endsWith('/cart-reminders'))).toBe(false);
    expect(paths.some((path) => path.endsWith('/assistant-conversations'))).toBe(false);
  });

  it('tells the admin when to try again after a throttled read (429)', async () => {
    route({ behaviour: refused(429, 'request.throttled', { retryAfterSeconds: 150 }) });
    render(wrap(<CustomerShopping {...base} />));
    expect(await screen.findByText('Too many requests. Try again in 3 minutes.')).toBeTruthy();
  });

  it('turns the admin’s local days into instants for the add-to-cart filter', async () => {
    route();
    render(wrap(<CustomerShopping {...base} />));
    await title('Added to cart in the last 12 months');
    const additions = (await title('Added to cart in the last 12 months')).closest('section')!;
    fireEvent.click(within(additions).getByRole('button', { name: /Filter/ }));
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        call.mock.calls.some(
          (entry) =>
            entry[1].endsWith('/cart-additions') &&
            (entry[2] as { filters?: { from?: string } }).filters?.from ===
              '2026-10-31T14:00:00.000Z',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('From 2026-11-01')).toBeTruthy();
  });
});

describe('the Shopping tab export', () => {
  const createObjectURL = vi.fn(() => 'blob:x');
  beforeEach(() => {
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it(
    'asks for the two-step code, sends the same export again and downloads it',
    { timeout: 15_000 },
    async () => {
      route();
      call.mockImplementation((_method, path) => {
        if (path === 'identity/admin/step-up/verify') {
          return Promise.resolve(ok({ code: 'step-up-verified' }) as ApiResult<never>);
        }
        return Promise.resolve(
          ok(
            path.endsWith('/cart')
              ? cart('AUD', '1250')
              : path.endsWith('/behaviour')
                ? behaviour
                : page(
                    [
                      {
                        savedItemId: 's1',
                        offerId: OFFER,
                        variantId: VARIANT,
                        savedAt: '2026-11-05T02:30:00.000Z',
                      },
                    ],
                    { conversationCount: 1 },
                  ),
          ) as ApiResult<never>,
        );
      });
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
        .mockResolvedValueOnce(new Response('﻿a,b\r\n'));
      vi.stubGlobal('fetch', fetchMock);
      render(
        wrap(
          <CustomerShopping {...base} keys={new Set([CART_VIEW, 'customers.customers.export'])} />,
        ),
      );
      const saved = (await title('Saved for later')).closest('section')!;
      await within(saved).findByRole('table', {}, { timeout: 5000 });
      fireEvent.click(within(saved).getByRole('button', { name: 'Export…' }));
      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Export saved for later' },
        { timeout: 5000 },
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
      await screen.findByRole('dialog', { name: 'Confirm it is you' }, { timeout: 5000 });
      fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0]!, {
        clipboardData: { getData: () => '123456' },
      });
      expect(
        await screen.findByText('File exported.', undefined, { timeout: 10_000 }),
      ).toBeTruthy();
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/step-up/verify',
        { actionKey: 'customers.customers.export', code: '123456' },
        'csrf',
      );
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/customers/admin/customers/${ID}/saved-items/export`);
      expect(JSON.parse(init.body as string)).toEqual({ format: 'csv', direction: 'desc' });
      expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(init.body);
      expect(createObjectURL).toHaveBeenCalledOnce();
    },
  );

  it('has no Export button without the export key', async () => {
    route();
    render(wrap(<CustomerShopping {...base} keys={new Set([CART_VIEW])} />));
    const saved = (await title('Saved for later')).closest('section')!;
    await within(saved).findByRole('table', {}, { timeout: 5000 });
    expect(within(saved).queryByRole('button', { name: 'Export…' })).toBeNull();
  });
});
