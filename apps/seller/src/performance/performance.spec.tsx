// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNavItems } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { Performance } from './performance.tsx';
import type { HealthCard, OwnHealth } from './types.ts';

const call = vi.mocked(callApi);
const card = (over: Partial<HealthCard> = {}): HealthCard => ({
  day: '2026-11-10',
  kind: 'scored',
  band: 'at-risk',
  score: 58,
  lowestMetric: 'late-ready',
  formulaVersion: 'v1',
  computedAt: '2026-11-10T14:00:00.000Z',
  orders: 40,
  metrics: [
    { metric: 'seller-cancellations', kind: 'scored', band: 'healthy', score: 90 },
    { metric: 'late-ready', kind: 'scored', band: 'at-risk', score: 58 },
    { metric: 'customer-rating', kind: 'scored', band: 'healthy', score: 80 },
    { metric: 'lost-disputes', kind: 'scored', band: 'healthy', score: 100 },
    { metric: 'reports', kind: 'no-data' },
  ],
  ...over,
});
const health = (over: Partial<OwnHealth> = {}): OwnHealth => ({
  current: card(),
  trend: [
    { day: '2026-11-08', kind: 'scored', score: 70 },
    { day: '2026-11-09', kind: 'scored', score: 64 },
    { day: '2026-11-10', kind: 'scored', score: 58 },
  ],
  refresh: { pending: false, retryAfterSeconds: 0 },
  ...over,
});

function mount(data: OwnHealth) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
      <Performance initial={data} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

describe('seller performance page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the score, the lowest measure in plain words, and all five measures', () => {
    mount(health());

    // The headline and the lowest measure show the same band and score.
    expect(screen.getAllByText('At risk · 58')).toHaveLength(2);
    expect(
      screen.getByText(/Ready late is the measure that pulls your score down most/),
    ).toBeTruthy();
    expect(screen.getAllByText('Cancelled by you').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Customer rating').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reports').length).toBeGreaterThan(0);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByRole('img', { name: /from 70 to 58/ })).toBeTruthy();
  });

  it('says New with the order count, and No data yet, instead of a score', () => {
    mount(health({ current: card({ kind: 'new', band: null, score: null, lowestMetric: null }) }));
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText(/you have 40 orders/)).toBeTruthy();
    cleanup();
    mount(
      health({ current: card({ kind: 'no-data', band: null, score: null, lowestMetric: null }) }),
    );
    expect(screen.getByText('No data yet')).toBeTruthy();
  });

  it('shows an empty state before any night measured the store', () => {
    mount(health({ current: null, trend: [] }));
    expect(screen.getByText('No score yet')).toBeTruthy();
  });

  it('explains how it is calculated, in words a seller can follow', () => {
    mount(health());
    expect(screen.getByText('How is it calculated?')).toBeTruthy();
    expect(screen.getByText(/lowest of them/)).toBeTruthy();
    expect(screen.getByText(/Nothing happens to your store automatically/)).toBeTruthy();
  });

  it('queues a recount on click, then reads the page again', async () => {
    call
      .mockResolvedValueOnce({ ok: true, status: 202, body: { status: 'queued' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: health({ refresh: { pending: true, retryAfterSeconds: 900 } }),
      });
    mount(health());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    await waitFor(() => expect(screen.getByText(/A new count is on its way/)).toBeTruthy());
    expect(call).toHaveBeenNthCalledWith(1, 'POST', 'sellers/own-health/refresh', {}, 'csrf-1');
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'sellers/own-health');
    expect(screen.getByText(/refresh again in about 15 min/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh now' }).disabled).toBe(
      true,
    );
  });

  it('disables Refresh now during the cooldown and while a recount waits', () => {
    mount(health({ refresh: { pending: false, retryAfterSeconds: 600 } }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh now' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/refresh again in about 10 min/)).toBeTruthy();
  });

  it('shows the wait when the API says to slow down, and a message when it is down', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 300 } },
    });
    mount(health());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(screen.getByText(/refresh again in about 5 min/)).toBeTruthy());
    cleanup();

    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 503, code: 'sellers.unavailable' },
    });
    mount(health());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(screen.getByText(/could not ask for a new count/)).toBeTruthy());
  });

  it('adds the page to the menu of an approved seller only', () => {
    const ids = (state: 'approved' | 'pending') => sellerNavItems(state, []).map((item) => item.id);
    expect(ids('approved')).toContain('s_performance');
    expect(ids('pending')).not.toContain('s_performance');
  });
});
