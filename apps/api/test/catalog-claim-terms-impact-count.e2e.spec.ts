import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  CLAIM_TERMS_CANDIDATE_MATCHER,
  type CandidateMatchFailure,
} from '../src/modules/catalog/application/ports/claim-terms-candidate-matcher';
import { CLAIM_TEXT_IMPACT_READER } from '../src/modules/catalog/application/ports/claim-text-impact.reader';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { CLAIM_TERMS_IMPACT_COUNT_STATUS } from '../src/modules/catalog/presentation/claim-terms-impact-count.controller';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// `claim-terms.impact-count` over HTTP (catalog design 6.5, request C-7): the real guards,
// controller, gate and use case, with identity's ports, the reader, the matcher and the rate
// counters as in-memory fakes. Proved: the admin session, CSRF, the key from certification
// (a protected key no default role holds), the closed body, the answer shape and the status of
// each refusal, including "unavailable" for a matcher that cannot answer.

const START = Temporal.Instant.from('2026-11-22T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const HOLDER = id<'Account'>(0xa101);
const NO_KEY = id<'Account'>(0xa102);
const HOLDER_ROLE = id<'Role'>(0xc101);
const NO_KEY_ROLE = id<'Role'>(0xc102);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps the refusal codes of the count to their statuses', () => {
  expect(CLAIM_TERMS_IMPACT_COUNT_STATUS).toEqual({
    'validation.failed': 400,
    'access.denied': 403,
    'request.throttled': 429,
    'access.unavailable': 503,
    'claim-text.check-unavailable': 503,
  });
});

describe('claim-terms impact count over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let matcherFails: CandidateMatchFailure | null;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue({
            reserve: (_m: unknown, wanted: readonly { limit: { kind: string } }[], now: unknown) =>
              Promise.resolve(
                wanted.map((c) => ({ kind: c.limit.kind, count: 1, windowStartedAt: now })),
              ),
            purgeStartedBefore: () => Promise.resolve(0),
          })
          .overrideProvider(CLAIM_TEXT_IMPACT_READER)
          .useValue({
            page: (_m: unknown, query: { kind: string }) =>
              Promise.resolve({
                rows:
                  query.kind === 'product'
                    ? [
                        { id: 'p1', texts: [{ locale: 'en', text: 'zorbex oats' }] },
                        { id: 'p2', texts: [{ locale: 'en', text: 'plain' }] },
                      ]
                    : [{ id: 'o1', texts: [{ locale: 'en', text: 'ZORBEX' }] }],
                nextAfterId: null,
              }),
          })
          .overrideProvider(CLAIM_TERMS_CANDIDATE_MATCHER)
          .useValue({
            matches: (_c: unknown, _cand: unknown, texts: { text: string }[]) =>
              Promise.resolve(
                matcherFails === null
                  ? ok(texts.map((t) => t.text.toLowerCase().includes('zorbex')))
                  : err(matcherFails),
              ),
          }),
    }));
  }

  function seeded(code: string) {
    const marketId = code as AccountState['marketId'];
    const role = (roleId: Id<'Role'>, name: string, permissionKeys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys,
        version: 1,
        createdAt: START,
      });
    role(HOLDER_ROLE, 'Type editor', ['certification.type.edit']);
    role(NO_KEY_ROLE, 'No key', ['identity.admin-account.view']);
    [
      [HOLDER, 'holder', HOLDER_ROLE, 1],
      [NO_KEY, 'nokey', NO_KEY_ROLE, 2],
    ].forEach(([accountId, label, roleId, n]) => {
      fakes.seedAccount({
        id: accountId as Id<'Account'>,
        marketId,
        population: 'admin',
        email: {
          typed: `${label as string}@Example.com`,
          normalized: `${label as string}@example.com`,
        },
        displayName: `Name ${label as string}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe100 + (n as number)),
        marketId,
        accountId: accountId as Id<'Account'>,
        roleId: roleId as Id<'Role'>,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    });
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      { marketId: code, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf200 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const count = (
    code: string,
    body: unknown,
    session: Record<string, string> | null,
    withCsrf = true,
  ) =>
    http()
      .post('/catalog/admin/claim-terms/impact-count')
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      })
      .send(body as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    matcherFails = null;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses = document.paths['/catalog/admin/claim-terms/impact-count']?.post?.responses;
    for (const status of ['200', '400', '401', '403', '429', '503']) {
      expect(responses).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const body = { typeCode: 'zorbex', termsByLocale: { en: ['zorbex'] } };

    it('counts published products and Offers for the key holder, no-store', async () => {
      await boot();
      seeded(code);
      const response = await count(code, body, sessionOf(code, HOLDER, 1));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ products: 1, offers: 1, total: 2, complete: true });
    });

    it('answers 503 claim-text.check-unavailable, never a zero, when the matcher cannot answer', async () => {
      await boot();
      seeded(code);
      matcherFails = { code: 'claim-text.check-unavailable' };
      const response = await count(code, body, sessionOf(code, HOLDER, 1));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'claim-text.check-unavailable' });
      expect(response.body).not.toHaveProperty('total');
    });

    it('answers 400 for a refused term list with its field paths, and for a malformed body', async () => {
      await boot();
      seeded(code);
      matcherFails = {
        code: 'validation.failed',
        fields: [{ path: 'termsByLocale.en', code: 'unmatchable' }],
      };
      const refused = await count(code, body, sessionOf(code, HOLDER, 1));
      expect(refused.status).toBe(400);
      expect((refused.body as { details: { fields: unknown } }).details.fields).toEqual([
        { path: 'termsByLocale.en', code: 'unmatchable' },
      ]);
      matcherFails = null;
      expect((await count(code, { nope: 1 }, sessionOf(code, HOLDER, 1))).status).toBe(400);
    });

    it('answers 401 without a session, 403 without the key or the CSRF token', async () => {
      await boot();
      seeded(code);
      expect((await count(code, body, null)).status).toBe(401);
      expect((await count(code, body, sessionOf(code, NO_KEY, 2))).status).toBe(403);
      expect((await count(code, body, sessionOf(code, HOLDER, 1), false)).status).toBe(403);
    });
  });
});
