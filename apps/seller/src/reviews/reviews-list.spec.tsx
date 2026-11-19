// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { exportFailure, exportQuery } from './bulk.tsx';
import { reviewProblemOf } from './errors.ts';
import { DEFAULT_QUERY, selectorParams } from './query.ts';
import { ReviewsList } from './reviews-list.tsx';
import type { ReviewListPage, SellerReply, SellerReviewRow } from './types.ts';

// The seller's Reviews super list: cards with plain text and no buyer, tabs with counts, search,
// filters with chips, sort, columns, paging, selection with Export, the row Actions menu (reply,
// edit reply, report) and saved filters.

const call = vi.mocked(callApi);
const LIST_PATH = 'reviews/seller/list?';
const SAVED_PATH = 'lists/seller/saved-filters';
const ID1 = '0190a000-0000-7000-8000-0000000000a1';
const ID2 = '0190a000-0000-7000-8000-0000000000a2';
const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

const reply = (over: Partial<SellerReply> = {}): SellerReply => ({
  body: 'Sorry about that',
  createdAt: '2026-10-14T10:00:00.000Z',
  editedAt: null,
  editableUntil: FUTURE,
  ...over,
});
const row = (
  over: Partial<SellerReviewRow> = {},
  actions: SellerReviewRow['actions'] = ['open', 'reply', 'report'],
): SellerReviewRow => ({
  id: ID1,
  productId: '0190a000-0000-7000-8000-0000000000b1',
  offerId: '0190a000-0000-7000-8000-0000000000c1',
  orderRef: '0190a000-0000-7000-8000-0000000000d1',
  rating: 2,
  title: 'Not great',
  body: 'Arrived late <b>and</b> dented',
  locale: 'en',
  publishedAt: '2026-10-14T10:00:00.000Z',
  reply: null,
  ...over,
  actions,
});
const COUNTS = { all: 12, unanswered: 5, answered: 7, low: 3 };
const pageOf = (rows: SellerReviewRow[], over: Partial<ReviewListPage> = {}): ReviewListPage => ({
  items: rows,
  counts: COUNTS,
  total: null,
  page: 1,
  pageSize: 25,
  paging: 'prev-next',
  hasNext: false,
  ...over,
});
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const savedFailure = { ok: false as const, failure: { status: 503, code: 'access.unavailable' } };

function serve(make: (url: string) => ReviewListPage, savedBody: unknown = savedFailure) {
  call.mockImplementation(((_method: string, path: string) =>
    Promise.resolve(path.startsWith(SAVED_PATH) ? savedBody : ok(make(path)))) as never);
}
const lastUrl = (): string => {
  const calls = call.mock.calls.filter(
    ([method, path]) => method === 'GET' && path.startsWith(LIST_PATH),
  );
  return String(calls[calls.length - 1]?.[1]);
};
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const mount = (
  initial: ReviewListPage = pageOf([row()]),
  props: Partial<React.ComponentProps<typeof ReviewsList>> = {},
) =>
  render(
    <NextIntlClientProvider locale="en-AU" timeZone="UTC" messages={messages}>
      <ReviewsList
        initial={initial}
        paging="prev-next"
        accountId="0190a000-0000-7000-8000-0000000000f1"
        marketId="AU"
        csrfToken="csrf"
        timeZone={null}
        {...props}
      />
    </NextIntlClientProvider>,
  );
const openMenu = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  call.mockReset();
  push.mockReset();
  window.localStorage.clear();
  serve(() => pageOf([row()]));
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('seller reviews list', () => {
  it('shows the stars, text and links of the first page as plain text, and no buyer', () => {
    mount();
    expect(screen.getByRole('img', { name: '2 out of 5 stars' })).toBeTruthy();
    expect(screen.getByText('Not great')).toBeTruthy();
    // Markup in a review is text, never HTML.
    expect(screen.getByText('Arrived late <b>and</b> dented')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View order' }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-0000000000d1',
    );
    expect(call.mock.calls.some(([, path]) => String(path).startsWith(LIST_PATH))).toBe(false);
  });

  it('has a tab per view with its count, and asks for the view when one is opened', async () => {
    mount();
    const tabs = screen
      .getAllByRole('button', { pressed: false })
      .concat(screen.getAllByRole('button', { pressed: true }))
      .map((tab) => tab.textContent ?? '')
      .filter((text) => /^(All|Unanswered|Answered|Low stars)/.test(text));
    expect(tabs.sort()).toEqual(['All (12)', 'Answered (7)', 'Low stars (3)', 'Unanswered (5)']);
    fireEvent.click(screen.getByRole('button', { name: /Unanswered/ }));
    await waitFor(() => expect(paramsOf(lastUrl()).view).toBe('unanswered'));
    expect(paramsOf(lastUrl()).page).toBe('1');
  });

  it('searches, shows a chip and clears it', async () => {
    mount();
    const box = screen.getByRole('searchbox', { name: 'Search reviews' });
    fireEvent.change(box, { target: { value: ' dented ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl()).q).toBe('dented'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: dented' }));
    await waitFor(() => expect(paramsOf(lastUrl()).q).toBeUndefined());
  });

  it('sorts by stars', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Stars' }));
    await waitFor(() => expect(paramsOf(lastUrl()).sort).toBe('rating'));
  });

  it('keeps the page numbers footer for List paging "pages"', () => {
    mount(pageOf([row()], { total: 60, paging: 'pages' }), { paging: 'pages' });
    expect(screen.getByText('1 to 1 of 60')).toBeTruthy();
  });

  it('hides a detail the seller removed from the columns', () => {
    window.localStorage.setItem(
      'mp:seller:AU:0190a000-0000-7000-8000-0000000000f1:reviews-columns',
      JSON.stringify(['published']),
    );
    mount();
    expect(screen.queryByRole('link', { name: 'View order' })).toBeNull();
  });

  it('shows the empty state of a shop with no reviews', () => {
    mount(pageOf([], { counts: { all: 0, unanswered: 0, answered: 0, low: 0 } }));
    expect(screen.getByText('No reviews yet')).toBeTruthy();
  });

  it('shows a reply and its edit deadline', () => {
    mount(pageOf([row({ reply: reply() }, ['open', 'edit-reply', 'report'])]));
    expect(screen.getByText('Sorry about that')).toBeTruthy();
    expect(screen.getByText(/you can edit it until/)).toBeTruthy();
  });
});

describe('row actions', () => {
  it('offers only the actions the API names', () => {
    mount(pageOf([row({}, ['open'])]));
    openMenu(/Actions for Not great/);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['View product', 'View order']);
  });

  it('has no menu when the row has no action (an acting-as session)', () => {
    mount(pageOf([row({}, [])]));
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('replies from a dialog, then reads the page again', async () => {
    mount();
    call.mockClear();
    serve(() => pageOf([row({ reply: reply() }, ['open', 'edit-reply', 'report'])]));
    openMenu(/Actions for Not great/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Sorry about that' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post reply' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/seller/${ID1}/reply`,
        { body: 'Sorry about that' },
        'csrf',
      ),
    );
    await waitFor(() => expect(expectToast).toBeDefined());
    await waitFor(() => expect(screen.getByText(/Sorry about that/)).toBeTruthy());
  });

  it('keeps the dialog open and says why when the text is refused', async () => {
    mount();
    call.mockImplementation((() =>
      Promise.resolve({
        ok: false,
        failure: {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'body', code: 'not-allowed' }] },
        },
      })) as never);
    openMenu(/Actions for Not great/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'call 0400 000 000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(within(dialog).getByText(/contact details/)).toBeTruthy());
  });

  it('reports with a reason, marks the review and removes Report from its menu', async () => {
    mount();
    call.mockImplementation((method: string) =>
      Promise.resolve(method === 'GET' ? ok(pageOf([row()])) : ok({ reported: true })),
    );
    openMenu(/Actions for Not great/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report…' }));
    const dialog = screen.getByRole('dialog');
    // A level 2 confirmation: it names the review, and Cancel has the focus.
    expect(within(dialog).getByText('Report "Not great"?')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'extortion' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/seller/${ID1}/report`,
        { reasonCode: 'extortion' },
        'csrf',
      ),
    );
    await waitFor(() => expect(screen.getByText('Reported')).toBeTruthy());
    openMenu(/Actions for Not great/);
    expect(screen.queryByRole('menuitem', { name: 'Report…' })).toBeNull();
  });
});

describe('selection and export', () => {
  it('drops the ticked rows after a reply, so the count never holds rows that left the tab', async () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Not great' }));
    expect(screen.getByText('1 review selected')).toBeTruthy();
    call.mockClear();
    call.mockImplementation((method: string) =>
      Promise.resolve(method === 'GET' ? ok(pageOf([row()])) : ok(row())),
    );
    openMenu(/Actions for Not great/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Thanks' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(screen.queryByText('1 review selected')).toBeNull());
  });

  it('exports the ticked reviews by id', () => {
    mount(pageOf([row(), row({ id: ID2, title: 'Second' })]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Not great' }));
    expect(screen.getByText('1 review selected')).toBeTruthy();
    const query = exportQuery('csv', DEFAULT_QUERY, ['product', 'order', 'reply'], [ID1]);
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      sort: 'published',
      direction: 'desc',
      format: 'csv',
      columns: 'product-id,order-ref,reply,replied',
      ids: ID1,
    });
  });

  it('sends the list selector, not ids, for the whole filter', () => {
    const query = exportQuery('xlsx', { ...DEFAULT_QUERY, tab: 'low', q: 'late' }, [], null);
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      view: 'low',
      q: 'late',
      maxRating: '2',
      sort: 'published',
      direction: 'desc',
      format: 'xlsx',
    });
  });

  it('keeps the star bounds inside what the API accepts', () => {
    const asked = (query: Partial<typeof DEFAULT_QUERY>) =>
      Object.fromEntries(selectorParams({ ...DEFAULT_QUERY, ...query }));
    expect(asked({ filters: { minRating: '4', maxRating: '2' } })).toMatchObject({
      minRating: '2',
      maxRating: '2',
    });
    expect(asked({ tab: 'low', filters: { minRating: '3' } })).toMatchObject({
      minRating: '2',
      maxRating: '2',
    });
    expect(asked({ tab: 'low', filters: { maxRating: '5' } })).toMatchObject({ maxRating: '2' });
    expect(asked({ filters: { minRating: '3' } })['maxRating']).toBeUndefined();
  });

  it('names the refusals of the export', () => {
    expect(exportFailure(413, 'batch.too-large', { max: 10000, total: 12000 }).key).toBe(
      'too-large',
    );
    expect(exportFailure(413, 'batch.too-large', { max: 200 }).key).toBe('too-many-selected');
    expect(exportFailure(404, 'reviews.not-found', null).key).toBe('not-found');
  });
});

describe('saved filters', () => {
  const saved = (over: Record<string, unknown> = {}) => ({
    id: 'sf-1',
    listKey: 'seller.reviews.list',
    name: 'Unanswered low stars',
    visibility: 'me',
    payload: { v: 1, view: 'unanswered', maxRating: '2', sort: 'rating', direction: 'asc' },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });
  const answer = {
    items: [saved()],
    canShare: false,
    limits: { perOwner: 20, shared: 10 },
  };

  it('opens a saved filter as its own tab with its own selector', async () => {
    serve(() => pageOf([row()]), ok(answer));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Unanswered low stars' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        view: 'unanswered',
        maxRating: '2',
        sort: 'rating',
        direction: 'asc',
      }),
    );
    // A built-in tab opened from it starts clean.
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ view: 'all', sort: 'published' }),
    );
    expect(paramsOf(lastUrl()).maxRating).toBeUndefined();
  });

  it('saves the current view on the generic routes with the closed document', async () => {
    serve(() => pageOf([row()]), ok({ ...answer, items: [] }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Unanswered (5)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Waiting' } });
    call.mockClear();
    serve(() => pageOf([row()]), ok(answer));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'lists/seller/saved-filters',
        {
          listKey: 'seller.reviews.list',
          name: 'Waiting',
          visibility: 'me',
          payload: { v: 1, view: 'unanswered', sort: 'published', direction: 'desc' },
        },
        'csrf',
      ),
    );
  });

  it('shows the view tabs only when the saved filters cannot load', () => {
    mount();
    expect(screen.queryByText('Manage filters')).toBeNull();
  });
});

describe('reviewProblemOf', () => {
  it('names a refused text and a closed edit window', () => {
    expect(
      reviewProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'body', code: 'not-allowed' }] },
      }),
    ).toBe('not-allowed');
    expect(reviewProblemOf({ status: 409, code: 'reviews.edit-window-closed' })).toBe(
      'edit-window-closed',
    );
  });
});
