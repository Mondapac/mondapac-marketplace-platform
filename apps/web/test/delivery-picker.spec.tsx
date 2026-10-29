// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { forgetCsrfToken, readDeliveryOptions } from '../src/account/customer-api.ts';
import { viewCart, type Cart } from '../src/cart/cart.ts';
import {
  DeliverySection,
  deliveryChoices,
  deliveryStatus,
  scheduleOf,
  type OptionsState,
} from '../src/checkout/delivery-section.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { SAMPLE_CART_SOURCE } from '../src/storefront/sample-cart.ts';
import { sampleOptionsOf } from '../src/storefront/sample-delivery-options.ts';
import type { DeliveryWish } from '../src/storefront/types.ts';

vi.mock('next/navigation', () => ({
  usePathname: () => '/checkout',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryOptionsFor: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const IDS = ['kedron', 'paddington'];
const states = (): Record<string, OptionsState> => ({
  kedron: { kind: 'options', options: sampleOptionsOf('kedron') },
  paddington: { kind: 'options', options: sampleOptionsOf('paddington') },
});
const NOW = new Date('2026-10-26T00:00:00Z'); // 10:00 on Monday in Brisbane (UTC+10)

describe('delivery choices from the buyer picks', () => {
  it('prices a pickup at nothing and an instant delivery at the stored quote', () => {
    const choices = deliveryChoices(
      IDS,
      { kedron: { method: 'instant' }, paddington: { method: 'pickup' } },
      states(),
      NOW,
      'AUD',
    );
    expect(choices.kedron).toEqual({
      method: 'instant',
      quoteId: 'sample-kedron-instant',
      total: { amount: 1290, currency: 'AUD' },
      tax: { amount: 117, currency: 'AUD' },
      window: null,
    });
    expect(choices.paddington).toEqual({
      method: 'pickup',
      quoteId: null,
      total: { amount: 0, currency: 'AUD' },
      tax: { amount: 0, currency: 'AUD' },
      window: null,
    });
  });

  it('gives no choice for a method that is off, unpriced or missing', () => {
    const wishes: Record<string, DeliveryWish> = {
      kedron: { method: 'scheduled' }, // no day or window yet
      paddington: { method: 'same_day' }, // past the cut-off
    };
    expect(deliveryChoices(IDS, wishes, states(), NOW, 'AUD')).toEqual({});
    expect(
      deliveryChoices(
        ['sunnybank'],
        { sunnybank: { method: 'instant' } },
        {
          sunnybank: { kind: 'options', options: sampleOptionsOf('sunnybank') },
        },
        NOW,
        'AUD',
      ),
    ).toEqual({});
    expect(
      deliveryChoices(
        ['logan-road'],
        { 'logan-road': { method: 'scheduled' } },
        {
          'logan-road': { kind: 'options', options: sampleOptionsOf('logan-road') },
        },
        NOW,
        'AUD',
      ),
    ).toEqual({});
  });

  it('turns a picked day and window into a UTC window on the seller clock', () => {
    const choices = deliveryChoices(
      ['kedron'],
      { kedron: { method: 'scheduled', day: '2026-10-26', windowStart: '12:00' } },
      states(),
      NOW,
      'AUD',
    );
    expect(choices.kedron).toMatchObject({
      method: 'scheduled',
      quoteId: 'sample-kedron-scheduled',
      window: { start: '2026-10-26T02:00:00Z', end: '2026-10-26T04:00:00Z' },
    });
    // A window that has passed is not a choice.
    expect(
      deliveryChoices(
        ['kedron'],
        { kedron: { method: 'scheduled', day: '2026-10-26', windowStart: '08:00' } },
        states(),
        NOW,
        'AUD',
      ),
    ).toEqual({});
  });

  it('offers days from today to the seller days ahead, with the windows still ahead', () => {
    const days = scheduleOf(sampleOptionsOf('kedron'), NOW);
    expect(days).toHaveLength(8);
    expect(days[0]).toEqual({ day: '2026-10-26', starts: ['12:00', '14:00', '16:00', '18:00'] });
    expect(days[7]!.day).toBe('2026-11-02');
    expect(days[7]!.starts).toHaveLength(6);
  });

  it('says where the delivery stands for Pay', () => {
    const ok = states();
    const picked = deliveryChoices(
      IDS,
      { kedron: { method: 'instant' }, paddington: { method: 'instant' } },
      ok,
      NOW,
      'AUD',
    );
    expect(deliveryStatus(IDS, ok, picked)).toBe('ok');
    expect(deliveryStatus(IDS, ok, {})).toBe('choose');
    expect(deliveryStatus(IDS, { ...ok, kedron: { kind: 'loading' } }, picked)).toBe('loading');
    expect(deliveryStatus(IDS, { ...ok, kedron: { kind: 'no-address' } }, picked)).toBe('loading');
    expect(deliveryStatus(IDS, { ...ok, kedron: { kind: 'failed' } }, picked)).toBe('problem');
  });
});

const MET: Cart = {
  brisket: { quantity: 1, unitPrice: SAMPLE_CART_SOURCE.items.brisket!.price, limit: 12 },
  sourdough: { quantity: 1, unitPrice: SAMPLE_CART_SOURCE.items.sourdough!.price, limit: 12 },
};

function Harness({ states: given }: { readonly states: Record<string, OptionsState> }) {
  const { deliveryWish } = useStore();
  const view = viewCart(MET, SAMPLE_CART_SOURCE)!;
  const choices = deliveryChoices(IDS, deliveryWish, given, new Date(), 'AUD');
  return (
    <>
      <DeliverySection view={view} states={given} onRetry={() => undefined} />
      <output>{JSON.stringify(choices)}</output>
    </>
  );
}

function renderPicker(given = states()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider cartSource={SAMPLE_CART_SOURCE} initialCart={MET}>
        <Harness states={given} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const choicesShown = () =>
  JSON.parse(document.querySelector('output')!.textContent) as Record<
    string,
    { method: string; window: { start: string; end: string } | null }
  >;

describe('the delivery picker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('shows the scheduled day and window pickers only for a scheduled pick', () => {
    renderPicker();
    expect(screen.queryByRole('combobox')).toBeNull();
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    fireEvent.click(within(kedron).getByRole('radio', { name: /^Scheduled/ }));
    const day = screen.getByRole('combobox', { name: 'Day' });
    const window = screen.getByRole('combobox', { name: 'Window' });
    expect(window).toHaveProperty('disabled', true);
    expect(
      within(day)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Choose a day',
      'Mon, Oct 26',
      'Tue, Oct 27',
      'Wed, Oct 28',
      'Thu, Oct 29',
      'Fri, Oct 30',
      'Sat, Oct 31',
      'Sun, Nov 1',
      'Mon, Nov 2',
    ]);
    expect(screen.getByText('Pick a delivery window (Brisbane time)')).toBeTruthy();
    // No delivery is chosen until a day and a window are.
    expect(choicesShown()).toEqual({});
    fireEvent.change(day, { target: { value: '2026-10-26' } });
    expect(
      within(window)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Choose a window',
      '12:00 pm – 2:00 pm',
      '2:00 pm – 4:00 pm',
      '4:00 pm – 6:00 pm',
      '6:00 pm – 8:00 pm',
    ]);
    expect(choicesShown()).toEqual({});
    fireEvent.change(window, { target: { value: '14:00' } });
    expect(choicesShown().kedron).toMatchObject({
      method: 'scheduled',
      window: { start: '2026-10-26T04:00:00Z', end: '2026-10-26T06:00:00Z' },
    });
    // Another day clears the window until one is picked again.
    fireEvent.change(day, { target: { value: '2026-10-27' } });
    expect(choicesShown()).toEqual({});
    expect(screen.getByRole('combobox', { name: 'Window' })).toHaveProperty('value', '');
  });

  it('leaves the picker for another method and shows the price with its GST', () => {
    renderPicker();
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    fireEvent.click(within(kedron).getByRole('radio', { name: /^Scheduled/ }));
    expect(screen.getByRole('combobox', { name: 'Day' })).toBeTruthy();
    fireEvent.click(within(kedron).getByRole('radio', { name: /^Pickup/ }));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(choicesShown().kedron).toMatchObject({ method: 'pickup' });
    expect(within(kedron).getByText('Free')).toBeTruthy();
    expect(within(kedron).getAllByText('incl. GST')).toHaveLength(3);
    expect(within(kedron).getByText('Collect it from the seller, postcode 4031')).toBeTruthy();
  });

  it('says every reason a method is off, with the store clock for the cut-off', () => {
    renderPicker({
      kedron: { kind: 'options', options: sampleOptionsOf('sunnybank') },
      paddington: { kind: 'options', options: sampleOptionsOf('paddington') },
    });
    expect(screen.getByText("This store doesn't support instant delivery")).toBeTruthy();
    expect(screen.getByText('Same-day delivery closes at 12:00 pm (Brisbane time)')).toBeTruthy();
    for (const name of [/^Instant/, /^Same day/])
      expect(
        screen
          .getAllByRole('radio', { name })
          .filter((r) => r.getAttribute('aria-disabled') === 'true'),
      ).toHaveLength(1);
    cleanup();
    renderPicker({
      kedron: { kind: 'options', options: sampleOptionsOf('inala') },
      paddington: { kind: 'options', options: sampleOptionsOf('inala') },
    });
    expect(screen.getAllByText("Pickup isn't offered by this store")).toHaveLength(2);
  });

  it('shows a skeleton while loading and a hint without an address', () => {
    renderPicker({ kedron: { kind: 'loading' }, paddington: { kind: 'no-address' } });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(
      screen.getByText('Choose a saved address to see delivery methods and prices.'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('radiogroup', { name: 'Delivery method for Kedron Halal Butchers' })
        .getAttribute('aria-busy'),
    ).toBe('true');
  });
});

describe('reading the delivery options through the relay', () => {
  const calls: { path: string; method: string; headers: Record<string, string>; body: unknown }[] =
    [];
  const money = (amount: string) => ({ amount, currency: 'AUD' });
  const body = {
    sellers: [
      {
        sellerId: 'seller-1',
        zone: 'Australia/Brisbane',
        sameDayCutoff: '12:00',
        scheduledDaysAhead: 7,
        scheduledWindowMinutes: 120,
        pickupPostcode: '4031',
        methods: [
          { method: 'pickup', available: true, reason: null, price: { state: 'free' } },
          {
            method: 'instant',
            available: true,
            reason: null,
            price: {
              state: 'quoted',
              quoteId: '11111111-1111-4111-8111-111111111111',
              total: money('1290'),
              tax: money('117'),
              etaMinutes: 40,
              validUntil: '2026-10-26T00:10:00Z',
            },
          },
          { method: 'same_day', available: false, reason: 'past-cut-off', price: null },
        ],
      },
    ],
  };

  function answerWith(status: number, json: unknown) {
    calls.length = 0;
    forgetCsrfToken();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({
          path: url,
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const csrf = url.endsWith('identity/customer/session');
        return Promise.resolve(
          new Response(
            JSON.stringify(
              csrf ? { accountId: 'a', email: 'e', displayName: 'n', csrfToken: 'tok' } : json,
            ),
            { status: csrf ? 200 : status, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );
  }

  it('posts only the saved address id, and reads money as minor units', async () => {
    answerWith(200, body);
    const result = await readDeliveryOptions('22222222-2222-4222-8222-222222222222');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const sent = calls.find((c) => c.path.endsWith('orders/delivery-quotes'))!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['x-csrf-token']).toBe('tok');
    expect(sent.body).toEqual({ addressId: '22222222-2222-4222-8222-222222222222' });
    const seller = result.value['seller-1']!;
    expect(seller.scheduledWindowMinutes).toBe(120);
    expect(seller.methods.map((m) => m.method)).toEqual(['pickup', 'instant', 'same_day']);
    expect(seller.methods[1]!.price).toEqual({
      state: 'quoted',
      quoteId: '11111111-1111-4111-8111-111111111111',
      total: { amount: 1290, currency: 'AUD' },
      tax: { amount: 117, currency: 'AUD' },
      etaMinutes: 40,
      validUntil: '2026-10-26T00:10:00Z',
    });
    expect(seller.methods[2]).toMatchObject({ available: false, reason: 'past-cut-off' });
  });

  it('refuses an answer of the wrong shape, and tells a signed-out session', async () => {
    const broken = structuredClone<typeof body>(body);
    (broken.sellers[0]!.methods[1]!.price as { total: unknown }).total = {
      amount: 12.9,
      currency: 'AUD',
    };
    answerWith(200, broken);
    expect((await readDeliveryOptions('a')).kind).toBe('failed');
    answerWith(401, { code: 'auth.unauthenticated' });
    expect((await readDeliveryOptions('a')).kind).toBe('signed-out');
    answerWith(503, {});
    expect((await readDeliveryOptions('a')).kind).toBe('failed');
  });
});

describe('a method that is off', () => {
  it('stays focusable with its reason, and cannot be picked', () => {
    renderPicker({
      kedron: { kind: 'options', options: sampleOptionsOf('sunnybank') },
      paddington: { kind: 'options', options: sampleOptionsOf('paddington') },
    });
    const off = screen.getAllByRole('radio', { name: /^Instant/ })[0]!;
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.hasAttribute('disabled')).toBe(false);
    expect(off.getAttribute('aria-describedby')).not.toBeNull();
    fireEvent.click(off);
    expect((off as HTMLInputElement).checked).toBe(false);
  });
});
