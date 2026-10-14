import { StripeConnectGateway, type StripeRequest } from './stripe-connect-gateway';

// The Connect gateway against a fake `fetch`: the exact requests (form body, idempotency key only
// on the create call, the secret only in Authorization), the narrowing of Stripe's account and
// every failure as a code without Stripe's text.

const KEY = 'sk_test_abcdefgh12345678';
const answer = (status: number, body: unknown) => () =>
  Promise.resolve({ status, json: () => Promise.resolve(body) });

const ACCOUNT = {
  id: 'acct_test_a1',
  object: 'account',
  details_submitted: true,
  payouts_enabled: true,
  capabilities: { transfers: 'active' },
  requirements: {
    currently_due: ['individual.dob.day', 'external_account'],
    past_due: [],
    disabled_reason: null,
  },
  metadata: { market_id: 'AU', seller_id: 'seller-1' },
  business_profile: { name: 'Should not be kept' },
  email: 'should-not-be-kept@example.test',
};

describe('StripeConnectGateway', () => {
  it('creates an Express account with the transfers capability and the idempotency key', async () => {
    const calls: { url: string; init: Parameters<StripeRequest>[1] }[] = [];
    const gateway = new StripeConnectGateway(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, { id: 'acct_test_a1', object: 'account' })();
    });

    const created = await gateway.createAccount({
      idempotencyKey: 'connected-account:AU:seller-1',
      country: 'AU',
      marketId: 'AU',
      sellerId: 'seller-1',
    });

    expect(created).toEqual({ ok: true, value: { accountRef: 'acct_test_a1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/accounts');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'connected-account:AU:seller-1',
    });
    const form = new URLSearchParams(calls[0]?.init.body);
    expect(Object.fromEntries(form)).toEqual({
      type: 'express',
      country: 'AU',
      'capabilities[transfers][requested]': 'true',
      'metadata[market_id]': 'AU',
      'metadata[seller_id]': 'seller-1',
    });
    expect(calls[0]?.init.body).not.toContain(KEY);
  });

  it('creates an onboarding or update link and returns the URL only', async () => {
    const calls: { url: string; init: Parameters<StripeRequest>[1] }[] = [];
    const gateway = new StripeConnectGateway(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, {
        url: 'https://connect.stripe.com/setup/e/acct_1/abc',
        object: 'account_link',
      })();
    });
    const base = {
      accountRef: 'acct_test_a1',
      returnUrl: 'https://seller.test/payout-account?stripe=return',
      refreshUrl: 'https://seller.test/payout-account?stripe=refresh',
    };

    expect(await gateway.createAccountLink({ ...base, kind: 'onboarding' })).toEqual({
      ok: true,
      value: { url: 'https://connect.stripe.com/setup/e/acct_1/abc' },
    });
    await gateway.createAccountLink({ ...base, kind: 'update' });
    const types = calls.map((c) => new URLSearchParams(c.init.body).get('type'));
    expect(types).toEqual(['account_onboarding', 'account_update']);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/account_links');
    expect(calls[0]?.init.headers['Idempotency-Key']).toBeUndefined();
    const form = Object.fromEntries(new URLSearchParams(calls[0]?.init.body));
    expect(form).toMatchObject({ account: 'acct_test_a1', return_url: base.returnUrl });
  });

  it('reads an account and keeps counts and flags, never personal or requirement content', async () => {
    const gateway = new StripeConnectGateway(KEY, answer(200, ACCOUNT));

    expect(await gateway.readAccount('acct_test_a1')).toEqual({
      ok: true,
      value: {
        id: 'acct_test_a1',
        metadataMarketId: 'AU',
        metadataSellerId: 'seller-1',
        detailsSubmitted: true,
        transfersActive: true,
        payoutsEnabled: true,
        requirementsDue: 2,
        requirementsPastDue: false,
        disabledReason: null,
      },
    });
  });

  it('answers a code without Stripe text for every failure, and never calls with a bad id or no key', async () => {
    const failing = (status: number) =>
      new StripeConnectGateway(KEY, answer(status, { error: 'x' }));
    expect(await failing(500).readAccount('acct_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
    expect(await failing(429).readAccount('acct_test_a1')).toMatchObject({ ok: false });
    expect(await failing(402).readAccount('acct_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-rejected' },
    });
    const calls: string[] = [];
    const watching = new StripeConnectGateway(KEY, (url) => {
      calls.push(url);
      return answer(200, ACCOUNT)();
    });
    expect(await watching.readAccount('cs_test_wrong')).toMatchObject({ ok: false });
    expect(
      await new StripeConnectGateway(null, answer(200, ACCOUNT)).readAccount('acct_test_a1'),
    ).toMatchObject({ ok: false, error: { code: 'payment.provider-unavailable' } });
    expect(calls).toEqual([]);
    const thrown = new StripeConnectGateway(KEY, () =>
      Promise.reject(new Error('net down sk_test')),
    );
    expect(await thrown.readAccount('acct_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
    const malformed = new StripeConnectGateway(
      KEY,
      answer(200, { id: 'acct_test_a1', object: 'account' }),
    );
    expect(await malformed.readAccount('acct_test_a1')).toMatchObject({ ok: false });
    const noLink = new StripeConnectGateway(KEY, answer(200, { url: 'http://evil.test/x' }));
    expect(
      await noLink.createAccountLink({
        accountRef: 'acct_test_a1',
        kind: 'onboarding',
        returnUrl: 'https://a.test/r',
        refreshUrl: 'https://a.test/f',
      }),
    ).toMatchObject({ ok: false });
  });

  it('gives up after the timeout', async () => {
    const hanging = new StripeConnectGateway(
      KEY,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      10,
    );
    expect(await hanging.readAccount('acct_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
  });
});
