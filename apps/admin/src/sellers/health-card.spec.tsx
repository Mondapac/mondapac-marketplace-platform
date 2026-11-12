// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { SellerHealthCard } from './health-card.tsx';
import type { SellerHealthRead } from './health-types.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const scored: SellerHealthRead = {
  sellerId: SELLER,
  current: {
    day: '2026-11-10',
    kind: 'scored',
    band: 'at-risk',
    score: 58,
    lowestMetric: 'late-ready',
    formulaVersion: '1',
    computedAt: '2026-11-11T02:00:00Z',
    orders: 40,
    metrics: [
      { metric: 'late-ready', kind: 'scored', band: 'at-risk', score: 58 },
      { metric: 'customer-rating', kind: 'scored', band: 'healthy', score: 90 },
      { metric: 'reports', kind: 'no-data' },
      { metric: 'unknown-metric', kind: 'no-data' },
    ],
  },
  trend: [
    { day: '2026-11-09', kind: 'scored', score: 70 },
    { day: '2026-11-10', kind: 'scored', score: 58 },
  ],
};
const mount = (initial: SellerHealthRead, canRecalculate = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellerHealthCard
        sellerId={SELLER}
        initial={initial}
        canRecalculate={canRecalculate}
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SellerHealthCard', () => {
  it('shows the band with the score, the lowest measure and the known metrics only', () => {
    mount(scored);
    expect(screen.getAllByText('At risk · 58')).toHaveLength(2);
    expect(screen.getByText(/pulling the score down most is Orders ready late/)).toBeTruthy();
    expect(screen.getByText('Healthy · 90')).toBeTruthy();
    expect(screen.getByText('Reports')).toBeTruthy();
    expect(screen.queryByText('unknown-metric')).toBeNull();
    expect(screen.getByText(/From 70 to 58 over 2 days/)).toBeTruthy();
  });

  it('says so when no night has measured the seller', () => {
    mount({ sellerId: SELLER, current: null, trend: [] });
    expect(screen.getByText('No night has measured this seller yet.')).toBeTruthy();
  });

  it('queues a recount and says it takes about two minutes', async () => {
    call.mockResolvedValue({ ok: true, status: 202, body: { status: 'queued' } });
    mount(scored);
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate now' }));
    await waitFor(() => expect(screen.getByText(/within about two minutes/)).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `sellers/admin/${SELLER}/health/recalculate`,
      {},
      'csrf',
    );
  });

  it('tells when a recount already waits and when queueing fails', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 202, body: { status: 'already-queued' } });
    mount(scored);
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate now' }));
    await waitFor(() => expect(screen.getByText(/already waiting/)).toBeTruthy());
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 503, code: 'sellers.unavailable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate now' }));
    await waitFor(() => expect(screen.getByText(/could not be queued/)).toBeTruthy());
  });

  it('offers no button without the recalculate key', () => {
    mount(scored, false);
    expect(screen.queryByRole('button', { name: 'Recalculate now' })).toBeNull();
  });
});
