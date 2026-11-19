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
import { cashbackBody, cashbackOf, fieldProblems, walletOffOf } from './exclusive-cashback.tsx';
import { ExclusivePerks } from './exclusive-perks.tsx';
import type { OwnPromotion } from './perks-shared.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const writes = () => call.mock.calls.filter((c) => c[0] !== 'GET');

const cashback = (over: Partial<OwnPromotion> = {}): OwnPromotion => ({
  id: '0190a000-0000-7000-8000-0000000000c1',
  type: 'CASHBACK',
  status: 'ACTIVE',
  name: 'Exclusive cashback',
  funding: 'SELLER',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: null,
  currency: 'AUD',
  reward: { kind: 'PERCENT', bps: 500, amountMinor: null },
  segment: { kind: 'SELLER_EXCLUSIVE' },
  pausedBy: null,
  capMinor: '2000',
  ...over,
});
const discount = (currency: string): OwnPromotion => ({
  ...cashback({ currency, capMinor: null }),
  id: '0190a000-0000-7000-8000-0000000000e1',
  type: 'CUSTOMER_GROUP',
  name: 'Friends 10',
});

const mount = (canManage = true, locale = 'en-AU') =>
  render(
    wrap(
      <ExclusivePerks
        canManage={canManage}
        csrfToken="csrf"
        timeZone="Australia/Brisbane"
        showPromotions
        showCommission
      />,
      locale,
    ),
  );

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  call.mockReset();
});
afterEach(cleanup);

describe('cashback helpers', () => {
  it('picks the exclusive cashback and fixes the segment and the funding in the body', () => {
    expect(cashbackOf([cashback({ segment: null }), cashback()])?.id).toBe(cashback().id);
    expect(cashbackOf([discount('AUD')])).toBeNull();
    expect(
      cashbackBody({ name: 'A', bps: 250, capMinor: '1500', startsAt: null, endsAt: null }),
    ).toEqual({
      type: 'CASHBACK',
      name: 'A',
      funding: 'SELLER',
      segment: { kind: 'SELLER_EXCLUSIVE' },
      reward: { kind: 'PERCENT', bps: 250 },
      capMinor: '1500',
    });
  });

  it('reads the API field codes', () => {
    const failure = (path: string, code: string) => ({
      status: 400,
      code: 'validation.failed',
      details: { fields: [{ path, code }] },
    });
    expect(walletOffOf(failure('type', 'unavailable'))).toBe(true);
    expect(walletOffOf(failure('capMinor', 'required'))).toBe(false);
    expect(fieldProblems(failure('reward.bps', 'exceeds-market-limit'))).toEqual({
      percent: 'percent-high',
    });
    expect(fieldProblems(failure('reward.bps', 'below-market-minimum'))).toEqual({
      percent: 'percent-low',
    });
    expect(fieldProblems(failure('capMinor', 'exceeds-market-limit'))).toEqual({ cap: 'cap-high' });
    expect(fieldProblems({ status: 500, code: 'x' })).toEqual({});
  });
});

describe('cashback card', () => {
  it('shows the current cashback in the Market currency with a status word', async () => {
    servePerks(call, { cashback: [ok({ items: [cashback()] })] });
    mount();
    expect(await screen.findByText('Cashback for exclusive customers')).toBeTruthy();
    expect(await screen.findByText('5%')).toBeTruthy();
    expect(screen.getByText('$20.00')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause…' })).toBeTruthy();
    expect(
      screen.getByText(
        "Credit is added after delivery from that store's order amount and can be spent at any MondaPac store. It is paid from your payout.",
      ),
    ).toBeTruthy();
    expect(call.mock.calls.map((c) => c[1])).toContain(
      'promotions/seller/promotions?type=CASHBACK&limit=100',
    );
  });

  it('shows a JPY cap without decimals (a second Market)', async () => {
    servePerks(call, {
      cashback: [ok({ items: [cashback({ currency: 'JPY', capMinor: '500' })] })],
    });
    mount(true, 'ja-JP');
    expect(await screen.findByText(/500/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    expect(screen.getByLabelText<HTMLInputElement>('Most credited per order (JPY)').value).toBe(
      '500',
    );
  });

  it('is view only without the manage key', async () => {
    servePerks(call, { cashback: [ok({ items: [cashback()] })] });
    mount(false);
    await screen.findByText('5%');
    expect(screen.queryByRole('button', { name: 'Edit…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause…' })).toBeNull();
  });

  it('offers no Resume when MondaPac paused it', async () => {
    servePerks(call, {
      cashback: [ok({ items: [cashback({ status: 'PAUSED', pausedBy: 'ADMIN' })] })],
    });
    mount();
    expect(await screen.findByText(/MondaPac paused this cashback/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume…' })).toBeNull();
  });

  it('creates a cashback in major units and sends minor units (AUD, from the discount currency)', async () => {
    servePerks(call, { discount: [ok({ items: [discount('AUD')] })], writes: [ok({})] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive cashback…' }));
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Most credited per order (AUD)'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      'promotions/seller/promotions',
      {
        type: 'CASHBACK',
        name: 'Exclusive cashback',
        funding: 'SELLER',
        segment: { kind: 'SELLER_EXCLUSIVE' },
        reward: { kind: 'PERCENT', bps: 500 },
        capMinor: '2000',
      },
      'csrf',
    ]);
  });

  it('asks for minor units when no promotion shows the currency, and refuses decimals', async () => {
    servePerks(call, { writes: [ok({})] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive cashback…' }));
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Most credited per order (minor units)'), {
      target: { value: '20.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback' }));
    expect(await screen.findByText('Enter whole minor units, like 2000.')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('refuses a bad percent before any request', async () => {
    servePerks(call, { discount: [ok({ items: [discount('JPY')] })] });
    mount(true, 'ja-JP');
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive cashback…' }));
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Most credited per order (JPY)'), {
      target: { value: '5.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback' }));
    expect(await screen.findByText('Enter a percentage like 5 or 2.5.')).toBeTruthy();
    expect(screen.getByText('Enter an amount like 20.00.')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('shows the Market limits from the API next to the field and keeps the dialog open', async () => {
    servePerks(call, {
      discount: [ok({ items: [discount('AUD')] })],
      writes: [
        fail(400, 'validation.failed', {
          fields: [
            { path: 'reward.bps', code: 'exceeds-market-limit' },
            { path: 'capMinor', code: 'exceeds-market-limit' },
          ],
        }),
      ],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive cashback…' }));
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Most credited per order (AUD)'), {
      target: { value: '9999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback' }));
    expect(await screen.findByText(/above the highest cashback your Market allows/)).toBeTruthy();
    expect(screen.getByText(/above the highest per-order cap/)).toBeTruthy();
    expect(screen.getByLabelText('Cashback (%)')).toBeTruthy();
  });

  it('says the wallet is off when the API says cashback is unavailable', async () => {
    servePerks(call, {
      discount: [ok({ items: [discount('AUD')] })],
      writes: [fail(400, 'validation.failed', { fields: [{ path: 'type', code: 'unavailable' }] })],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive cashback…' }));
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Most credited per order (AUD)'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback' }));
    expect(
      await screen.findByText('Cashback needs the customer wallet, which is off in your Market.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create exclusive cashback…' })).toBeNull();
  });

  it('edits with a PATCH of the whole definition', async () => {
    servePerks(call, { cashback: [ok({ items: [cashback()] })], writes: [ok({})] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    expect(screen.getByLabelText<HTMLInputElement>('Cashback (%)').value).toBe('5');
    expect(screen.getByLabelText<HTMLInputElement>('Most credited per order (AUD)').value).toBe(
      '20.00',
    );
    fireEvent.change(screen.getByLabelText('Cashback (%)'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'PATCH',
      `promotions/seller/promotions/${cashback().id}`,
      expect.objectContaining({
        type: 'CASHBACK',
        segment: { kind: 'SELLER_EXCLUSIVE' },
        reward: { kind: 'PERCENT', bps: 750 },
        capMinor: '2000',
        startsAt: '2026-11-01T00:00:00.000Z',
      }),
      'csrf',
    ]);
  });

  it('pauses and resumes through a confirmation', async () => {
    servePerks(call, { cashback: [ok({ items: [cashback()] })], writes: [ok({}), ok({})] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause cashback' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.[1]).toBe(`promotions/seller/promotions/${cashback().id}/pause`);
    cleanup();
    call.mockReset();
    servePerks(call, {
      cashback: [ok({ items: [cashback({ status: 'PAUSED', pausedBy: 'SELLER' })] })],
      writes: [ok({})],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume cashback' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.[1]).toBe(`promotions/seller/promotions/${cashback().id}/resume`);
  });

  it('prefers a live cashback, and offers Create (no Edit) when the only one is rejected or ended', async () => {
    const rejected = cashback({ id: 'r', status: 'REJECTED' });
    const ended = cashback({ id: 'e', endsAt: '2020-01-01T00:00:00.000Z' });
    expect(cashbackOf([rejected, ended, cashback()])?.id).toBe(cashback().id);
    expect(cashbackOf([rejected, ended])?.id).toBe('r');
    for (const [item, word] of [
      [rejected, 'Rejected'],
      [ended, 'Ended'],
    ] as const) {
      cleanup();
      servePerks(call, { cashback: [ok({ items: [item] })], writes: [ok({})] });
      mount();
      expect(await screen.findByText(word)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit…' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pause…' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Create exclusive cashback…' }));
      expect(screen.getByRole('button', { name: 'Create cashback' })).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>('Cashback (%)').value).toBe('');
    }
  });

  it('shows the wallet-off text when a write answers promotions.disabled (404)', async () => {
    servePerks(call, {
      cashback: [ok({ items: [cashback()] })],
      writes: [fail(404, 'promotions.disabled')],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause cashback' }));
    expect(
      await screen.findByText('Cashback needs the customer wallet, which is off in your Market.'),
    ).toBeTruthy();
  });

  it('shows a 429 on a resume with the wait in minutes', async () => {
    servePerks(call, {
      cashback: [ok({ items: [cashback({ status: 'PAUSED', pausedBy: 'SELLER' })] })],
      writes: [fail(429, 'rate-limit', { retryAfterSeconds: 300 })],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume cashback' }));
    expect(await screen.findByText('Try again in 5 minutes.')).toBeTruthy();
  });

  it('keeps the start of an edited cashback as the API gave it (it accepts a past start)', async () => {
    servePerks(call, { cashback: [ok({ items: [cashback()] })], writes: [ok({})] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect((writes()[0]?.[2] as { startsAt: string }).startsAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('shows a 429 on a write with the wait in minutes and keeps the dialog', async () => {
    servePerks(call, {
      cashback: [ok({ items: [cashback()] })],
      writes: [fail(429, 'rate-limit', { retryAfterSeconds: 150 })],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause cashback' }));
    expect(await screen.findByText('Try again in 3 minutes.')).toBeTruthy();
  });

  it('hides the cashback card alone on a 403 and shows nothing when both are refused', async () => {
    servePerks(call, { cashback: [fail(403, 'access.denied')] });
    mount();
    expect(await screen.findByText('Discount for exclusive customers')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Cashback for exclusive customers')).toBeNull());
    cleanup();
    servePerks(call, {
      discount: [fail(403, 'access.denied')],
      cashback: [fail(403, 'access.denied')],
    });
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toBe('Nothing to show here in your Market.'));
  });

  it('shows the discount alone when only the discount is refused', async () => {
    servePerks(call, {
      discount: [fail(403, 'access.denied')],
      cashback: [ok({ items: [cashback()] })],
    });
    mount();
    expect(await screen.findByText('5%')).toBeTruthy();
    expect(screen.queryByText('Discount for exclusive customers')).toBeNull();
  });

  it('shows a failure inside the card with Retry, and a 429 with minutes', async () => {
    servePerks(call, {
      cashback: [fail(500, 'x'), ok({ items: [cashback()] })],
    });
    mount();
    expect(
      await screen.findByText('Perks could not be loaded. Try again in a moment.'),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByText('5%')).toBeTruthy();
    cleanup();
    servePerks(call, {
      cashback: [fail(429, 'rate-limit', { retryAfterSeconds: 60 })],
    });
    mount();
    expect(await screen.findByText('Try again in 1 minute.')).toBeTruthy();
  });

  it('says promotions are off in the Market on a 404', async () => {
    servePerks(call, { cashback: [fail(404, 'promotions.disabled')] });
    mount();
    expect(
      (await screen.findAllByText('Promotions are not available in your Market')).length,
    ).toBeGreaterThan(0);
  });
});
