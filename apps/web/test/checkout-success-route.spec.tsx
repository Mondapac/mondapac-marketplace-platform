import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', () => ({ getTranslations: () => Promise.resolve(() => '') }));
vi.mock('../src/seo/metadata.ts', () => ({ pageMetadata: () => ({}), seoDescription: () => '' }));

const { default: HostedSuccessRoute } = await import('../app/checkout/success/page.tsx');
const { HostedPaymentDone, PaymentNotCompleted } =
  await import('../src/checkout/payment-result.tsx');

const ORDER = '16fd2706-8baf-433b-82eb-8c7fada847da';
const route = (params: Record<string, string>) =>
  HostedSuccessRoute({ searchParams: Promise.resolve(params) });

describe("Stripe's success URL", () => {
  it('shows the order reference while the payment is confirmed', async () => {
    const page = await route({ order: ORDER });
    expect(page.type).toBe(HostedPaymentDone);
    expect(page.props).toEqual({ reference: '16FD2706' });
    expect((await route({ order: ORDER, redirect_status: 'succeeded' })).type).toBe(
      HostedPaymentDone,
    );
  });

  it('says the payment was not completed after a failed bank check', async () => {
    for (const status of ['failed', 'requires_payment_method', 'x'])
      expect((await route({ order: ORDER, redirect_status: status })).type).toBe(
        PaymentNotCompleted,
      );
  });

  it('shows no reference for an id that is not an order id', async () => {
    expect((await route({ order: '<script>' })).props).toEqual({ reference: null });
  });
});
