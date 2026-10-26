import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AdminCreditView } from '../src/modules/wallet/application/admin-credit-flow';
import { ApproveAdminCredit } from '../src/modules/wallet/application/use-cases/approve-admin-credit.use-case';
import { IssueAdminCredit } from '../src/modules/wallet/application/use-cases/issue-admin-credit.use-case';
import { ListAdminCreditRequests } from '../src/modules/wallet/application/use-cases/list-admin-credit-requests.use-case';
import { RejectAdminCredit } from '../src/modules/wallet/application/use-cases/reject-admin-credit.use-case';
import { ViewCustomerWallet } from '../src/modules/wallet/application/use-cases/view-customer-wallet.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin credit routes over HTTP (customer wallet package 2a): the real guards and
// controllers, stub use cases. It proves the admin population, CSRF, the admin step-up guard of
// each write (`wallet.credit.issue`, `wallet.credit.approve`), the closed bodies, the amount as a
// minor-unit string in the Market currency, the status of each refusal and `no-store`.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const REQUEST = id<'WalletCreditRequest'>(0xc0de);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('admin credit over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(IssueAdminCredit)
          .useValue(stub('issue'))
          .overrideProvider(ApproveAdminCredit)
          .useValue(stub('approve'))
          .overrideProvider(RejectAdminCredit)
          .useValue(stub('reject'))
          .overrideProvider(ListAdminCreditRequests)
          .useValue(stub('list'))
          .overrideProvider(ViewCustomerWallet)
          .useValue(stub('customer')),
    }));
    for (const [accountId, population, label] of [
      [CUSTOMER, 'customer', 'shopper'],
      [ADMIN, 'admin', 'admin'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }
    fakes.factors.set(ADMIN, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: ADMIN,
      state: 'active',
      secretCiphertext: 'sealed',
      pendingSecretCiphertext: null,
      lastAcceptedStep: null,
      activatedAt: START,
      lockedAt: null,
      createdAt: START,
      recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
        position: index + 1,
        codeHash: new Uint8Array(32).fill(index + 1),
        usedAt: null,
      })),
      version: 1,
    });
  }

  const prove = (action: string) =>
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf102)}|${action}`, clock.now());

  function sessionOf(population: 'customer' | 'admin') {
    const issued = tokens.issue();
    const n = population === 'customer' ? 1 : 2;
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'customer' ? CUSTOMER : ADMIN,
        population,
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const send = (
    method: 'get' | 'post',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
    population: 'admin' | 'customer' = 'admin',
  ) => {
    const req = http()
      [method](path)
      .set({
        'x-market-id': code,
        ...(population === 'admin' ? panelHeaders(code, 'admin') : {}),
        ...headers,
      });
    return payload === undefined ? req : req.send(payload as object);
  };

  const view: AdminCreditView = {
    id: REQUEST,
    customerAccountId: CUSTOMER,
    amount: 6000n,
    currency,
    reasonCode: 'goodwill',
    note: 'parcel lost',
    status: 'pending',
    approvalReason: 'issue-cap',
    requestedBy: ADMIN,
    requestedAt: START,
    expiresAt: START.add({ hours: 168 }),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    journalId: null,
  };
  const issueBody = {
    customerAccountId: CUSTOMER,
    amount: '6000',
    currency,
    reasonCode: 'goodwill',
    note: 'parcel lost',
    idempotencyKey: 'issue-key-0001',
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(view);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('issues with a fresh step-up proof, the amount in minor units of the Market currency', async () => {
    await boot();
    const session = sessionOf('admin');
    const refused = await send('post', '/wallet/admin/credits', session, issueBody);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'wallet.credit.issue' },
    });
    // A proof of the other action does not do.
    prove('wallet.credit.approve');
    expect((await send('post', '/wallet/admin/credits', session, issueBody)).status).toBe(403);
    prove('wallet.credit.issue');
    const created = await send('post', '/wallet/admin/credits', session, issueBody);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body).toEqual({
      id: REQUEST,
      customerAccountId: CUSTOMER,
      amount: '6000',
      currency,
      reasonCode: 'goodwill',
      note: 'parcel lost',
      status: 'pending',
      approvalReason: 'issue-cap',
      requestedBy: ADMIN,
      requestedAt: START.toString(),
      expiresAt: START.add({ hours: 168 }).toString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      journalId: null,
    });
    expect(calls).toEqual([
      {
        name: 'issue',
        input: {
          customerAccountId: CUSTOMER,
          amount: { amount: 6000n, currency },
          reasonCode: 'goodwill',
          note: 'parcel lost',
          idempotencyKey: 'issue-key-0001',
        },
      },
    ]);
    // A malformed amount reaches the use case as missing, which refuses it.
    await send('post', '/wallet/admin/credits', session, { ...issueBody, amount: '-1' });
    expect(calls[1]).toMatchObject({ input: { amount: undefined } });
  });

  it('refuses a write without CSRF, with a stray field, not as JSON, and from a customer', async () => {
    await boot();
    const session = sessionOf('admin');
    prove('wallet.credit.issue');
    expect(
      (await send('post', '/wallet/admin/credits', { cookie: session.cookie }, issueBody)).status,
    ).toBe(403);
    const extra = await send('post', '/wallet/admin/credits', session, {
      ...issueBody,
      source: 'refund',
    });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'source', code: 'unknown-field' }] },
    });
    const text = await http()
      .post('/wallet/admin/credits')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    const shopper = sessionOf('customer');
    const asCustomer = await send('post', '/wallet/admin/credits', shopper, issueBody, 'customer');
    expect([401, 403, 404]).toContain(asCustomer.status);
    expect(calls).toEqual([]);
  });

  it('approves and rejects with a proof of wallet.credit.approve', async () => {
    await boot();
    const session = sessionOf('admin');
    const approvePath = `/wallet/admin/credit-requests/${REQUEST}/approve`;
    const rejectPath = `/wallet/admin/credit-requests/${REQUEST}/reject`;
    prove('wallet.credit.issue');
    const noProof = await send('post', approvePath, session, {});
    expect(noProof.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'wallet.credit.approve' },
    });
    prove('wallet.credit.approve');
    next = ok({ ...view, status: 'approved', decidedBy: ADMIN, decidedAt: START });
    const approved = await send('post', approvePath, session, {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: ADMIN });
    const stray = await send('post', rejectPath, session, { reasonCode: 'duplicate', why: 'x' });
    expect(stray.status).toBe(400);
    next = ok({ ...view, status: 'rejected', decisionReason: 'duplicate' });
    const rejected = await send('post', rejectPath, session, { reasonCode: 'duplicate' });
    expect(rejected.status).toBe(200);
    expect(calls).toEqual([
      { name: 'approve', input: { requestId: REQUEST } },
      { name: 'reject', input: { requestId: REQUEST, reasonCode: 'duplicate' } },
    ]);
  });

  it.each([
    ['wallet.approver-is-requester', 403],
    ['wallet.credit-request-not-found', 404],
    ['wallet.customer-not-found', 404],
    ['wallet.credit-request-decided', 409],
    ['wallet.credit-request-expired', 409],
    ['wallet.cap-exceeded', 409],
    ['wallet.paused', 409],
    ['wallet.frozen', 409],
    ['wallet.account-not-active', 409],
    ['idempotency.key-reused', 409],
    ['wallet.disabled', 404],
    ['wallet.unavailable', 503],
  ])('answers %s with %i', async (refusal, status) => {
    await boot();
    const session = sessionOf('admin');
    prove('wallet.credit.approve');
    next = err({ code: refusal });
    const res = await send('post', `/wallet/admin/credit-requests/${REQUEST}/approve`, session, {});
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ statusCode: status, code: refusal });
  });

  it('reads the request list and a customer summary without a proof', async () => {
    await boot();
    const session = sessionOf('admin');
    next = ok({ entries: [view], nextCursor: 'abc' });
    const list = await send(
      'get',
      '/wallet/admin/credit-requests?status=decided&limit=5&cursor=abc',
      session,
    );
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({
      entries: [{ id: REQUEST, amount: '6000' }],
      nextCursor: 'abc',
    });
    next = ok({
      customerAccountId: CUSTOMER,
      currency,
      marketStatus: 'active',
      accountStatus: 'none',
      available: 0n,
      held: 0n,
      balanceCap: 50000n,
      roomUnderCap: 50000n,
      issueCap: 5000n,
      dailyCap: 50000n,
      usedToday: 1200n,
    });
    const summary = await send('get', `/wallet/admin/customers/${CUSTOMER}`, session);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      customerAccountId: CUSTOMER,
      currency,
      marketStatus: 'active',
      accountStatus: 'none',
      available: '0',
      held: '0',
      balanceCap: '50000',
      roomUnderCap: '50000',
      issueCap: '5000',
      dailyCap: '50000',
      usedToday: '1200',
    });
    expect(calls).toEqual([
      { name: 'list', input: { status: 'decided', cursor: 'abc', limit: 5 } },
      { name: 'customer', input: { customerAccountId: CUSTOMER } },
    ]);
  });
});
