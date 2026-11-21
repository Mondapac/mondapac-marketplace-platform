// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { priceProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import { OfferPrices } from './offer-prices.tsx';
import { formatInZone, instantOfZoned } from './zone-time.ts';
import type { OfferPricesView } from './types.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const view: OfferPricesView = {
  offerId: 'o1',
  currency: 'AUD',
  variants: [
    {
      variantId: 'v1',
      seriesVersion: 3,
      currency: 'AUD',
      inForce: { amount: '1999', effectiveFrom: '2026-10-01T00:00:00Z' },
      held: { amount: '2999', submittedAt: '2026-10-02T00:00:00Z', direction: 'up' },
      special: {
        amount: '1499',
        startsAt: '2026-10-05T00:00:00Z',
        endsAt: '2026-10-30T00:00:00Z',
        state: 'running',
      },
      heldSpecial: null,
      retired: false,
    },
    {
      variantId: 'v2',
      seriesVersion: null,
      currency: null,
      inForce: null,
      held: null,
      special: null,
      heldSpecial: null,
      retired: false,
    },
  ],
};
const mount = (canEdit = true, v: OfferPricesView = view, zone?: string) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferPrices offerId="o1" view={v} canEdit={canEdit} csrfToken="csrf" zone={zone} />
    </NextIntlClientProvider>,
  );

const assign = vi.fn();
const pressSave = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('money', () => {
  it('reads and shows minor units exactly', () => {
    expect(minorOf('19.99', 'AUD')).toBe('1999');
    expect(minorOf('20', 'AUD')).toBe('2000');
    expect(minorOf('20.5', 'AUD')).toBe('2050');
    expect(minorOf('0.05', 'AUD')).toBe('5');
    expect(minorOf('1000', 'JPY')).toBe('1000');
    expect(inputOf('1999', 'AUD')).toBe('19.99');
    expect(inputOf('5', 'AUD')).toBe('0.05');
    expect(inputOf('1000', 'JPY')).toBe('1000');
    expect(formatMinor('1999', 'AUD', 'en-AU')).toBe('$19.99');
  });
  it('refuses zero, too many decimals, signs and text', () => {
    for (const text of ['', '0', '0.00', '1.999', '-5', '1e3', 'abc', '12.']) {
      expect(minorOf(text, 'AUD')).toBeNull();
    }
    expect(minorOf('10.5', 'JPY')).toBeNull();
  });
});

describe('OfferPrices', () => {
  it('shows the price in force and the held change', () => {
    mount();
    expect(screen.getByText(/Current price \$19\.99/)).toBeTruthy();
    expect(screen.getByText(/A raise to \$29\.99/)).toBeTruthy();
    expect(screen.getByText('No price set yet.')).toBeTruthy();
  });

  it('saves with the version it read and says when a change is held', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'pending-review', seriesVersion: 4, recordId: 'r1', effectiveFrom: null },
    });
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '45.50' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/regular-price',
      { amount: '4550', currency: 'AUD', expectedVersion: 3 },
      'csrf',
    );
    await expectToast('Saved. The change is large, so it waits for review.', 'info');
    expect(refresh).toHaveBeenCalled();
  });

  it('sends a null version for a first price', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 1, recordId: 'r1', effectiveFrom: 'x' },
    });
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[3]).toBe('csrf');
    expect(call.mock.calls[0]?.[2]).toEqual({
      amount: '500',
      currency: 'AUD',
      expectedVersion: null,
    });
  });

  it('refuses a bad amount without calling the API', () => {
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '1.999' } });
    pressSave();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a price above zero/)).toBeTruthy();
  });

  it('reloads on a stale answer and shows no form without edit permission', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'conflict.stale' },
    } as never);
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '30' } });
    pressSave();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText(/The price changed somewhere else/)).toBeTruthy();
    cleanup();
    mount(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(bar()).toBeNull();
  });

  it('maps API codes to message keys', () => {
    expect(priceProblemOf({ status: 409, code: 'pricing.series-retired' })).toBe('retired');
    expect(priceProblemOf({ status: 503, code: 'access.unavailable' })).toBe('unavailable');
    expect(priceProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });

  it('shows the running special and no special form for an unpriced variant', () => {
    mount();
    expect(screen.getByText(/Special price \$14\.99 is running/)).toBeTruthy();
    expect(screen.getAllByText('Special price')).toHaveLength(1);
  });

  it('sets a special with the shared version, typed in the seller zone, and the regular form follows the new version', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'pending-review', seriesVersion: 4 },
    });
    mount(true, view, 'Australia/Sydney');
    fireEvent.change(screen.getByLabelText('Special price (AUD, GST included)'), {
      target: { value: '9.50' },
    });
    fireEvent.change(screen.getByLabelText('Ends (Australia/Sydney)'), {
      target: { value: '2026-11-01T10:30' },
    });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/special-price',
      {
        amount: '950',
        currency: 'AUD',
        startsAt: null,
        endsAt: '2026-10-31T23:30:00Z',
        expectedVersion: 3,
      },
      'csrf',
    );
    await expectToast(/The discount is large/, 'info');
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 5, recordId: 'r', effectiveFrom: 'x' },
    });
    fireEvent.change(screen.getAllByLabelText('Price (AUD, GST included)')[0] as HTMLElement, {
      target: { value: '30' },
    });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 4 });
  });

  it('shows no bar until a price changes, and Discard puts it back', () => {
    mount();
    expect(bar()).toBeNull();
    const [first] = screen.getAllByLabelText<HTMLInputElement>('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '25' } });
    expect(bar()?.textContent).toContain('1 unsaved change');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(first?.value).toBe('19.99');
    expect(bar()).toBeNull();
  });

  it('saves the regular price, then the special with the version the first save returned', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: 'x' },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 5 },
      });
    mount();
    fireEvent.change(screen.getByLabelText('Special price (AUD, GST included)'), {
      target: { value: '9.50' },
    });
    fireEvent.change(screen.getByLabelText('Ends (UTC)'), {
      target: { value: '2026-11-01T10:30' },
    });
    fireEvent.change(screen.getAllByLabelText('Price (AUD, GST included)')[0] as HTMLElement, {
      target: { value: '25' },
    });
    expect(bar()?.textContent).toContain('2 unsaved changes');
    pressSave();
    await expectToast('2 prices saved.');
    expect(call.mock.calls.map((c) => c[1])).toEqual([
      'pricing/seller/offers/o1/variants/v1/regular-price',
      'pricing/seller/offers/o1/variants/v1/special-price',
    ]);
    expect(call.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 4 });
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('says some changes wait for review when one of several is held', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'pending-review', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 1, recordId: 'r', effectiveFrom: 'x' },
      });
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[0] as HTMLElement, { target: { value: '45' } });
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    pressSave();
    await expectToast(/2 prices saved\. Some changes wait for review/, 'info');
  });

  it('checks every changed price first and sends nothing while one is wrong', async () => {
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[0] as HTMLElement, { target: { value: '25' } });
    fireEvent.change(fields[1] as HTMLElement, { target: { value: 'abc' } });
    pressSave();
    expect(screen.getByText(/Enter a price above zero/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(fields[1]));
  });

  it('keeps a refused price while the next one saves', async () => {
    call
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 422, code: 'pricing.regular-not-above-special' },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 1, recordId: 'r', effectiveFrom: 'x' },
      });
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[0] as HTMLElement, { target: { value: '10' } });
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    pressSave();
    await expectToast(/1 price saved; 1 needs attention/, 'warning');
    await waitFor(() => expect(bar()?.textContent).toContain('1 unsaved change'));
    await waitFor(() => expect(document.activeElement).toBe(fields[0]));
  });

  it('stops at a closed code dialog and sends nothing after it', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[0] as HTMLElement, { target: { value: '25' } });
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bar()?.textContent).toContain('2 unsaved changes'));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('locks the fields while prices are sent, and leaves quietly when signed out', async () => {
    let answer: (value: unknown) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[0] as HTMLElement, { target: { value: '25' } });
    pressSave();
    await waitFor(() => expect((fields[1] as HTMLElement).matches(':disabled')).toBe(true));
    answer({ ok: false, failure: { status: 401, code: 'auth.required' } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
  });

  it('reads datetime-local text as a wall-clock time in a zone', () => {
    expect(instantOfZoned('2026-11-01T10:30', 'UTC')).toBe('2026-11-01T10:30:00Z');
    expect(instantOfZoned('2026-11-01T10:30', 'Australia/Sydney')).toBe('2026-10-31T23:30:00Z');
    expect(instantOfZoned('2026-06-01T10:30', 'Australia/Sydney')).toBe('2026-06-01T00:30:00Z');
    expect(instantOfZoned('2026-06-01T10:30', 'Australia/Perth')).toBe('2026-06-01T02:30:00Z');
    expect(instantOfZoned('', 'UTC')).toBeNull();
    expect(instantOfZoned('nonsense', 'UTC')).toBeNull();
    expect(instantOfZoned('2026-11-01T10:30', 'Not/AZone')).toBeNull();
  });

  it('handles the clock changes of a zone', () => {
    // Sydney: clocks go forward 2026-10-04 02:00 -> 03:00 and back 2027-04-04 03:00 -> 02:00.
    expect(instantOfZoned('2026-10-04T02:30', 'Australia/Sydney')).toBeNull();
    expect(instantOfZoned('2026-10-04T03:30', 'Australia/Sydney')).toBe('2026-10-03T16:30:00Z');
    expect(instantOfZoned('2027-04-04T02:30', 'Australia/Sydney')).toBe('2027-04-03T15:30:00Z');
  });

  it('shows instants in the zone with its short name', () => {
    expect(formatInZone('2026-10-31T23:30:00Z', 'Australia/Sydney', 'en-AU')).toMatch(
      /1 Nov 2026.*10:30.*AEDT$/,
    );
    expect(formatInZone(null, 'UTC', 'en-AU')).toBe('-');
  });

  it('falls back to UTC labels when the zone could not be read', () => {
    mount();
    expect(screen.getByLabelText('Ends (UTC)')).toBeTruthy();
  });

  it('ends the special now with the version and shows API refusals', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { seriesVersion: 4, endedRecordId: 'r', cancelledRecordId: null },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'End special now' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'pricing/seller/offers/o1/variants/v1/special-price/withdraw',
      { expectedVersion: 3 },
      'csrf',
    );
    await expectToast('The special price was ended.');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, code: 'pricing.special-not-below-regular' },
    } as never);
    fireEvent.change(screen.getByLabelText('Special price (AUD, GST included)'), {
      target: { value: '99' },
    });
    fireEvent.change(screen.getByLabelText('Ends (UTC)'), {
      target: { value: '2026-11-01T10:30' },
    });
    pressSave();
    expect(await screen.findByText(/must be below the regular price/)).toBeTruthy();
  });

  it('shows a held special and hides the special form without edit permission', () => {
    const held: OfferPricesView = {
      ...view,
      variants: [
        {
          ...(view.variants[0] as OfferPricesView['variants'][number]),
          special: null,
          heldSpecial: {
            amount: '500',
            startsAt: '2026-10-05T00:00:00Z',
            endsAt: '2026-10-30T00:00:00Z',
            submittedAt: '2026-10-04T00:00:00Z',
          },
        },
      ],
    };
    mount(false, held);
    expect(screen.getByText(/special price of \$5\.00/)).toBeTruthy();
    expect(screen.queryByLabelText('Special price (AUD, GST included)')).toBeNull();
    expect(priceProblemOf({ status: 409, code: 'pricing.regular-not-above-special' })).toBe(
      'regular-not-above',
    );
  });
});
