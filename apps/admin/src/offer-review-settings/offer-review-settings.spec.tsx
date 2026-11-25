// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../step-up/step-up.tsx', async () => {
  const api = await import('../api/client.ts');
  return {
    useGuardedCall: () => api.callApi,
    isStepUpCancelled: (result: { ok: boolean; failure?: { code: string } }) =>
      !result.ok && result.failure?.code === 'step-up.cancelled',
  };
});

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { OfferReviewPanel } from './offer-review-panel.tsx';
import { numberValueOf, offerReviewAnswerOf, settingOf, type OfferReviewAnswer } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const row = (code: string, value: string, version = 0, reviewed = false) => ({
  code,
  value,
  version,
  updatedAt: null,
  review: { reviewed, risk: 'low' },
});
const defaults = (reviewed = false): OfferReviewAnswer => ({
  settings: [
    row('offer-review-mode', 'risk-based', 0, reviewed),
    row('offer-review-probation-offers', '10', 0, reviewed),
    row('offer-review-reference-sellers', '3', 0, reviewed),
    row('offer-review-price-band', '50', 0, reviewed),
    row('offer-review-sampling', '5', 0, reviewed),
    row('offer-review-certificate-badges', 'review', 0, reviewed),
    row('offer-review-backlog-count', '50', 0, reviewed),
    row('offer-review-backlog-hours', '24', 0, reviewed),
  ],
});
const mount = (initial = defaults(), canManage = true) =>
  render(wrap(<OfferReviewPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('offer review answers', () => {
  it('falls back to the launch values when the API names no row', () => {
    expect(settingOf({ settings: [] }, 'offer-review-probation-offers')).toMatchObject({
      value: '10',
      version: 0,
    });
  });

  it('takes a whole number within the bounds only', () => {
    expect(numberValueOf('offer-review-sampling', ' 7 ')).toBe('7');
    for (const typed of ['', '101', '-1', '1.5', '07', 'ten']) {
      expect(numberValueOf('offer-review-sampling', typed), typed).toBeNull();
    }
    expect(numberValueOf('offer-review-reference-sellers', '1')).toBeNull();
  });

  it('refuses an answer that is not a list of rows', () => {
    expect(offerReviewAnswerOf({ settings: [{ code: 'x', value: 1, version: 0 }] })).toBeNull();
    expect(offerReviewAnswerOf(null)).toBeNull();
  });
});

describe('OfferReviewPanel', () => {
  it('shows the values in force and no save bar until something changes', () => {
    mount();
    expect(field('Review mode').value).toBe('risk-based');
    expect(field('New seller offers reviewed').value).toBe('10');
    expect(field('Price band around the reference (%)').value).toBe('50');
    expect(screen.getByText('Not changed yet. The launch values are in force.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows the queue alert limits and saves a changed one with its version', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { settings: [{ ...row('offer-review-backlog-hours', '48', 1), request: null }] },
    });
    mount();
    expect(field('Offers waiting that raise an alert').value).toBe('50');
    expect(field('Business hours before an alert').value).toBe('24');
    type('Business hours before an alert', '48');
    save();
    await expectToast('Saved.', 'success');
    expect(call.mock.calls[0]?.[2]).toEqual({
      changes: [{ code: 'offer-review-backlog-hours', value: '48', expectedVersion: 0 }],
    });
  });

  it('keeps a queue alert limit outside its bounds on the page', async () => {
    mount();
    type('Offers waiting that raise an alert', '0');
    save();
    expect(await screen.findAllByText('Enter a whole number from 1 to 10000.')).not.toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
  });

  it('is read-only without the manage key', () => {
    mount(defaults(), false);
    expect(field('Review mode').disabled).toBe(true);
    expect(field('Offers checked after going live (%)').disabled).toBe(true);
    expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
  });

  it('saves only the changed settings, each with the version it saw, in one request', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        settings: [
          { ...row('offer-review-mode', 'all', 1), request: null },
          { ...row('offer-review-probation-offers', '20', 1), request: null },
        ],
      },
    });
    mount();
    fireEvent.change(field('Review mode'), { target: { value: 'all' } });
    type('New seller offers reviewed', ' 20 ');
    save();
    await expectToast('Saved.', 'success');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'settings/admin/offer-review',
      {
        changes: [
          { code: 'offer-review-mode', value: 'all', expectedVersion: 0 },
          { code: 'offer-review-probation-offers', value: '20', expectedVersion: 0 },
        ],
      },
      'csrf',
    );
    await waitFor(() =>
      expect(
        screen.getByText('Changed by an admin. Each change is in the audit log.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('keeps a number outside its bounds on the page and says why', async () => {
    mount();
    type('Sellers needed for a reference price', '1');
    save();
    expect(await screen.findAllByText('Enter a whole number from 2 to 20.')).not.toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
  });

  it('needs a note where a change is reviewed and sends it with the save', async () => {
    mount(defaults(true));
    type('Offers checked after going live (%)', '10');
    save();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Note for reviewers'), {
      target: { value: 'More checks at launch' },
    });
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        settings: [
          { ...row('offer-review-sampling', '10', 1, true), request: { id: 'r', number: 4 } },
        ],
      },
    });
    save();
    await expectToast('Sent for review (SR-4)', 'info');
    expect(call.mock.calls[0]?.[2]).toEqual({
      changes: [{ code: 'offer-review-sampling', value: '10', expectedVersion: 0 }],
      note: 'More checks at launch',
    });
  });

  it('keeps the draft and says so when the API refuses the save', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount();
    type('Price band around the reference (%)', '40');
    save();
    await waitFor(() =>
      expect(screen.getByText("You don't have permission to change these settings.")).toBeTruthy(),
    );
    expect(field('Price band around the reference (%)').value).toBe('40');
  });

  it('on a stale version re-reads and compares the draft with what is saved now', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'settings.conflict' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: defaults() });
    mount();
    type('Price band around the reference (%)', '40');
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]).toEqual(['GET', 'settings/admin/offer-review']);
  });
});
