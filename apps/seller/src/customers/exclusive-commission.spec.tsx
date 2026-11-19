// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { servePerks } from '../../test/serve-perks.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi } from '../api/client.ts';
import {
  byCurrency,
  monthLabel,
  percentOf,
  type ExclusiveCommission,
} from './exclusive-commission.tsx';
import { ExclusivePerks, perkAccessOf } from './exclusive-perks.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale: string) => (
  <NextIntlClientProvider locale={locale} messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const mount = (locale = 'en-AU') =>
  render(
    wrap(
      <ExclusivePerks
        canManage
        csrfToken="csrf"
        timeZone="Australia/Brisbane"
        showPromotions={false}
        showCommission
      />,
      locale,
    ),
  );

const months = (amounts: Record<string, { amount: string; currency: string }[]>) =>
  Array.from({ length: 12 }, (_, index) => {
    const month = `${index < 1 ? 2025 : 2026}-${String(((index + 11) % 12) + 1).padStart(2, '0')}`;
    return { month, saved: amounts[month] ?? [] };
  });
const body = (over: Partial<ExclusiveCommission> = {}): ExclusiveCommission => ({
  rule: { standardRateBps: 1000, exclusiveRateBps: 650, months: 6 },
  zone: 'Australia/Brisbane',
  months: months({
    '2026-10': [{ amount: '-300', currency: 'AUD' }],
    '2026-11': [{ amount: '12550', currency: 'AUD' }],
  }),
  thisMonth: [{ amount: '12550', currency: 'AUD' }],
  ...over,
});

beforeEach(() => {
  call.mockReset();
});
afterEach(cleanup);

describe('commission helpers', () => {
  it('groups months per currency with zero rows, and formats percent and month', () => {
    const groups = byCurrency([
      { month: '2026-10', saved: [{ amount: '5', currency: 'NZD' }] },
      { month: '2026-11', saved: [{ amount: '7', currency: 'AUD' }] },
    ]);
    expect(groups.map((g) => g.currency)).toEqual(['AUD', 'NZD']);
    expect(groups[0]?.rows.map((r) => r.amount)).toEqual(['0', '7']);
    expect(percentOf(650)).toBe('6.5');
    expect(monthLabel('2026-11', 'en-AU')).toContain('2026');
  });
});

describe('special commission card', () => {
  it('shows the rule, this month and the last 12 months (AUD), a negative month as refunds', async () => {
    servePerks(call, { commission: [ok(body())] });
    mount();
    expect(
      await screen.findByText(
        "Your commission on exclusive customers is 6.5% instead of 10% for 6 months from each customer's sign-up.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('Savings this month')).toBeTruthy();
    expect(screen.getAllByText('$125.50').length).toBe(2);
    const given = screen.getByText(/\(refunds\)/);
    expect(given.textContent).toContain('3.00');
    expect(screen.getByText(/Australia\/Brisbane/)).toBeTruthy();
    const rows = Array.from(screen.getByRole('region', { name: 'AUD' }).querySelectorAll('li'));
    expect(rows).toHaveLength(12);
    const expected = body().months.map((m) => monthLabel(m.month, 'en-AU'));
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual(expected);
    expect(expected[0]).toContain('2025');
    expect(expected[11]).toContain('Nov');
    expect(call.mock.calls[0]).toEqual(['GET', 'commission-payouts/seller/exclusive-commission']);
  });

  it('shows a JPY Market without decimals', async () => {
    servePerks(call, {
      commission: [
        ok(
          body({
            zone: 'Asia/Tokyo',
            months: months({
              '2026-10': [{ amount: '-500', currency: 'JPY' }],
              '2026-11': [{ amount: '4500', currency: 'JPY' }],
            }),
            thisMonth: [{ amount: '4500', currency: 'JPY' }],
          }),
        ),
      ],
    });
    mount('ja-JP');
    expect((await screen.findAllByText(/4,500/)).length).toBe(2);
    expect(screen.getByRole('region', { name: 'JPY' })).toBeTruthy();
    expect(screen.getByText(/500.*\(refunds\)/).textContent).not.toContain('.');
    expect(screen.getByText(/Asia\/Tokyo/)).toBeTruthy();
  });

  it('says there are no orders yet when no month has an amount', async () => {
    servePerks(call, { commission: [ok(body({ months: months({}), thisMonth: [] }))] });
    mount();
    expect(await screen.findByText('No orders from exclusive customers yet.')).toBeTruthy();
    expect(screen.getByText(/instead of 10%/)).toBeTruthy();
  });

  it('draws nothing when the Market has no special rate (rule null)', async () => {
    servePerks(call, { commission: [ok(body({ rule: null }))] });
    const { container } = mount();
    await waitFor(() => expect(call).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe('Nothing to show here in your Market.'));
  });

  it('hides on a 403 and is not asked without the earnings key', async () => {
    servePerks(call, { commission: [fail(403, 'access.denied')] });
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toBe('Nothing to show here in your Market.'));
    cleanup();
    call.mockReset();
    servePerks(call, {});
    render(
      wrap(
        <ExclusivePerks
          canManage
          csrfToken="csrf"
          timeZone={null}
          showPromotions={false}
          showCommission={false}
        />,
        'en-AU',
      ),
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('reads the cards a seller may see from the permission keys', () => {
    expect(perkAccessOf(['promotions.promotion.view'])).toEqual({
      showPromotions: true,
      showCommission: false,
    });
    expect(
      perkAccessOf(['promotions.promotion.manage', 'commission-payouts.earnings.view']),
    ).toEqual({
      showPromotions: true,
      showCommission: true,
    });
    expect(perkAccessOf(['commission-payouts.earnings.view'])).toEqual({
      showPromotions: false,
      showCommission: true,
    });
    expect(perkAccessOf([])).toEqual({ showPromotions: false, showCommission: false });
  });

  it('shows a failure with Retry, and a 429 with the wait in minutes', async () => {
    servePerks(call, {
      commission: [fail(503, 'commission-payouts.rate-unavailable'), ok(body())],
    });
    mount();
    expect(
      await screen.findByText('Commission could not be loaded. Try again in a moment.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Savings this month')).toBeTruthy();
    cleanup();
    servePerks(call, { commission: [fail(429, 'rate-limit', { retryAfterSeconds: 240 })] });
    mount();
    expect(await screen.findByText('Try again in 4 minutes.')).toBeTruthy();
  });

  it('sits next to the promotion cards and the page stays when only they are refused', async () => {
    servePerks(call, {
      discount: [fail(403, 'access.denied')],
      cashback: [fail(403, 'access.denied')],
      commission: [ok(body())],
    });
    render(
      wrap(
        <ExclusivePerks
          canManage
          csrfToken="csrf"
          timeZone="Australia/Brisbane"
          showPromotions
          showCommission
        />,
        'en-AU',
      ),
    );
    expect(await screen.findByText('Savings this month')).toBeTruthy();
    expect(screen.queryByText('Discount for exclusive customers')).toBeNull();
  });
});
