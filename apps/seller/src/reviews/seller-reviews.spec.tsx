// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { visibleNavItems } from '@mondapac/ui';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { reviewProblemOf } from './errors.ts';
import { SellerReviews } from './seller-reviews.tsx';
import type { SellerReply, SellerReview, SellerReviewPage } from './types.ts';

// The seller's reviews page: stars and text as plain text, the order link as the only way to the
// buyer, one public reply (a form, then the reply with its edit deadline), a report with a closed
// list of reasons, and "Show more" by cursor.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const reply = (over: Partial<SellerReply> = {}): SellerReply => ({
  body: 'Sorry about that',
  createdAt: '2026-10-14T10:00:00.000Z',
  editedAt: null,
  editableUntil: FUTURE,
  ...over,
});
const review = (over: Partial<SellerReview> = {}): SellerReview => ({
  id: '0190a000-0000-7000-8000-0000000000a1',
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
});
const page = (items: SellerReview[], nextCursor: string | null = null): SellerReviewPage => ({
  items,
  nextCursor,
});
const mount = (initial = page([review()]), { canReply = true, canReport = true } = {}) =>
  render(
    wrap(
      <SellerReviews
        initial={initial}
        csrfToken="csrf"
        canReply={canReply}
        canReport={canReport}
      />,
    ),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SellerReviews', () => {
  it('shows stars, title and text as plain text, with the product and order links', () => {
    mount();
    expect(screen.getByRole('img', { name: '2 out of 5 stars' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Not great' })).toBeTruthy();
    // Markup in a buyer's text is shown as characters, never rendered.
    expect(screen.getByText('Arrived late <b>and</b> dented')).toBeTruthy();
    expect(document.querySelector('article b')).toBeNull();
    expect(screen.getByRole('link', { name: 'View order' }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-0000000000d1',
    );
    expect(screen.getByRole('link', { name: 'View product' }).getAttribute('href')).toBe(
      '/products/0190a000-0000-7000-8000-0000000000b1',
    );
  });

  it('says so for a rating without text, and when there is no review at all', () => {
    mount(page([review({ title: null, body: null })]));
    expect(screen.getByText('The customer left a rating without a text.')).toBeTruthy();
    cleanup();
    mount(page([]));
    expect(screen.getByRole('heading', { name: 'No reviews yet' })).toBeTruthy();
  });

  it('posts a reply once and shows it with its edit deadline', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: review({ reply: reply() }) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Your public reply'), {
      target: { value: 'Sorry about that' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(screen.getByText('Your reply')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'reviews/seller/0190a000-0000-7000-8000-0000000000a1/reply',
      { body: 'Sorry about that' },
      'csrf',
    );
    expect(screen.getByText(/you can edit it until/)).toBeTruthy();
    // One reply per review: no second "Reply" button.
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    await expectToast('Reply posted');
  });

  it('edits a reply inside the window with PATCH, and offers no edit after it', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: review({ reply: reply({ body: 'Fixed', editedAt: '2026-10-15T10:00:00.000Z' }) }),
    });
    mount(page([review({ reply: reply() })]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit reply' }));
    const field = screen.getByLabelText<HTMLTextAreaElement>('Edit your public reply');
    expect(field.value).toBe('Sorry about that');
    fireEvent.change(field, { target: { value: 'Fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Fixed')).toBeTruthy());
    expect(call.mock.calls[0]?.[0]).toBe('PATCH');
    expect(screen.getByText(/edited/)).toBeTruthy();
    cleanup();
    mount(page([review({ reply: reply({ editableUntil: PAST }) })]));
    expect(screen.queryByRole('button', { name: 'Edit reply' })).toBeNull();
    expect(screen.getByText(/can no longer be edited/)).toBeTruthy();
  });

  it('shows the reason a reply was refused and keeps the text', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'validation.failed',
        details: { fields: [{ path: 'body', code: 'not-allowed' }] },
      },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Your public reply'), {
      target: { value: 'Call me on 0400 000 000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(screen.getByText(/contact details, a link/)).toBeTruthy());
    expect(screen.getByLabelText<HTMLTextAreaElement>('Your public reply').value).toBe(
      'Call me on 0400 000 000',
    );
  });

  it('reports a review with a reason from the closed list, once', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { reported: true } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    const reasons = Array.from(
      screen.getByLabelText<HTMLSelectElement>('Reason').options,
      (option) => option.value,
    );
    expect(reasons).toEqual([
      'personal-information',
      'abusive',
      'irrelevant',
      'not-a-purchase',
      'extortion',
    ]);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'extortion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByText('Reported')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'reviews/seller/0190a000-0000-7000-8000-0000000000a1/report',
      { reasonCode: 'extortion' },
      'csrf',
    );
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
    await expectToast('Report sent');
  });

  it('hides the reply and report buttons without their permissions', () => {
    mount(page([review()]), { canReply: false, canReport: false });
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('never offers to hide or remove a review', () => {
    mount();
    expect(screen.queryByRole('button', { name: /hide|remove|delete/i })).toBeNull();
  });

  it('loads the next page by cursor and skips a review it already shows', async () => {
    const second = review({ id: '0190a000-0000-7000-8000-0000000000a2', title: 'Second' });
    call.mockResolvedValue({ ok: true, status: 200, body: page([review(), second]) });
    mount(page([review()], '1760000000000_0190a000-0000-7000-8000-0000000000a1'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'GET',
      'reviews/seller?cursor=1760000000000_0190a000-0000-7000-8000-0000000000a1',
    );
    expect(screen.getAllByRole('heading', { name: 'Not great' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('reviewProblemOf', () => {
  it('maps the API refusals to message keys', () => {
    const failure = (status: number, code: string, fields?: { path: string; code: string }[]) => ({
      status,
      code,
      ...(fields === undefined ? {} : { details: { fields } }),
    });
    expect(reviewProblemOf(failure(409, 'reviews.already-replied'))).toBe('already-replied');
    expect(reviewProblemOf(failure(409, 'reviews.edit-window-closed'))).toBe('edit-window-closed');
    expect(
      reviewProblemOf(failure(422, 'validation.failed', [{ path: 'body', code: 'not-allowed' }])),
    ).toBe('not-allowed');
    expect(
      reviewProblemOf(failure(422, 'validation.failed', [{ path: 'body', code: 'length' }])),
    ).toBe('invalid');
    expect(reviewProblemOf(failure(503, 'x'))).toBe('unavailable');
    expect(reviewProblemOf(failure(418, 'x'))).toBe('unknown');
  });
});

describe('seller nav', () => {
  it('shows Reviews only to a member who may see the shop reviews', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids(['reviews.seller.view'])).toContain('s_reviews');
    expect(ids(['catalog.own-product.view'])).not.toContain('s_reviews');
  });
});
