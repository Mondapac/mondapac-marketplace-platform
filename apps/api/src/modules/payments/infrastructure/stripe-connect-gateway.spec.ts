import {
  STRIPE_V2_VERSION,
  StripeConnectGateway,
  type StripeRequest,
} from './stripe-connect-gateway';

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
  settings: { payouts: { schedule: { interval: 'daily', delay_days: 2 } } },
  external_accounts: {
    object: 'list',
    data: [{ id: 'ba_secret', last4: '6789' }],
    has_more: false,
  },
  business_profile: { name: 'Should not be kept' },
  email: 'should-not-be-kept@example.test',
};

describe('StripeConnectGateway', () => {
  it('creates an Accounts v2 recipient account (Express Dashboard) with the idempotency key', async () => {
    const calls: { url: string; init: Parameters<StripeRequest>[1] }[] = [];
    const gateway = new StripeConnectGateway(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, { id: 'acct_test_a1', object: 'v2.core.account' })();
    });

    const created = await gateway.createAccount({
      idempotencyKey: 'connected-account:AU:seller-1',
      country: 'AU',
      marketId: 'AU',
      sellerId: 'seller-1',
      contactEmail: 'owner@seller.example',
    });

    expect(created).toEqual({ ok: true, value: { accountRef: 'acct_test_a1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Stripe-Version': STRIPE_V2_VERSION,
      'Idempotency-Key': 'connected-account:AU:seller-1',
    });
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      contact_email: 'owner@seller.example',
      dashboard: 'express',
      identity: { country: 'AU' },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      },
      configuration: {
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
      metadata: { market_id: 'AU', seller_id: 'seller-1' },
    });
    expect(calls[0]?.init.body).not.toContain(KEY);
  });

  it('creates the account for another Market with its own country and metadata', async () => {
    const calls: string[] = [];
    const gateway = new StripeConnectGateway(KEY, (_url, init) => {
      calls.push(init.body ?? '');
      return answer(200, { id: 'acct_test_z9', object: 'v2.core.account' })();
    });
    await gateway.createAccount({
      idempotencyKey: 'connected-account:ZZ:seller-2',
      country: 'JP',
      marketId: 'ZZ',
      sellerId: 'seller-2',
      contactEmail: 'owner@zz.example',
    });
    expect(JSON.parse(calls[0] ?? '')).toMatchObject({
      identity: { country: 'JP' },
      metadata: { market_id: 'ZZ', seller_id: 'seller-2' },
    });
  });

  it('answers a code, not Stripe text, when the v2 create fails or answers no account id', async () => {
    const request = {
      idempotencyKey: 'k',
      country: 'AU',
      marketId: 'AU',
      sellerId: 's',
      contactEmail: 'owner@seller.example',
    };
    expect(
      await new StripeConnectGateway(KEY, answer(400, { error: { message: 'x' } })).createAccount(
        request,
      ),
    ).toEqual({ ok: false, error: { code: 'payment.provider-rejected' } });
    expect(
      await new StripeConnectGateway(KEY, answer(200, { id: 'cus_1' })).createAccount(request),
    ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });
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
        payoutScheduleInterval: 'daily',
        externalAccountCount: 1,
      },
    });
  });

  it('sets the payout schedule through Balance Settings as the connected account, with the idempotency key', async () => {
    const calls: { url: string; init: Parameters<StripeRequest>[1] }[] = [];
    const gateway = new StripeConnectGateway(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, ACCOUNT)();
    });

    expect(await gateway.setPayoutSchedule('acct_test_a1', 'manual', 'payout-pause:c1')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/balance_settings');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'payout-pause:c1',
      'Stripe-Account': 'acct_test_a1',
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.init.body))).toEqual({
      'payments[payouts][schedule][interval]': 'manual',
    });

    expect(
      await new StripeConnectGateway(KEY, answer(500, {})).setPayoutSchedule(
        'acct_test_a1',
        'daily',
        'k',
      ),
    ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable', answered: true } });
    expect(await gateway.setPayoutSchedule('cs_wrong', 'daily', 'k')).toEqual({
      ok: false,
      error: { code: 'payment.provider-rejected' },
    });
    expect(calls).toHaveLength(1);
  });

  it('answers a code without Stripe text for every failure, and never calls with a bad id or no key', async () => {
    const failing = (status: number) =>
      new StripeConnectGateway(KEY, answer(status, { error: 'x' }));
    expect(await failing(500).readAccount('acct_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable', answered: true },
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
    // No answer at all: not marked as answered, so the caller keeps its idempotency key.
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

  it('counts the external accounts only, and a further page as more than one', async () => {
    const read = (external: unknown) =>
      new StripeConnectGateway(KEY, answer(200, { ...ACCOUNT, external_accounts: external }))
        .readAccount('acct_test_a1')
        .then((r) => (r.ok ? r.value.externalAccountCount : 'error'));
    expect(await read({ data: [] })).toBe(0);
    expect(await read({ data: [{}, {}] })).toBe(2);
    expect(await read({ data: [{}], has_more: true })).toBe(2);
    expect(await read(undefined)).toBeNull();
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
