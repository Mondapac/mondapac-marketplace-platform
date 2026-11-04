// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { accountOrderOf } from '../src/account/live-orders.ts';
import { AccountReviews } from '../src/account/reviews.tsx';
import { ProductReviews } from '../src/reviews/product-reviews.tsx';
import { reviewsPageOf } from '../src/reviews/reviews-model.ts';
import { ReviewForm } from '../src/reviews/review-form.tsx';
import { SellerRatingForm } from '../src/reviews/seller-rating-form.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { loadAccount } from '../src/storefront/source.ts';
import type { AccountOrder } from '../src/storefront/types.ts';

// The buyer's review pages: the product page's summary and list, the review and seller-rating
// forms and the account's reviews page, against a faked API. Nothing here reaches a network.

vi.mock('next/navigation', () => ({
  usePathname: () => '/account/reviews',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const PRODUCT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const SELLER_ORDER = '11111111-2222-4333-8444-555555555555';
const REVIEW_A = 'aaaaaaaa-2222-4333-8444-555555555555';
const REVIEW_B = 'bbbbbbbb-2222-4333-8444-555555555555';

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer>;
let calls: { method: string; path: string; body: unknown }[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({
    method,
    path,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const { status, body } = answers[`${method} ${path}`] ?? { status: 404, body: {} };
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

const publicReview = (id: string, extra: object = {}) => ({
  id,
  rating: 5,
  title: 'Fresh',
  body: 'Arrived cold.',
  locale: 'en',
  author: { kind: 'named', name: 'Sara K.' },
  boughtFrom: { offerId: OFFER, sellerId: SELLER },
  publishedOn: '2026-10-12',
  editedOn: null,
  ...extra,
});
const own = (extra: object = {}) => ({
  id: REVIEW_A,
  productId: PRODUCT,
  offerId: OFFER,
  sellerId: SELLER,
  rating: 4,
  title: 'Good',
  body: 'Would buy again.',
  locale: 'en',
  anonymous: false,
  status: 'published',
  createdAt: '2026-10-12T00:00:00.000Z',
  editedAt: null,
  publishedAt: '2026-10-12T00:00:00.000Z',
  lastPurchaseAt: '2026-10-01T00:00:00.000Z',
  editableUntil: '2099-01-01T00:00:00.000Z',
  ...extra,
});
const SUMMARY = { count: 3, averageTimes100: 433, histogram: [0, 1, 0, 1, 1], shown: true };

function intl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  calls = [];
  answers = {};
  forgetCsrfToken();
  vi.stubGlobal('fetch', fetchMock);
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('product page reviews', () => {
  const initial = reviewsPageOf({
    reviews: [
      publicReview(REVIEW_A),
      publicReview(REVIEW_B, { author: { kind: 'verified-buyer' }, rating: 2, title: 'Torn' }),
    ],
    nextCursor: REVIEW_B,
  })!;
  const draw = () =>
    render(
      intl(
        <ProductReviews
          productId={PRODUCT}
          summary={SUMMARY as never}
          initial={initial}
          sellers={{ [SELLER]: 'Tehran Grocer' }}
        />,
      ),
    );

  it('shows the average with one decimal, the count, the name and the Bought from label', () => {
    draw();
    expect(screen.getByText('4.3')).toBeTruthy();
    expect(screen.getByText('3 reviews')).toBeTruthy();
    expect(screen.getByText('Sara K.')).toBeTruthy();
    expect(screen.getAllByText('Verified buyer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bought from Tehran Grocer')).toHaveLength(2);
    expect(screen.getAllByText('Verified purchase')).toHaveLength(2);
  });

  it('shows review text as plain text, never as markup', () => {
    render(
      intl(
        <ProductReviews
          productId={PRODUCT}
          summary={SUMMARY as never}
          initial={reviewsPageOf({
            reviews: [publicReview(REVIEW_A, { body: '<img src=x onerror=alert(1)>' })],
            nextCursor: null,
          })!}
          sellers={{}}
        />,
      ),
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('filters by stars through the site route and goes back to the first page on "all"', async () => {
    answers[`GET product-reviews/${PRODUCT}?stars=2`] = {
      status: 200,
      body: {
        reviews: [publicReview(REVIEW_B, { rating: 2, title: 'Torn bag' })],
        nextCursor: null,
      },
    };
    draw();
    fireEvent.click(screen.getByRole('button', { name: '2 stars: 1 review' }));
    expect(await screen.findByText('Torn bag')).toBeTruthy();
    expect(screen.queryByText('Fresh')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show more reviews' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all reviews' }));
    expect(await screen.findByText('Fresh')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('adds the next page with its cursor', async () => {
    answers[`GET product-reviews/${PRODUCT}?cursor=${REVIEW_B}`] = {
      status: 200,
      body: {
        reviews: [publicReview('cccccccc-2222-4333-8444-555555555555', { title: 'Older one' })],
        nextCursor: null,
      },
    };
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Show more reviews' }));
    expect(await screen.findByText('Older one')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more reviews' })).toBeNull();
  });

  it('says so when a page cannot be loaded and keeps what is shown', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Show more reviews' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load/);
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});

describe('review form', () => {
  it('needs a rating before anything is sent', async () => {
    render(
      intl(
        <ReviewForm
          productId={PRODUCT}
          productName="Lamb mince"
          onSaved={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Choose a rating/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('sends the rating, text and the anonymous choice, and says a held review is being checked', async () => {
    answers['GET identity/customer/session'] = {
      status: 200,
      body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
    };
    answers['POST reviews/products'] = {
      status: 201,
      body: { outcome: 'created', review: own({ status: 'held', rating: 5 }) },
    };
    const saved = vi.fn();
    render(
      intl(
        <ReviewForm
          productId={PRODUCT}
          productName="Lamb mince"
          onSaved={saved}
          onCancel={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.change(screen.getByLabelText('Title (optional)'), { target: { value: ' Great ' } });
    fireEvent.change(screen.getByLabelText('Your review (optional)'), {
      target: { value: 'Tender.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Verified buyer/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST' && c.path === 'reviews/products');
    expect(post?.body).toEqual({
      productId: PRODUCT,
      rating: 5,
      title: 'Great',
      body: 'Tender.',
      anonymous: true,
    });
    expect((await screen.findByRole('status')).textContent).toMatch(/being checked/);
  });

  it('leaves empty text out of a new review and explains a closed window', async () => {
    answers['GET identity/customer/session'] = {
      status: 200,
      body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
    };
    answers['POST reviews/products'] = {
      status: 409,
      body: { statusCode: 409, code: 'reviews.window-closed' },
    };
    render(
      intl(
        <ReviewForm
          productId={PRODUCT}
          productName="Lamb mince"
          onSaved={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /time to review this order has ended/,
    );
    expect(calls.find((c) => c.path === 'reviews/products')?.body).toEqual({
      productId: PRODUCT,
      rating: 3,
      anonymous: false,
    });
  });
});

describe('seller rating form', () => {
  it('asks every question, then sends the answers and the reason only when it did not arrive well', async () => {
    answers['GET identity/customer/session'] = {
      status: 200,
      body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
    };
    answers[`POST reviews/seller-orders/${SELLER_ORDER}/rating`] = { status: 201, body: {} };
    const saved = vi.fn();
    render(
      intl(
        <SellerRatingForm
          sellerOrderId={SELLER_ORDER}
          sellerName="Halal Corner"
          onSaved={saved}
          onCancel={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit rating' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);

    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    const asDescribed = screen.getByRole('group', { name: 'Was the order as described?' });
    fireEvent.click(within(asDescribed).getByRole('radio', { name: 'Yes' }));
    const arrived = screen.getByRole('group', {
      name: 'Did it arrive complete and in good shape?',
    });
    fireEvent.click(within(arrived).getByRole('radio', { name: 'No' }));
    fireEvent.change(screen.getByLabelText('What went wrong? (optional)'), {
      target: { value: 'damaged' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit rating' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(calls.find((c) => c.path.endsWith('/rating'))?.body).toEqual({
      satisfaction: 4,
      asDescribed: true,
      arrivedOk: false,
      reasonCode: 'damaged',
    });
  });
});

describe('account reviews page', () => {
  const aud = (amount: string) => ({ amount, currency: 'AUD' });
  const order = accountOrderOf(
    {
      orderId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      status: 'confirmed',
      confirmedAt: '2026-10-20T23:30:00.000Z',
      tax: aud('341'),
      sellerNotes: {},
      sellerOrders: [
        {
          sellerId: SELLER,
          storeName: 'Halal Corner',
          fulfilment: 'delivered',
          deliveredAt: '2026-10-25T00:00:00.000Z',
          deliveryMethod: 'instant',
          shipping: aud('750'),
          lines: [
            {
              offerId: OFFER,
              variantId: VARIANT,
              quantity: 1,
              unitPrice: aud('1250'),
              productName: 'Lamb mince',
              variantLabel: null,
            },
          ],
        },
      ],
    },
    { unnamedItem: 'Item', unnamedSeller: 'Seller' },
    '',
  ) as AccountOrder;
  const signedIn = {
    status: 200,
    body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
  };

  async function renderPage() {
    const sample = await loadAccount();
    return render(
      intl(
        <StoreProvider live initialLiveCart={null}>
          <main>
            <AccountArea source={{ ...sample, live: true, orders: [order] }}>
              <AccountReviews />
            </AccountArea>
          </main>
        </StoreProvider>,
      ),
    );
  }
  beforeEach(() => {
    answers['GET identity/customer/session'] = signedIn;
    answers['GET customers/me/addresses'] = { status: 200, body: { addresses: [], limit: 10 } };
    answers['GET cart/saved'] = { status: 200, body: { items: [] } };
    answers['GET cart'] = { status: 200, body: { groups: [], lineCount: 0 } };
  });

  it('shows nothing about reviews while the Market switch is off', async () => {
    answers['GET reviews/me/to-review'] = {
      status: 404,
      body: { statusCode: 404, code: 'reviews.disabled' },
    };
    answers['GET reviews/me'] = {
      status: 404,
      body: { statusCode: 404, code: 'reviews.disabled' },
    };
    await renderPage();
    expect(await screen.findByText('Reviews are not open yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write a review' })).toBeNull();
  });

  it("lists what waits for a review by the names of the order, and the buyer's own reviews", async () => {
    answers['GET reviews/me/to-review'] = {
      status: 200,
      body: {
        products: [
          {
            productId: PRODUCT,
            offerId: OFFER,
            sellerId: SELLER,
            sellerOrderId: SELLER_ORDER,
            deliveredAt: '2026-10-25T00:00:00.000Z',
            windowEndsAt: '2026-12-24T00:00:00.000Z',
          },
        ],
        sellerOrders: [
          {
            sellerOrderId: SELLER_ORDER,
            sellerId: SELLER,
            deliveredAt: '2026-10-25T00:00:00.000Z',
            windowEndsAt: '2026-12-24T00:00:00.000Z',
          },
        ],
      },
    };
    answers['GET reviews/me'] = {
      status: 200,
      body: {
        reviews: [own(), own({ id: REVIEW_B, status: 'deleted-by-author' })],
        sellerRatings: [],
      },
    };
    await renderPage();
    const waiting = await screen.findByRole('region', { name: 'Waiting for your review' });
    expect(within(waiting).getByText('Lamb mince')).toBeTruthy();
    expect(within(waiting).getByText('Rate your order from Halal Corner')).toBeTruthy();
    const mine = screen.getByRole('region', { name: 'Your reviews' });
    expect(within(mine).getAllByRole('listitem')).toHaveLength(1);
    expect(within(mine).getByText('Would buy again.')).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it("deletes the buyer's own review after a confirmation", async () => {
    answers['GET reviews/me/to-review'] = { status: 200, body: { products: [], sellerOrders: [] } };
    answers['GET reviews/me'] = { status: 200, body: { reviews: [own()], sellerRatings: [] } };
    answers[`DELETE reviews/products/${REVIEW_A}`] = {
      status: 200,
      body: { id: REVIEW_A, status: 'deleted-by-author' },
    };
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete review' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});
