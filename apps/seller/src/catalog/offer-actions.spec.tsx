// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { offerActionErrorOf } from './offer-action-errors.ts';
import { OfferActions } from './offer-actions.tsx';

const call = vi.mocked(callApi);
const assign = vi.fn();
const mount = (status: string) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferActions offerId="o1" status={status} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

describe('OfferActions', () => {
  it('submits a draft and says it waits for review', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { published: false } });
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'catalog/seller/offers/o1/submit',
        undefined,
        'csrf',
      ),
    );
    expect(await screen.findByText(/We will review the offer/)).toBeTruthy();
  });

  it('says so when the market publishes at once', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { published: true } });
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(/Submitted and published/)).toBeTruthy();
  });

  it('shows the missing-handling refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 422, code: 'offer.handling-missing' } });
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(/its handling is not set/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeTruthy();
  });

  it('asks before deleting, then deletes', async () => {
    call.mockResolvedValue({ ok: true, status: 204, body: null });
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Delete offer' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('DELETE', 'catalog/seller/offers/o1', undefined, 'csrf'),
    );
    expect(await screen.findByText(/Offer deleted/)).toBeTruthy();
  });

  it('cancelling the delete sends nothing', () => {
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Delete offer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete offer' })).toBeTruthy();
  });

  it('offers only delete when changes are needed, and nothing when waiting or published', () => {
    mount('changes-needed');
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete offer' })).toBeTruthy();
    cleanup();
    for (const status of ['pending-first-publish', 'published']) {
      const { container } = mount(status);
      expect(container.querySelector('button')).toBeNull();
      cleanup();
    }
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('offerActionErrorOf', () => {
  it('maps named codes and falls back by status', () => {
    expect(offerActionErrorOf({ status: 409, code: 'conflict.stale' })).toBe(
      'catalog.offer-actions.error.stale',
    );
    expect(offerActionErrorOf({ status: 503, code: 'access.unavailable' })).toBe(
      'catalog.offer-actions.error.unavailable',
    );
    expect(offerActionErrorOf({ status: 500, code: 'x' })).toBe(
      'catalog.offer-actions.error.unknown',
    );
  });
});
