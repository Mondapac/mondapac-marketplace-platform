import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCsrfToken, payByCard, startHostedCheckout } from '../src/account/customer-api.ts';

const ORDER = '0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ADDRESS = '7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';
const order = { addressId: ADDRESS, deliveryMethods: { s1: { method: 'pickup' as const } } };

const calls: { path: string; method: string; headers: Record<string, string>; body: unknown }[] =
  [];

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
      const session = url.endsWith('identity/customer/session');
      return Promise.resolve(
        new Response(JSON.stringify(session ? { email: 'e', csrfToken: 'tok' } : json), {
          status: session ? 200 : status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('checkout and Pay through the relay', () => {
  it('posts the order with the token and the seen total as minor-unit digits, with the CSRF token', async () => {
    answerWith(200, { orderId: ORDER, status: 'authorised', clientSecret: null });
    const result = await payByCard(order, 'ctoken_1', { amount: 5490, currency: 'AUD' });
    expect(result).toEqual({
      kind: 'ok',
      value: { orderId: ORDER, status: 'authorised', clientSecret: null },
    });
    const sent = calls.find((c) => c.path === '/api/orders/pay')!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['x-csrf-token']).toBe('tok');
    expect(sent.body).toEqual({
      ...order,
      confirmationToken: 'ctoken_1',
      expectedTotal: { amount: '5490', currency: 'AUD' },
    });
  });

  it('keeps the secret of a bank check, and refuses an answer it does not know', async () => {
    answerWith(200, { orderId: ORDER, status: 'requires-action', clientSecret: 'pi_s' });
    expect(await payByCard(order, 'ctoken_1', { amount: 1, currency: 'AUD' })).toEqual({
      kind: 'ok',
      value: { orderId: ORDER, status: 'requires-action', clientSecret: 'pi_s' },
    });
    answerWith(200, { orderId: ORDER, status: 'captured', clientSecret: null });
    expect((await payByCard(order, 'ctoken_1', { amount: 1, currency: 'AUD' })).kind).toBe(
      'failed',
    );
    answerWith(200, { orderId: 'x', status: 'authorised', clientSecret: null });
    expect((await payByCard(order, 'ctoken_1', { amount: 1, currency: 'AUD' })).kind).toBe(
      'failed',
    );
  });

  it('gives the refusal and its details for a declined card (402) and a change (409)', async () => {
    answerWith(402, { statusCode: 402, code: 'ordering.card-declined' });
    expect(await payByCard(order, 'ctoken_1', { amount: 1, currency: 'AUD' })).toMatchObject({
      kind: 'invalid',
      code: 'ordering.card-declined',
    });
    answerWith(409, {
      statusCode: 409,
      code: 'ordering.price-changed',
      details: { total: { amount: '7', currency: 'AUD' } },
    });
    expect(await startHostedCheckout(order)).toMatchObject({
      kind: 'invalid',
      code: 'ordering.price-changed',
      details: { total: { amount: '7', currency: 'AUD' } },
    });
  });

  it('starts the hosted page without a token or a total', async () => {
    answerWith(200, { orderId: ORDER, checkoutUrl: 'https://checkout.stripe.com/c/pay/x' });
    expect(await startHostedCheckout(order)).toEqual({
      kind: 'ok',
      value: { orderId: ORDER, checkoutUrl: 'https://checkout.stripe.com/c/pay/x' },
    });
    expect(calls.find((c) => c.path === '/api/orders/checkout')!.body).toEqual(order);
  });
});
