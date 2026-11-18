import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import type {
  RequestView,
  SystemRequestsFailure,
} from '../src/modules/system-requests/application/request-flow';
import { ApproveMatchingSystemRequests } from '../src/modules/system-requests/application/use-cases/approve-matching-system-requests.use-case';
import { ApproveSystemRequest } from '../src/modules/system-requests/application/use-cases/approve-system-request.use-case';
import { ApproveSystemRequests } from '../src/modules/system-requests/application/use-cases/approve-system-requests.use-case';
import { ChangeAreaReviewPolicy } from '../src/modules/system-requests/application/use-cases/change-area-review-policy.use-case';
import { ChangeReviewDueDays } from '../src/modules/system-requests/application/use-cases/change-review-due-days.use-case';
import { CommentOnSystemRequest } from '../src/modules/system-requests/application/use-cases/comment-on-system-request.use-case';
import { CountSystemRequests } from '../src/modules/system-requests/application/use-cases/count-system-requests.use-case';
import { ListSystemRequests } from '../src/modules/system-requests/application/use-cases/list-system-requests.use-case';
import { RejectSystemRequest } from '../src/modules/system-requests/application/use-cases/reject-system-request.use-case';
import { ViewReviewPolicy } from '../src/modules/system-requests/application/use-cases/view-review-policy.use-case';
import { ViewSystemRequest } from '../src/modules/system-requests/application/use-cases/view-system-request.use-case';
import { WithdrawSystemRequest } from '../src/modules/system-requests/application/use-cases/withdraw-system-request.use-case';
import { SYSTEM_REQUESTS_STATUS } from '../src/modules/system-requests/presentation/http-answers';
import { ACCESS_DENIED_STATUS } from '../src/platform/authz';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The System requests routes over HTTP: the real guards and controller, stub use cases. It proves
// the admin population, CSRF on writes, the step-up guard of the policy writes, the closed JSON
// bodies, the route shapes (bulk-approve beside :requestId, requests-count beside requests/:id),
// the status of every refusal, details (actionKey, newerRequestId, fields) and `no-store`.

const START = Temporal.Instant.from('2026-11-15T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const AUTHOR = id<'Account'>(0xa002);
const CUSTOMER = id<'Account'>(0xa101);
const REQUEST = id<'SystemRequest'>(0x5e01);
const NEWER = id<'SystemRequest'>(0x5e02);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

/** Every code a system-requests use case answers, with its status. */
const EXPECTED: Readonly<Record<SystemRequestsFailure['code'], number>> = {
  'access.denied': 403,
  'access.unavailable': 503,
  'validation.failed': 400,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  'system-requests.not-found': 404,
  'system-requests.decided': 409,
  'system-requests.own-request': 403,
  'system-requests.own-subject': 403,
  'system-requests.not-author': 403,
  'system-requests.not-reviewer': 403,
  'system-requests.changed-since': 409,
  'system-requests.subject-gone': 409,
  'system-requests.revert-unavailable': 503,
  'system-requests.revert-not-permitted': 403,
  'system-requests.not-low-risk': 409,
  'system-requests.one-by-one': 409,
  'system-requests.policy-conflict': 409,
};

describe('the HTTP status of every system-requests refusal', () => {
  it.each(Object.entries(EXPECTED))('%s answers %i', (code, status) => {
    const mapped =
      SYSTEM_REQUESTS_STATUS[code] ??
      (ACCESS_DENIED_STATUS as Readonly<Record<string, number>>)[code];
    expect(mapped).toBe(status);
  });

  it('maps no code that no use case answers', () => {
    expect(Object.keys(SYSTEM_REQUESTS_STATUS).filter((code) => !(code in EXPECTED))).toEqual([]);
  });
});

describe.each(TEST_MARKETS)('system requests over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
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
          .overrideProvider(ListSystemRequests)
          .useValue(stub('list'))
          .overrideProvider(CountSystemRequests)
          .useValue(stub('count'))
          .overrideProvider(ViewSystemRequest)
          .useValue(stub('view'))
          .overrideProvider(CommentOnSystemRequest)
          .useValue(stub('comment'))
          .overrideProvider(ApproveSystemRequest)
          .useValue(stub('approve'))
          .overrideProvider(ApproveSystemRequests)
          .useValue(stub('bulk'))
          .overrideProvider(ApproveMatchingSystemRequests)
          .useValue(stub('matching'))
          .overrideProvider(RejectSystemRequest)
          .useValue(stub('reject'))
          .overrideProvider(WithdrawSystemRequest)
          .useValue(stub('withdraw'))
          .overrideProvider(ViewReviewPolicy)
          .useValue(stub('policy'))
          .overrideProvider(ChangeAreaReviewPolicy)
          .useValue(stub('area'))
          .overrideProvider(ChangeReviewDueDays)
          .useValue(stub('days')),
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
    method: 'get' | 'post' | 'put',
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

  const view: RequestView = {
    id: REQUEST,
    number: 12,
    area: 'catalogue',
    subjectKind: 'settings.market-setting',
    subjectRef: 'list-paging',
    mode: 'review',
    risk: 'medium',
    status: 'open',
    before: { size: 25 },
    after: { size: 50 },
    note: 'Raise the limit',
    requestedBy: AUTHOR,
    appliedAt: START,
    reviewDueAt: START.add({ hours: 168 }),
    decision: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    supersededBy: null,
    commentCount: 0,
    overdue: false,
    requestedByName: 'Maryam K.',
    decidedByName: null,
    subjectLabel: 'List paging',
    supersededByNumber: null,
    reviewPermission: 'system-requests.catalogue.review',
    actions: ['open', 'copy-link', 'approve', 'reject'],
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

  it('lists with the query as given, no-store, and refuses a customer', async () => {
    await boot();
    const session = sessionOf('admin');
    next = ok({
      rows: [view],
      counts: {
        'needs-my-review': 1,
        'all-open': 1,
        mine: 0,
        approved: 0,
        reverted: 0,
        overdue: 0,
        all: 1,
      },
      total: 1,
      page: 1,
      pageSize: 25,
      nextCursor: null,
    });
    const listed = await send('get', '/system-requests/admin/requests?view=all&page=1', session);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toMatchObject({
      rows: [
        {
          id: REQUEST,
          displayNumber: 'SR-12',
          appliedAt: START.toString(),
          requestedByName: 'Maryam K.',
          decidedByName: null,
          subjectLabel: 'List paging',
          supersededByNumber: null,
        },
      ],
      total: 1,
    });
    expect(calls).toEqual([{ name: 'list', input: { view: 'all', page: '1' } }]);
    // A customer session is no admin session: a write is refused before any use case runs.
    const shopper = sessionOf('customer');
    const asCustomer = await send(
      'post',
      `/system-requests/admin/requests/${REQUEST}/approve`,
      shopper,
      {},
      'customer',
    );
    expect([401, 403, 404]).toContain(asCustomer.status);
    expect(calls).toHaveLength(1);
  });

  it('routes the badge count and the detail apart', async () => {
    await boot();
    const session = sessionOf('admin');
    next = ok({ needsMyReview: 3, overdue: 1 });
    const badge = await send('get', '/system-requests/admin/requests-count', session);
    expect(badge.status).toBe(200);
    expect(badge.body).toEqual({ needsMyReview: 3, overdue: 1 });
    next = ok({
      ...view,
      supersededBy: NEWER,
      supersededByNumber: 13,
      activity: [
        {
          id: id<'SystemRequestActivity'>(0x7e01),
          kind: 'applied',
          actor: AUTHOR,
          actorName: 'Maryam K.',
          at: START,
          body: null,
        },
      ],
    });
    const detail = await send('get', `/system-requests/admin/requests/${REQUEST}`, session);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      supersededBy: NEWER,
      supersededByNumber: 13,
      subjectLabel: 'List paging',
      activity: [{ actor: AUTHOR, actorName: 'Maryam K.', at: START.toString() }],
    });
    expect(calls.map((call) => call.name)).toEqual(['count', 'view']);
  });

  it('approves one, and bulk-approves through its own route', async () => {
    await boot();
    const session = sessionOf('admin');
    next = ok({
      ...view,
      status: 'approved',
      decision: 'approved',
      decidedBy: ADMIN,
      decidedAt: START,
    });
    const approved = await send(
      'post',
      `/system-requests/admin/requests/${REQUEST}/approve`,
      session,
      {},
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedAt: START.toString() });
    next = ok([{ requestId: REQUEST, outcome: 'approved' }]);
    const bulk = await send('post', '/system-requests/admin/requests/bulk-approve', session, {
      requestIds: [REQUEST],
    });
    expect(bulk.status).toBe(200);
    expect(calls).toEqual([
      { name: 'approve', input: { requestId: REQUEST } },
      { name: 'bulk', input: { requestIds: [REQUEST] } },
    ]);
  });

  it('approves all matching through its own route, with the list filter as the body', async () => {
    await boot();
    const session = sessionOf('admin');
    next = ok({
      approved: [{ id: REQUEST, number: 12 }],
      failed: [{ id: NEWER, code: 'system-requests.decided' }],
      remaining: 4,
    });
    const filter = { view: 'needs-my-review', q: 'paging', risk: 'low', area: 'marketplace' };
    const path = '/system-requests/admin/requests/bulk-approve-matching';
    const matched = await send('post', path, session, filter);
    expect(matched.status).toBe(200);
    expect(matched.headers['cache-control']).toBe('no-store');
    expect(matched.body).toEqual({
      approved: [{ id: REQUEST, number: 12, displayNumber: 'SR-12' }],
      failed: [{ id: NEWER, code: 'system-requests.decided' }],
      remaining: 4,
    });
    expect(calls).toEqual([{ name: 'matching', input: filter }]);
    // A count that failed after the approvals committed is null: the panel stops.
    next = ok({ approved: [{ id: REQUEST, number: 12 }], failed: [], remaining: null });
    const uncounted = await send('post', path, session, filter);
    expect(uncounted.status).toBe(200);
    expect(uncounted.body).toMatchObject({ remaining: null });
    calls.length = 0;
    // Paging and sort are not part of what matches; no CSRF is no write.
    const paged = await send('post', path, session, { view: 'all', page: '2' });
    expect(paged.status).toBe(400);
    expect(paged.body).toMatchObject({
      details: { fields: [{ path: 'page', code: 'unknown-field' }] },
    });
    expect((await send('post', path, { cookie: session.cookie }, {})).status).toBe(403);
    next = err({ code: 'access.denied' });
    expect((await send('post', path, session, {})).status).toBe(403);
    expect(calls.map((call) => call.name)).toEqual(['matching']);
  });

  it('refuses a write without CSRF, with a stray field, or not as JSON', async () => {
    await boot();
    const session = sessionOf('admin');
    const path = `/system-requests/admin/requests/${REQUEST}/reject`;
    expect((await send('post', path, { cookie: session.cookie }, { reason: 'x' })).status).toBe(
      403,
    );
    const stray = await send('post', path, session, { reason: 'x', revert: false });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      code: 'validation.failed',
      details: { fields: [{ path: 'revert', code: 'unknown-field' }] },
    });
    const text = await http()
      .post(path)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it.each([
    [{ code: 'system-requests.own-request' }, 403, undefined],
    [{ code: 'system-requests.not-reviewer' }, 403, undefined],
    [{ code: 'system-requests.not-found' }, 404, undefined],
    [{ code: 'system-requests.decided' }, 409, undefined],
    [
      { code: 'system-requests.changed-since', newerRequestId: NEWER },
      409,
      { newerRequestId: NEWER },
    ],
    [
      { code: 'system-requests.changed-since', newerRequestId: null },
      409,
      { newerRequestId: null },
    ],
    [{ code: 'system-requests.subject-gone' }, 409, undefined],
    [{ code: 'system-requests.revert-unavailable' }, 503, undefined],
    [{ code: 'system-requests.revert-not-permitted' }, 403, undefined],
    [
      { code: 'second-factor.required', actionKey: 'system-requests.request.decide-high' },
      403,
      { actionKey: 'system-requests.request.decide-high' },
    ],
    [
      { code: 'validation.failed', fields: [{ path: 'reason', code: 'length' }] },
      400,
      { fields: [{ path: 'reason', code: 'length' }] },
    ],
    [{ code: 'something.unmapped' }, 500, undefined],
  ] as const)('answers a reject refused with %o as %i', async (error, status, details) => {
    await boot();
    const session = sessionOf('admin');
    next = err(error);
    const answer = await send(
      'post',
      `/system-requests/admin/requests/${REQUEST}/reject`,
      session,
      { reason: 'No' },
    );
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({
      statusCode: status,
      code: status === 500 ? 'internal' : error.code,
      ...(details === undefined ? {} : { details }),
    });
  });

  it('needs a fresh proof of system-requests.policy.change for each policy write', async () => {
    await boot();
    const session = sessionOf('admin');
    const areaPath = '/system-requests/admin/review-policy/areas/content';
    const body = { enabled: true, risk: 'low', expectedVersion: 0, note: 'Review pages' };
    const refused = await send('put', areaPath, session, body);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'system-requests.policy.change' },
    });
    prove('system-requests.request.decide-high');
    expect((await send('put', areaPath, session, body)).status).toBe(403);
    prove('system-requests.policy.change');
    next = ok({
      value: {
        area: 'content',
        enabled: true,
        risk: 'low',
        reviewPermission: 'system-requests.content.review',
        version: 1,
        updatedAt: START,
        updatedBy: ADMIN,
        updatedByName: 'Ali R.',
      },
      request: { id: REQUEST, number: 12, risk: 'high', reviewDueAt: START.add({ hours: 168 }) },
    });
    const changed = await send('put', areaPath, session, body);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ value: { updatedBy: ADMIN, updatedByName: 'Ali R.' } });
    expect(calls).toEqual([{ name: 'area', input: { area: 'content', ...body } }]);
    // The guard asks for a fresh proof; spending it is the use case's (unit spec), so the
    // still unspent proof lets the due-days write through to its use case here.
    next = ok({
      value: {
        reviewDueDays: 3,
        version: 1,
        updatedAt: START,
        updatedBy: ADMIN,
        updatedByName: null,
      },
      request: null,
    });
    const days = await send(
      'put',
      '/system-requests/admin/review-policy/review-due-days',
      session,
      {
        reviewDueDays: 3,
        expectedVersion: 0,
        note: 'Faster',
      },
    );
    expect(days.status).toBe(200);
    expect(days.body).toMatchObject({ value: { updatedByName: null } });
    expect(calls.map((call) => call.name)).toEqual(['area', 'days']);
  });
});
