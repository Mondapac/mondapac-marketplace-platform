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
import { CustomerPage } from './customer-page.tsx';
import { CustomerReviews } from './customer-reviews.tsx';
import { REVIEWS_VIEW, tabsFor } from './page-types.ts';

// Customers management phase 2b, part C: the Reviews tab. The lists carry no money, so the two
// Markets here differ in the zone the times are shown in (Brisbane and Auckland).

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
const REVIEW = '0190a000-0000-7000-8000-0000000000b1';
const base = {
  accountId: ID,
  adminAccountId: '0190a000-0000-7000-8000-0000000000ad',
  marketId: 'AU',
  csrfToken: 'csrf',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  keys: new Set([REVIEWS_VIEW, 'reviews.moderation.queue']) as ReadonlySet<string>,
};

const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  total: items.length,
  hasNext: false,
});
const review = {
  reviewId: REVIEW,
  productId: '0190a000-0000-7000-8000-0000000000c1',
  offerId: '0190a000-0000-7000-8000-0000000000c2',
  sellerId: '0190a000-0000-7000-8000-0000000000c3',
  rating: 4,
  anonymous: false,
  status: 'held',
  createdAt: '2026-11-10T14:30:00.000Z',
  editedAt: null,
  publishedAt: null,
  helpfulCount: 3,
  openReports: 2,
  lastModeration: {
    action: 'hide',
    reasonCode: 'spam',
    byModerator: true,
    at: '2026-11-11T00:00:00.000Z',
  },
  // Not part of the contract: a stray text must never reach the screen.
  body: 'the chicken was dry and cold',
};
const rating = {
  ratingId: '0190a000-0000-7000-8000-0000000000f1',
  sellerId: '0190a000-0000-7000-8000-0000000000c3',
  sellerOrderId: null,
  satisfaction: 5,
  asDescribed: true,
  arrivedOk: false,
  reasonCode: null,
  status: 'published',
  createdAt: '2026-11-09T02:30:00.000Z',
};
const vote = { reviewId: REVIEW, productId: review.productId, votedAt: '2026-11-08T02:30:00.000Z' };
const report = {
  reportId: '0190a000-0000-7000-8000-0000000000f2',
  reviewId: REVIEW,
  role: 'about',
  reasonCode: 'abusive',
  status: 'open',
  createdAt: '2026-11-07T02:30:00.000Z',
};

type Over = Partial<Record<string, ApiResult<unknown>>>;
function route(over: Over = {}) {
  call.mockImplementation((_method, path) => {
    const name = path.slice(`customers/admin/customers/${ID}/`.length);
    if (over[name] !== undefined) return Promise.resolve(over[name] as ApiResult<never>);
    const answers: Record<string, unknown> = {
      reviews: page([review]),
      'seller-ratings': page([rating]),
      'helpful-votes': page([vote]),
      'review-reports': page([report]),
    };
    return Promise.resolve(ok(answers[name]) as ApiResult<never>);
  });
}
const title = (name: string) => screen.findByRole('heading', { name });
const noTitle = (name: string) => screen.queryByRole('heading', { name });
const NAMES = ['Reviews written', 'Seller ratings given', 'Helpful votes cast', 'Review reports'];

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

describe('the Reviews tab', () => {
  it('shows a tab only to an admin who holds the reviews key', () => {
    expect(tabsFor(new Set())).not.toContain('reviews');
    expect(tabsFor(new Set([REVIEWS_VIEW]))).toContain('reviews');
  });

  it('loads the four sections, with status words and no review text', async () => {
    route();
    render(wrap(<CustomerReviews {...base} />));
    for (const name of NAMES) expect(await title(name)).toBeTruthy();
    expect((await screen.findAllByText('Held')).length).toBeGreaterThan(1);
    expect(await screen.findByText('About their review')).toBeTruthy();
    expect(await screen.findByText('Abusive')).toBeTruthy();
    expect(screen.getByRole('img', { name: '4 out of 5' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('the chicken was dry');
  });

  it('shows times in the admin’s zone, whichever Market it is', async () => {
    route();
    const { unmount } = render(wrap(<CustomerReviews {...base} />));
    // 14:30 UTC on the 10th is 00:30 on the 11th in Brisbane (AEST).
    expect((await screen.findAllByText(/11 Nov 2026.*AEST/)).length).toBeGreaterThan(0);
    unmount();
    render(wrap(<CustomerReviews {...base} marketId="NZ" zone="Pacific/Auckland" />));
    // 03:30 on the 11th in Auckland (NZDT, daylight saving).
    expect((await screen.findAllByText(/11 Nov 2026.*(NZDT|GMT\+13)/)).length).toBeGreaterThan(0);
  });

  it('says so when a customer has none of these', async () => {
    route({
      reviews: ok(page([])),
      'seller-ratings': ok(page([])),
      'helpful-votes': ok(page([])),
      'review-reports': ok(page([])),
    });
    render(wrap(<CustomerReviews {...base} />));
    expect(await screen.findByText('This customer has not written a review.')).toBeTruthy();
    expect(await screen.findByText('This customer has not rated a seller.')).toBeTruthy();
    expect(await screen.findByText('This customer has not voted on a review.')).toBeTruthy();
    expect(await screen.findByText('No review reports.')).toBeTruthy();
  });

  it('keeps a failed section inside itself, with Retry, and the others working', async () => {
    route({ 'helpful-votes': refused(503, 'access.unavailable') });
    render(wrap(<CustomerReviews {...base} />));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(await title('Reviews written')).toBeTruthy();
    expect((await screen.findAllByText('Held')).length).toBeGreaterThan(1);
    route();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  });

  it('hides a section the API refuses (403), and only that one', async () => {
    route({ 'seller-ratings': refused(403, 'access.denied') });
    render(wrap(<CustomerReviews {...base} />));
    await title('Reviews written');
    await title('Review reports');
    await waitFor(() => expect(noTitle('Seller ratings given')).toBeNull());
  });

  it('shows nothing at all without the reviews key', () => {
    route();
    render(wrap(<CustomerReviews {...base} keys={new Set()} />));
    expect(noTitle('Reviews written')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('filters the reviews by status with the views bar', async () => {
    route();
    render(wrap(<CustomerReviews {...base} />));
    const card = (await title('Reviews written')).closest('section')!;
    await within(card).findByRole('table', {}, { timeout: 5000 });
    fireEvent.click(within(card).getByRole('button', { name: 'Held' }));
    await waitFor(() =>
      expect(
        call.mock.calls.some(
          (entry) =>
            entry[1].endsWith('/reviews') &&
            JSON.stringify((entry[2] as { filters?: unknown }).filters) ===
              JSON.stringify({ status: ['held'] }),
        ),
      ).toBe(true),
    );
  });

  it('links to the moderation queue only for an admin who may open it', async () => {
    route();
    const { unmount } = render(wrap(<CustomerReviews {...base} />));
    const card = (await title('Reviews written')).closest('section')!;
    await within(card).findByRole('table', {}, { timeout: 5000 });
    const link = screen.getByRole('link', { name: 'Open moderation queue' });
    expect(link.getAttribute('href')).toBe('/reviews/moderation');
    expect(within(card).queryByRole('button', { name: /Actions for/ })).toBeNull();
    unmount();
    cleanup();
    render(wrap(<CustomerReviews {...base} keys={new Set([REVIEWS_VIEW])} />));
    const plain = (await title('Reviews written')).closest('section')!;
    await within(plain).findByRole('table');
    expect(screen.queryByRole('link', { name: 'Open moderation queue' })).toBeNull();
  });

  it('shows a loading skeleton in each list before its answer', () => {
    call.mockImplementation(() => new Promise(() => undefined));
    render(wrap(<CustomerReviews {...base} />));
    for (const name of [
      'Reviews written',
      'Seller ratings given',
      'Helpful votes cast',
      'Review reports',
    ]) {
      expect(screen.getByText(new RegExp(`^Loading ${name}`))).toBeTruthy();
    }
  });
});

describe('the Reviews tab export', () => {
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
        const name = path.slice(`customers/admin/customers/${ID}/`.length);
        const answers: Record<string, unknown> = {
          reviews: page([review]),
          'seller-ratings': page([rating]),
          'helpful-votes': page([vote]),
          'review-reports': page([report]),
        };
        return Promise.resolve(ok(answers[name]) as ApiResult<never>);
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
          <CustomerReviews
            {...base}
            keys={new Set([REVIEWS_VIEW, 'customers.customers.export'])}
          />,
        ),
      );
      const card = (await title('Review reports')).closest('section')!;
      await within(card).findByRole('table', {}, { timeout: 5000 });
      fireEvent.click(within(card).getByRole('button', { name: 'Export…' }));
      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Export review reports' },
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
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/customers/admin/customers/${ID}/review-reports/export`);
      expect(JSON.parse(init.body as string)).toEqual({ format: 'csv', direction: 'desc' });
      expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(init.body);
      expect(createObjectURL).toHaveBeenCalledOnce();
    },
  );

  it('says how many rows can be exported when the filter is too large', async () => {
    route();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
            { status: 422 },
          ),
        ),
    );
    render(
      wrap(
        <CustomerReviews {...base} keys={new Set([REVIEWS_VIEW, 'customers.customers.export'])} />,
      ),
    );
    const card = (await title('Reviews written')).closest('section')!;
    await within(card).findByRole('table', {}, { timeout: 5000 });
    fireEvent.click(within(card).getByRole('button', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export reviews' }, { timeout: 5000 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Up to 10,000 rows can be exported at once/)).toBeTruthy();
  });
});

describe('opening the Reviews tab', () => {
  it('is not audited with tab-opened', async () => {
    const overview = {
      accountId: ID,
      email: 'sara@example.com',
      displayName: 'Sara Ahmadi',
      status: 'active',
      emailVerified: true,
      signedUpAt: '2026-10-01T02:30:00.000Z',
      lastOrderAt: null,
      orderCount: 0,
      spentMinor: '0',
      currency: 'AUD',
      refundCount: 0,
      firstOrderAt: null,
      refundedMinor: '0',
    };
    route();
    const inner = call.getMockImplementation()!;
    call.mockImplementation((method, path, body, csrf) =>
      path === `customers/admin/customers/${ID}`
        ? Promise.resolve(ok(overview) as ApiResult<never>)
        : inner(method, path, body, csrf),
    );
    render(
      wrap(
        <CustomerPage
          accountId={ID}
          adminAccountId="admin-1"
          marketId="AU"
          initialTab="reviews"
          csrfToken="csrf"
          zone="Australia/Brisbane"
          paging="pages"
          waitingPeriodDays={30}
          permissionKeys={[...base.keys, 'customers.customers.view']}
        />,
      ),
    );
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    await title('Reviews written');
    expect(call.mock.calls.some((args) => String(args[1]).endsWith('/tab-opened'))).toBe(false);
  });
});
