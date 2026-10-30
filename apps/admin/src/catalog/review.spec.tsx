// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { reviewProblemOf } from './review-errors.ts';
import { ReviewQueue } from './review-queue.tsx';
import type { ReviewRow } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000c1';
const assign = vi.fn();
const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  kind: 'offer-first-publication',
  offerId: ID,
  version: 3,
  sellerId: '0190a000-0000-7000-8000-0000000000f1',
  productId: '0190a000-0000-7000-8000-0000000000d1',
  product: { productCode: 'P1', typeCode: 'grocery', name: 'Olive oil' },
  sellerSku: 'OIL-1',
  conditionCode: 'new',
  description: { 'en-AU': 'Cold pressed', ar: '' },
  handling: 'SEALED_ORIGINAL',
  submittedAt: '2026-10-14T01:00:00.000Z',
  ...over,
});

function mount(canDecide = true, rows: ReviewRow[] = [row()]) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewQueue rows={rows} canDecide={canDecide} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const fail = (status: number, code: string) =>
  call.mockResolvedValueOnce({ ok: false, failure: { status, code } });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

describe('ReviewQueue', () => {
  it('shows the empty state', () => {
    mount(true, []);
    expect(screen.getByText('No offers are waiting for review.')).toBeTruthy();
  });

  it('opens a card to show the seller texts, without a table', () => {
    const { container } = mount();
    expect(screen.queryByText('Cold pressed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Cold pressed')).toBeTruthy();
    expect(container.querySelector('table')).toBeNull();
  });

  it('approves with the version the reviewer saw, and the card leaves', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/offers/${ID}/approve`,
        { version: 3 },
        'csrf-1',
      ),
    );
    await expectToast('Offer approved and published.');
    expect(screen.queryByText('Olive oil')).toBeNull();
  });

  it('needs a reason to send back, then sends it with the version', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    const submit = screen.getByRole('button', { name: 'Send back to seller' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'handling-unclear' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/offers/${ID}/request-changes`,
        { version: 3, reasonCode: 'handling-unclear' },
        'csrf-1',
      ),
    );
    await expectToast(/Offer sent back/);
  });

  it('keeps the card on a stale answer and drops it when no longer pending', async () => {
    fail(409, 'conflict.stale');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(await screen.findByText(/changed the offer meanwhile/)).toBeTruthy();
    expect(screen.getByText('Olive oil')).toBeTruthy();
    fail(409, 'offer.not-pending-review');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(screen.queryByText('Olive oil')).toBeNull());
  });

  it('is view only without the decide permission', () => {
    mount(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText(/view this queue but not decide/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    fail(401, 'session.invalid');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('reviewProblemOf and nav', () => {
  it('maps codes to message keys', () => {
    expect(reviewProblemOf({ status: 409, code: 'offer.not-pending-review' })).toEqual({
      key: 'catalog.review.error.gone',
      gone: true,
    });
    expect(reviewProblemOf({ status: 422, code: 'claim-text.refused' }).key).toBe(
      'catalog.review.error.claim-text',
    );
    expect(reviewProblemOf({ status: 0, code: 'network' }).key).toBe(
      'catalog.review.error.unavailable',
    );
  });
  it('shows the nav item only with catalog.product.view', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids(['catalog.product.view'])).toContain('offer-reviews');
    expect(ids([])).not.toContain('offer-reviews');
  });
});
