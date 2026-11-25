import { describe, expect, it } from 'vitest';
import { ORDERS_PATH, ordersHref } from './orders-link.ts';
import { queryFromParams } from './orders-query.ts';

const paramsOf = (href: string) =>
  Object.fromEntries(new URL(href, 'http://admin.localhost').searchParams);

describe('ordersHref', () => {
  it('is the plain list without a filter', () => {
    expect(ordersHref()).toBe(ORDERS_PATH);
    expect(ordersHref({})).toBe('/orders');
  });

  it('writes the known filters in a fixed order', () => {
    expect(
      ordersHref({
        to: '2026-11-22',
        from: '2026-10-24',
        paymentState: 'captured',
        fulfilment: 'to-ship',
        status: 'confirmed',
      }),
    ).toBe(
      '/orders?status=confirmed&fulfilment=to-ship&paymentState=captured&from=2026-10-24&to=2026-11-22',
    );
  });

  it('opens the list on the same filters it writes (round trip through the list reader)', () => {
    const href = ordersHref({
      status: 'cancelled',
      fulfilment: 'delivered',
      from: '2026-11-21',
      to: '2026-11-21',
    });
    const query = queryFromParams(paramsOf(href));
    expect(query.tab).toBe('cancelled');
    expect(query.filters).toEqual({ fulfilment: 'delivered' });
    expect(query.days).toEqual({ from: '2026-11-21', to: '2026-11-21' });
  });

  it('a placed preset replaces the day range', () => {
    expect(ordersHref({ placed: 'last-7-days', from: '2026-11-01', to: '2026-11-02' })).toBe(
      '/orders?placed=last-7-days',
    );
  });

  it('drops an unknown value of every field', () => {
    expect(
      ordersHref({
        status: 'refunded',
        fulfilment: 'lost',
        paymentState: 'failed',
        placed: 'last-year',
        from: '2026-02-30',
        to: 'yesterday',
      }),
    ).toBe('/orders');
    expect(ordersHref({ status: 'all' })).toBe('/orders');
    expect(ordersHref({ status: 'Confirmed' })).toBe('/orders');
  });

  it('drops a backwards range and keeps a one-sided one', () => {
    expect(ordersHref({ from: '2026-11-22', to: '2026-11-01' })).toBe('/orders');
    expect(ordersHref({ from: '2026-11-22' })).toBe('/orders?from=2026-11-22');
    expect(ordersHref({ to: '2026-11-22' })).toBe('/orders?to=2026-11-22');
  });

  it('never lets text from an answer reach the address (injection and encoding)', () => {
    const href = ordersHref({
      status: 'confirmed&q=alice@example.com',
      fulfilment: 'to-ship#x',
      from: '2026-11-01&to=2027-01-01',
      to: '<script>',
    });
    expect(href).toBe('/orders');
    // Every value written is URL-encoded by URLSearchParams; the allowed values need no escaping.
    const written = ordersHref({ status: 'pending-payment', from: '2026-01-05' });
    expect(written).toBe('/orders?status=pending-payment&from=2026-01-05');
    expect(new URL(written, 'http://x').searchParams.get('status')).toBe('pending-payment');
  });
});
