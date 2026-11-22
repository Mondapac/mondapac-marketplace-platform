import { describe, expect, it, vi } from 'vitest';

// With the API configured, the sample Pay and the sample delivery options never answer: a real
// cart is paid only through the API (src/checkout/live-pay.ts).

describe('sample Pay with the API configured', () => {
  it('answers failed instead of a sample order or sample delivery prices', async () => {
    vi.stubEnv('API_BASE_URL', 'http://localhost:3000');
    vi.resetModules();
    const { payOrder, deliveryOptionsFor } = await import('../src/checkout/actions.ts');
    const aud = (amount: number) => ({ amount, currency: 'AUD' });
    const answer = await payOrder({
      method: 'card',
      confirmationToken: null,
      address: { kind: 'saved', id: 'home' },
      lines: { brisket: 1 },
      delivery: { kedron: { method: 'pickup', quoteId: null, window: null, total: aud(0) } },
      discountCode: null,
      total: aud(5540),
    });
    expect(answer).toEqual({ kind: 'failed' });
    expect(
      await deliveryOptionsFor({ address: { kind: 'saved', id: 'home' }, sellerIds: ['kedron'] }),
    ).toEqual({ kind: 'failed' });
    vi.unstubAllEnvs();
  });
});
