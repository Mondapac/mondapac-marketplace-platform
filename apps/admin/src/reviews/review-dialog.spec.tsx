// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { shortId } from '../shared/short-id.ts';
import { ReviewDialog } from './review-dialog.tsx';
import { REASONS, type Action, type ReviewDetail, type ReviewRow } from './types.ts';

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
const changed = vi.fn();
const mount = (canModerate = true, canRemove = true, initialAction: Action | null = null) =>
  render(
    wrap(
      <ReviewDialog
        reviewId={REVIEW}
        initialAction={initialAction}
        canModerate={canModerate}
        canRemove={canRemove}
        csrfToken="csrf-1"
        onClose={() => {}}
        onChanged={changed}
      />,
    ),
  );

beforeEach(() => {
  call.mockReset();
  changed.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the review dialog', () => {
  it('opens a review with its reports and history, and hides it with a reason after a two-step code', async () => {
    call.mockResolvedValueOnce(detail());
    mount();
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
    call.mockResolvedValueOnce(detail());
    mount();
    await screen.findByText('Not what I ordered');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'dismiss-reports' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'duplicate' } });
    call.mockResolvedValueOnce(detail({ reportReasons: [], allowedActions: ['publish', 'hide'] }));
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
    call.mockResolvedValueOnce(detail());
    mount();
    await screen.findByText('Not what I ordered');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'publish' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'checked-ok' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'reviews.not-moderatable' },
    });
    call.mockResolvedValueOnce(detail({ status: 'hidden', allowedActions: ['restore'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByText(
        'Another moderator changed this review first. It is shown as it is now.',
      ),
    ).toBeTruthy();
  });

  it('offers only the actions the person may take: no remove without the remove permission', async () => {
    call.mockResolvedValueOnce(detail());
    mount(true, false);
    await screen.findByText('Not what I ordered');
    const options = within(screen.getByLabelText('Action'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'publish', 'hide', 'dismiss-reports']);
  });

  it('offers no action to someone who can only view', async () => {
    call.mockResolvedValueOnce(detail());
    mount(false, false);
    expect(await screen.findByText('No action applies to this review now.')).toBeTruthy();
    expect(screen.queryByLabelText('Action')).toBeNull();
  });

  it('starts with the action the row menu chose, when the review still allows it', async () => {
    call.mockResolvedValueOnce(detail());
    mount(true, true, 'hide');
    await screen.findByText('Not what I ordered');
    expect(screen.getByLabelText<HTMLSelectElement>('Action').value).toBe('hide');
    expect(screen.getByLabelText('Reason')).toBeTruthy();
  });

  it('starts with no action when the chosen one no longer applies', async () => {
    call.mockResolvedValueOnce(detail({ status: 'hidden', allowedActions: ['restore', 'remove'] }));
    mount(true, true, 'hide');
    await screen.findByText('Not what I ordered');
    expect(screen.getByLabelText<HTMLSelectElement>('Action').value).toBe('');
  });

  it('removes only after the short id is typed (it cannot be undone)', async () => {
    call.mockResolvedValueOnce(detail());
    mount(true, true, 'remove');
    await screen.findByText('Not what I ordered');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'illegal' } });
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' });
    expect(remove.disabled).toBe(true);
    const box = screen.getByLabelText(`Type ${shortId(REVIEW)} to remove this review`);
    fireEvent.change(box, { target: { value: 'wrong' } });
    expect(remove.disabled).toBe(true);
    fireEvent.change(box, { target: { value: ` ${shortId(REVIEW).toUpperCase()} ` } });
    expect(remove.disabled).toBe(false);
    call.mockResolvedValueOnce(detail({ status: 'removed', allowedActions: [] }));
    fireEvent.click(remove);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/admin/moderation/${REVIEW}/remove`,
        { reasonCode: 'illegal' },
        'csrf-1',
      ),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('has no reason that would hide a review for being negative', () => {
    for (const reasons of Object.values(REASONS)) {
      expect(reasons.some((code) => /negative|seller|complain/.test(code))).toBe(false);
    }
  });
});
