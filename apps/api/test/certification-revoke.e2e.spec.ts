import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CERTIFICATE_REVIEW_REPOSITORY } from '../src/modules/certification/application/ports/review.repository';
import { REVIEW_SELLER_SOURCE } from '../src/modules/certification/application/ports/review.ports';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_VAULT,
} from '../src/modules/certification/application/ports/document-ports';
import { SELLER_ZONES_SOURCE } from '../src/modules/certification/application/ports/tokens';
import { CheckedInReviewPolicy } from '../src/modules/certification/infrastructure/review-policy/checked-in-review-policy';
import { ADMIN_REVIEW_STATUS } from '../src/modules/certification/presentation/admin-certificate-review.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { FakeCipher, MemoryOutbox, MemoryVault, zonesOf } from './support/certification-fakes';
import { FixedReviewSellers, MemoryReviews } from './support/certification-review-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The revoke and full history routes over HTTP (certification slice 11; AC 16, AC 22): the real
// guards, CSRF, closed bodies, controller, gate with the real role seed, use cases and Market
// policies; identity's ports, the review store and the cipher as in-memory fakes. Proved here:
// both keys are protected (no default role reaches either route; a custom role does), the
// status of each refusal, `no-store` on the history, and the walk from revoke to the history.

const START = Temporal.Instant.from('2026-10-17T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const REVIEWER = id<'Account'>(0xa301);
const REVOKER = id<'Account'>(0xa302);
const APPROVER = id<'Account'>(0xa303);
const SELLER_OWNER = id<'Account'>(0xa304);
const SELLER = id<'Seller'>(0xb030);
const TYPE = id<'CertificationType'>(0xc301);
const CERTIFICATE = id<'SellerCertification'>(0xe311);
const SUBMISSION = id<'Submission'>(0xe411);
const REVOKER_ROLE = id<'Role'>(0xf311);
const APPROVER_ROLE = id<'Role'>(0xf312);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const policies = new CheckedInReviewPolicy();

// Each test boots the whole application; under a loaded runner that alone can pass the default 5 s.
jest.setTimeout(30_000);

describe('certificate revoke and full history over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let reviews: MemoryReviews;
  let outbox: MemoryOutbox;
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
          .overrideProvider(OUTBOX_WRITER)
          .useValue(outbox)
          .overrideProvider(CERTIFICATE_REVIEW_REPOSITORY)
          .useValue(reviews)
          .overrideProvider(REVIEW_SELLER_SOURCE)
          .useValue(new FixedReviewSellers())
          .overrideProvider(DOCUMENT_VAULT)
          .useValue(new MemoryVault())
          .overrideProvider(CERTIFICATE_FIELD_CIPHER)
          .useValue(new FakeCipher())
          .overrideProvider(SELLER_ZONES_SOURCE)
          .useValue(
            zonesOf({
              [SELLER]: { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' },
            }),
          ),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  function approvedRecord(code: string): MemoryReviews {
    return new MemoryReviews(
      code,
      {
        id: CERTIFICATE,
        sellerId: SELLER,
        typeId: TYPE,
        typeCode: 'halal',
        status: 'approved',
        pendingSubmissionId: null,
        pendingKind: null,
        approvedSubmissionId: SUBMISSION,
        approvedBoundaryAt: Temporal.Instant.from('2028-01-01T14:00:00Z'),
        approvedIssuerState: 'active',
        issuerRequestOpen: false,
        latestOutcome: 'approved',
        submissionCount: 1,
        statusChangedAt: START,
        lastChangedAt: START,
        createdAt: START,
        version: 4,
        draft: {
          issuerId: null,
          certificateNumberCiphertext: null,
          issueDate: null,
          expiryDate: null,
          selfDeclared: null,
          selfDeclarationNoteCiphertext: null,
        },
      },
      {
        id: SUBMISSION,
        submissionNo: 1,
        kind: 'initial',
        typeRevisionId: id<'CertificationTypeRevision'>(0xc311),
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
        issuer: null,
        certificateNumberCiphertext: null,
        issueDate: Temporal.PlainDate.from('2026-01-01'),
        expiryDate: Temporal.PlainDate.from('2028-01-01'),
        selfDeclared: null,
        selfDeclarationNoteCiphertext: null,
        submittedZone: 'Australia/Brisbane',
        submittedAt: START,
        documents: [],
        checks: [],
        scope: null,
        confirmation: null,
        decision: null,
      },
    );
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'revoke-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    const custom = (roleId: Id<'Role'>, name: string, permissionKeys: string[]) =>
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
    // Both slice 11 keys are protected: only a custom role granted by an administrator holds them.
    custom(REVOKER_ROLE, 'Certificate revoker', [
      'certification.seller-certificate.view',
      'certification.seller-certificate.revoke',
      'certification.document.view',
    ]);
    // The decision key does not include revoke.
    custom(APPROVER_ROLE, 'Certificate approver', [
      'certification.seller-certificate.view',
      'certification.seller-certificate.review',
      'certification.seller-certificate.approve',
    ]);
    let n = 0;
    const account = (
      accountId: Id<'Account'>,
      label: string,
      population: 'admin' | 'seller',
      roleId: Id<'Role'>,
    ) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe950 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(REVIEWER, 'reviewer', 'admin', roleOf('certification-reviewer'));
    account(REVOKER, 'revoker', 'admin', REVOKER_ROLE);
    account(APPROVER, 'approver', 'admin', APPROVER_ROLE);
    account(
      SELLER_OWNER,
      'owner',
      'seller',
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
      )!.id,
    );
  }

  function sessionOf(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'seller' = 'admin',
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf600 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? SELLER : null,
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

  const base = '/certification/admin/seller-certificates';
  const headers = (code: string, extra: Record<string, string> = {}) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'admin'),
    ...extra,
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    outbox = new MemoryOutbox();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the revoke refusals to their status', () => {
    expect(ADMIN_REVIEW_STATUS).toMatchObject({
      'certificate.revoked': 409,
      'certificate.not-revocable': 409,
      'conflict.stale': 409,
      'certificate.not-found': 404,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const reasonCode = () =>
      policies.policyFor(marketOf(code)).reasons.find((r) => r.outcomes.includes('revoked'))!.code;

    it('refuses both routes to every default role and to the approver: the keys are protected', async () => {
      reviews = approvedRecord(code);
      await boot();
      await seeded(code);
      for (const [account, n] of [
        [REVIEWER, 1],
        [APPROVER, 2],
      ] as const) {
        const h = headers(code, sessionOf(code, account, n));
        const revoke = await http()
          .post(`${base}/${CERTIFICATE}/revoke`)
          .set(h)
          .send({ version: 4, reasonCode: reasonCode() })
          .expect(403);
        expect((revoke.body as { code: string }).code).toBe('access.denied');
        const history = await http().get(`${base}/${CERTIFICATE}/history`).set(h).expect(403);
        expect((history.body as { code: string }).code).toBe('access.denied');
      }
      expect(reviews.certificate.status).toBe('approved');
    });

    it('treats a seller session on the admin route as not signed in', async () => {
      reviews = approvedRecord(code);
      await boot();
      await seeded(code);
      const seller = sessionOf(code, SELLER_OWNER, 3, 'seller');
      const refused = await http()
        .post(`${base}/${CERTIFICATE}/revoke`)
        .set(headers(code, seller))
        .send({ version: 4, reasonCode: reasonCode() });
      // The seller cookie is not an admin session: the admin route sees nobody signed in.
      expect(refused.status).toBe(401);
      expect((refused.body as { code: string }).code).toBe('access.unauthenticated');
      expect(reviews.certificate.status).toBe('approved');
    });

    it('revokes with a reason, then shows it in the history; refuses no CSRF, a bad body, a stale or second revoke', async () => {
      reviews = approvedRecord(code);
      await boot();
      await seeded(code);
      const session = sessionOf(code, REVOKER, 4);
      const h = headers(code, session);
      const revoke = (body: unknown, set: Record<string, string> = h) =>
        http()
          .post(`${base}/${CERTIFICATE}/revoke`)
          .set(set)
          .send(body as object);

      const noCsrf: Record<string, string> = { ...h };
      delete noCsrf['x-csrf-token'];
      await revoke({ version: 4, reasonCode: reasonCode() }, noCsrf).expect(403);
      const missing = await revoke({ version: 4 }).expect(400);
      expect(missing.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reasonCode', code: 'required' }] },
      });
      await revoke({ version: 4, reasonCode: reasonCode(), status: 'approved' }).expect(400);
      const unknown = await revoke({ version: 4, reasonCode: 'no-such-reason' }).expect(400);
      expect(unknown.body).toMatchObject({
        details: { fields: [{ path: 'reasonCode', code: 'unknown' }] },
      });
      const stale = await revoke({ version: 3, reasonCode: reasonCode() }).expect(409);
      expect((stale.body as { code: string }).code).toBe('conflict.stale');
      expect(reviews.certificate.status).toBe('approved');

      const done = await revoke({
        version: 4,
        reasonCode: reasonCode(),
        reasonText: 'Confirmed with the issuer by phone.',
      }).expect(200);
      expect(done.body).toEqual({
        certificateId: CERTIFICATE,
        status: 'revoked',
        submissionId: SUBMISSION,
        withdrawnSubmissionId: null,
        version: 5,
        revokedAt: START.toString(),
      });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-revoked.v1',
      ]);
      const again = await revoke({ version: 5, reasonCode: reasonCode() }).expect(409);
      expect((again.body as { code: string }).code).toBe('certificate.revoked');

      const history = await http().get(`${base}/${CERTIFICATE}/history`).set(h).expect(200);
      expect(history.headers['cache-control']).toContain('no-store');
      expect(history.body).toMatchObject({
        certificateId: CERTIFICATE,
        sellerId: SELLER,
        entries: [
          {
            fromStatus: 'approved',
            toStatus: 'revoked',
            actorKind: 'admin',
            actorAccountId: REVOKER,
            reasonCode: reasonCode(),
            note: 'Confirmed with the issuer by phone.',
          },
        ],
        nextBeforeId: null,
      });
      await http().get(`${base}/${CERTIFICATE}/history?limit=0`).set(h).expect(400);
      await http()
        .get(`${base}/${id<'SellerCertification'>(0xe399)}/history`)
        .set(h)
        .expect(404);
    });
  });
});
