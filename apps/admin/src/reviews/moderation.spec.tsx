// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { ModerationQueue } from './moderation-queue.tsx';
import { REASONS, type QueuePage, type ReviewDetail, type ReviewRow } from './types.ts';

const call = vi.mocked(callApi);
const REVIEW = '0190a000-0000-7000-8000-0000000000a1';
const PRODUCT = '0190a000-0000-7000-8000-0000000000b1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
  </NextIntlClientProvider>
);
const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  id: REVIEW,
  productId: PRODUCT,
  offerId: '0190a000-0000-7000-8000-0000000000d1',
  sellerId: SELLER,
  rating: 1,
  title: 'Awful',
  body: 'Not what I ordered',
  locale: 'en-AU',
  status: 'held',
  createdAt: '2026-10-30T01:00:00.000Z',
  editedAt: null,
  openReports: 0,
  signalCodes: ['profanity'],
  ...over,
});
const counts = { held: 2, reported: 1, actioned: 0 };
const queue = (items: ReviewRow[], nextCursor: string | null = null, tab = 'held') => ({
  ok: true as const,
  status: 200,
  body: { tab, items, nextCursor, counts } as QueuePage,
});
const detail = (over: Partial<ReviewDetail> = {}) => ({
  ok: true as const,
  status: 200,
  body: {
    ...row(),
    reportReasons: [{ reasonCode: 'abusive', count: 2 }],
    history: [
      {
        action: 'auto-hold',
        reasonCode: 'auto-check',
        fromStatus: null,
        toStatus: 'held',
        byModerator: false,
        at: '2026-10-30T01:00:00.000Z',
      },
    ],
    allowedActions: ['publish', 'hide', 'remove', 'dismiss-reports'],
    ...over,
  },
});
const mount = (canModerate = true, canRemove = true) =>
  render(
    wrap(<ModerationQueue canModerate={canModerate} canRemove={canRemove} csrfToken="csrf-1" />),
  );

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the buyer review queue', () => {
  it('lists held reviews with their flags and counts per tab, and reads the other tab on click', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount();
    expect(await screen.findByRole('button', { name: /Awful - Not what I ordered/ })).toBeTruthy();
    expect(screen.getByText('Blocked word')).toBeTruthy();
    expect(screen.getByRole('img', { name: '1 out of 5' })).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'reviews/admin/moderation?tab=held&limit=25');
    call.mockResolvedValueOnce(queue([], null, 'reported'));
    fireEvent.click(screen.getByRole('button', { name: /Reported/ }));
    expect(await screen.findByText('No review has an open report.')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'reviews/admin/moderation?tab=reported&limit=25');
  });

  it('pages with the cursor and shows an error with a retry', async () => {
    call.mockResolvedValueOnce(queue([row()], 'cursor-1'));
    mount();
    await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(
      queue([row({ id: '0190a000-0000-7000-8000-0000000000a2', title: 'Second' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /Second/ })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'reviews/admin/moderation?tab=held&limit=25&cursor=cursor-1',
    );
  });

  it('shows a load error and loads again on retry', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'unknown' } });
    mount();
    expect(await screen.findByText('The reviews could not be loaded. Try again.')).toBeTruthy();
    call.mockResolvedValueOnce(queue([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Awful/ })).toBeTruthy();
  });

  it('opens a review with its reports and history, and hides it with a reason after a two-step code', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount();
    const opener = await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(detail());
    fireEvent.click(opener);
    expect(await screen.findByText('Not what I ordered')).toBeTruthy();
    expect(screen.getByText('Abusive (2)')).toBeTruthy();
    expect(screen.getByText(/Held for review by the system or the buyer/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'hide' } });
    const reasons = within(screen.getByLabelText('Reason')).getAllByRole('option');
    expect(reasons.map((o) => o.getAttribute('value'))).toEqual(['', ...REASONS.hide]);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'spam' } });
    // The first answer asks for the code; the step-up dialog repeats the request once verified.
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 403,
        code: 'second-factor.required',
        details: { actionKey: 'reviews.review.moderate' },
      },
    });
    call.mockResolvedValueOnce(detail({ status: 'hidden', allowedActions: ['restore', 'remove'] }));
    call.mockResolvedValueOnce(queue([row({ status: 'hidden' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/admin/moderation/${REVIEW}/hide`,
        { reasonCode: 'spam' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Confirm it is you/)).toBeTruthy();
  });

  it('applies an action that needs no code and shows the review as it is now', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount();
    const opener = await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(detail());
    fireEvent.click(opener);
    await screen.findByText('Not what I ordered');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'dismiss-reports' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'duplicate' } });
    call.mockResolvedValueOnce(detail({ reportReasons: [], allowedActions: ['publish', 'hide'] }));
    call.mockResolvedValueOnce(queue([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss reports' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/admin/moderation/${REVIEW}/dismiss-reports`,
        { reasonCode: 'duplicate' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('None', { selector: 'dd' })).toBeTruthy();
  });

  it('shows what changed when another moderator moved the review first', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount();
    const opener = await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(detail());
    fireEvent.click(opener);
    await screen.findByText('Not what I ordered');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'publish' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'checked-ok' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'reviews.not-moderatable' },
    });
    call.mockResolvedValueOnce(detail({ status: 'hidden', allowedActions: ['restore'] }));
    call.mockResolvedValueOnce(queue([]));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByText(
        'Another moderator changed this review first. It is shown as it is now.',
      ),
    ).toBeTruthy();
  });

  it('offers only the actions the person may take: no remove without the remove permission', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount(true, false);
    const opener = await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(detail());
    fireEvent.click(opener);
    await screen.findByText('Not what I ordered');
    const options = within(screen.getByLabelText('Action'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'publish', 'hide', 'dismiss-reports']);
  });

  it('offers no action to someone who can only view', async () => {
    call.mockResolvedValueOnce(queue([row()]));
    mount(false, false);
    const opener = await screen.findByRole('button', { name: /Awful/ });
    call.mockResolvedValueOnce(detail());
    fireEvent.click(opener);
    expect(await screen.findByText('No action applies to this review now.')).toBeTruthy();
    expect(screen.queryByLabelText('Action')).toBeNull();
  });

  it('has no reason that would hide a review for being negative', () => {
    for (const reasons of Object.values(REASONS)) {
      expect(reasons.some((code) => /negative|seller|complain/.test(code))).toBe(false);
    }
  });
});
