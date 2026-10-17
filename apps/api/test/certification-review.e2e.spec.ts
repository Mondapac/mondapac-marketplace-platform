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
import { checkCodesFor } from '../src/modules/certification/domain/review';
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

// The admin review routes over HTTP (certification slice 7): the real guards, CSRF, closed
// bodies, controller, gate with the real role seed, use cases and Market policies; identity's
// ports, the review store, the cipher and the vault as in-memory fakes. Proved here: who may do
// what (the reviewer cannot approve; the protected key comes only through a custom role; a
// viewer sees the queue but not a page; a seller or a visitor sees nothing), the status of each
// refusal, the headers of a served file and the whole path from the queue to an approval.

const START = Temporal.Instant.from('2026-10-17T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const REVIEWER = id<'Account'>(0xa201);
const APPROVER = id<'Account'>(0xa202);
const VIEWER = id<'Account'>(0xa203);
const SELLER_OWNER = id<'Account'>(0xa204);
const SELLER = id<'Seller'>(0xb020);
const TYPE = id<'CertificationType'>(0xc101);
const ISSUER = id<'Issuer'>(0xd101);
const CHANNEL = id<'IssuerContactChannel'>(0xd201);
const CERTIFICATE = id<'SellerCertification'>(0xe301);
const SUBMISSION = id<'Submission'>(0xe401);
const DOCUMENT = id<'UploadedDocument'>(0xe501);
const APPROVER_ROLE = id<'Role'>(0xf301);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const policies = new CheckedInReviewPolicy();

describe('admin certificate review over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let reviews: MemoryReviews;
  let outbox: MemoryOutbox;
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
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
          .useValue(vaultWithFile())
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

  function vaultWithFile(): MemoryVault {
    const vault = new MemoryVault();
    vault.objects.set('obj-1', Buffer.from('%PDF-1.4 clean'));
    return vault;
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  function makeReviews(code: string): MemoryReviews {
    return new MemoryReviews(
      code,
      {
        id: CERTIFICATE,
        sellerId: SELLER,
        typeId: TYPE,
        typeCode: 'halal',
        status: 'in-review',
        pendingSubmissionId: SUBMISSION,
        pendingKind: 'initial',
        approvedSubmissionId: null,
        approvedBoundaryAt: null,
        approvedIssuerState: null,
        issuerRequestOpen: false,
        latestOutcome: null,
        submissionCount: 1,
        statusChangedAt: START,
        lastChangedAt: START,
        createdAt: START,
        version: 3,
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
        typeRevisionId: id<'CertificationTypeRevision'>(0xc201),
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
        issuer: {
          id: ISSUER,
          typeId: TYPE,
          displayName: 'Halal Authority',
          state: 'active',
          channels: [
            { id: CHANNEL, kind: 'web-page', value: 'https://example.test', retired: false },
          ],
        },
        certificateNumberCiphertext: `v1.${Buffer.from('submission-certificate-number|HC-1234').toString('base64url')}`,
        issueDate: Temporal.PlainDate.from('2026-01-01'),
        expiryDate: Temporal.PlainDate.from('2028-01-01'),
        selfDeclared: null,
        selfDeclarationNoteCiphertext: null,
        submittedZone: 'Australia/Brisbane',
        submittedAt: Temporal.Instant.from('2026-10-16T01:00:00Z'),
        documents: [
          {
            id: DOCUMENT,
            position: 1,
            mediaType: 'application/pdf',
            byteSize: 14,
            pageCount: 1,
            createdAt: START,
            objectKey: 'obj-1',
            dataKeyEnvelope: 'v1.x',
            cleanSha256: Buffer.alloc(32),
            submitted: true,
            purpose: 'seller-certificate',
          },
        ],
        checks: [],
        scope: null,
        confirmation: null,
        decision: null,
      },
    );
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'review-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    // The approve key is protected: no default role holds it, a custom role does.
    fakes.seedRole({
      id: APPROVER_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Certificate approver',
      permissionKeys: [
        'certification.seller-certificate.view',
        'certification.seller-certificate.review',
        'certification.seller-certificate.approve',
        'sellers.seller.view',
        'sellers.business-details.view',
      ],
      version: 1,
      createdAt: START,
    });
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
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(REVIEWER, 'reviewer', 'admin', roleOf('certification-reviewer'));
    account(APPROVER, 'approver', 'admin', APPROVER_ROLE);
    account(VIEWER, 'viewer', 'admin', roleOf('viewer'));
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
        id: id<'Session'>(0xf500 + n),
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
  const headers = (code: string, extra: Record<string, string> = {}, population = 'admin') => ({
    'x-market-id': code,
    ...panelHeaders(code, population as 'admin'),
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

  it('maps every refusal of the routes to its status', () => {
    expect(ADMIN_REVIEW_STATUS).toMatchObject({
      'validation.failed': 400,
      'certificate.not-found': 404,
      'document.not-found': 404,
      'document.download-disabled': 403,
      'review.not-current-submission': 409,
      'confirmation.exists': 409,
      'conflict.stale': 409,
      'review.checks-incomplete': 422,
      'review.scope-missing': 422,
      'issuer.not-active': 422,
      'certificate.expired': 422,
      'seller.zone-missing': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const required = (): string[] =>
      checkCodesFor(policies.policyFor(marketOf(code)), 'THIRD_PARTY_DOCUMENT')
        .filter((c) => c.required)
        .map((c) => c.code);

    it('lets a reviewer work the queue and a page, but not approve', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code, REVIEWER, 1));

      const queue = await http().get(base).set(h).expect(200);
      expect(queue.headers['cache-control']).toContain('no-store');
      expect(queue.body).toMatchObject({
        total: 1,
        items: [{ certificateId: CERTIFICATE, submissionId: SUBMISSION, version: 3 }],
      });
      expect(JSON.stringify(queue.body)).not.toContain('HC-1234');

      const page = await http().get(`${base}/${CERTIFICATE}`).set(h).expect(200);
      expect(page.headers['cache-control']).toContain('no-store');
      expect(page.body).toMatchObject({
        submission: { certificateNumber: 'HC-1234' },
        certificate: { version: 3 },
      });

      // All three decisions need the protected key, which no default role holds.
      for (const route of ['approve', 'request-changes', 'decline']) {
        const refused = await http()
          .post(`${base}/${CERTIFICATE}/${route}`)
          .set(h)
          .send(
            route === 'approve'
              ? { submissionId: SUBMISSION, version: 3 }
              : { submissionId: SUBMISSION, version: 3, reasonCode: 'unreadable' },
          )
          .expect(403);
        expect((refused.body as { code: string }).code).toBe('access.denied');
      }
      expect(reviews.certificate.status).toBe('in-review');
    });

    it('walks the checks, the scope and the confirmation to an approval by the approver', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code, APPROVER, 2));
      const post = (path: string, body: unknown) =>
        http()
          .post(`${base}/${CERTIFICATE}/${path}`)
          .set(h)
          .send(body as object);

      const early = await post('approve', { submissionId: SUBMISSION, version: 3 }).expect(422);
      expect(early.body).toMatchObject({
        code: 'review.checks-incomplete',
        details: {
          fields: expect.arrayContaining([{ path: required()[0], code: 'not-done' }]) as unknown,
        },
      });

      for (const checkCode of required()) {
        await post('checks', { submissionId: SUBMISSION, checkCode, result: 'done' }).expect(201);
      }
      const noScope = await post('approve', { submissionId: SUBMISSION, version: 3 }).expect(422);
      expect((noScope.body as { code: string }).code).toBe('review.scope-missing');
      await post('scope', {
        submissionId: SUBMISSION,
        location: 'Brisbane QLD',
        scope: 'Beef products',
      }).expect(201);

      const confirmed = await post('issuer-confirmation', {
        submissionId: SUBMISSION,
        channelId: CHANNEL,
        confirmedOn: '2026-10-16',
        reference: 'Phone call',
        confirmsNumber: true,
        confirmsHolder: true,
      }).expect(201);
      expect(confirmed.body).toMatchObject({ version: 4 });
      await post('issuer-confirmation', {
        submissionId: SUBMISSION,
        channelId: CHANNEL,
        confirmedOn: '2026-10-16',
        reference: 'Phone call',
        confirmsNumber: true,
        confirmsHolder: true,
      }).expect(409);

      // The reviewer saw version 3; the confirmation moved it.
      const stale = await post('approve', { submissionId: SUBMISSION, version: 3 }).expect(409);
      expect((stale.body as { code: string }).code).toBe('conflict.stale');

      const done = await post('approve', { submissionId: SUBMISSION, version: 4 }).expect(200);
      expect(done.body).toMatchObject({ outcome: 'approved', status: 'approved', version: 5 });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-issuer-confirmed.v1',
        'certification.seller-certification-approved.v1',
      ]);
      await post('approve', { submissionId: SUBMISSION, version: 5 }).expect(409);
    });

    it('requests changes and declines with the Market reasons, and refuses a bad body', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code, APPROVER, 3));
      const reasons = policies.policyFor(marketOf(code)).reasons;
      const reason = reasons.find((r) => r.outcomes.includes('changes-requested'))!;

      await http()
        .post(`${base}/${CERTIFICATE}/request-changes`)
        .set(h)
        .send({ submissionId: SUBMISSION, version: 3 })
        .expect(400);
      await http()
        .post(`${base}/${CERTIFICATE}/request-changes`)
        .set(h)
        .send({ submissionId: SUBMISSION, version: 3, reasonCode: reason.code, extra: 1 })
        .expect(400);
      await http()
        .post(`${base}/${CERTIFICATE}/request-changes`)
        .set(h)
        .set('content-type', 'text/plain')
        .send('x')
        .expect(415);

      const done = await http()
        .post(`${base}/${CERTIFICATE}/request-changes`)
        .set(h)
        .send({ submissionId: SUBMISSION, version: 3, reasonCode: reason.code, reasonText: 'Hi' })
        .expect(200);
      expect(done.body).toMatchObject({ outcome: 'changes-requested', status: 'changes-needed' });
      await http()
        .post(`${base}/${CERTIFICATE}/decline`)
        .set(h)
        .send({
          submissionId: SUBMISSION,
          version: 4,
          reasonCode: reasons.find((r) => r.outcomes.includes('declined'))!.code,
        })
        .expect(409);
    });

    it('shows a viewer the queue and nothing else; a seller and a visitor nothing', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const viewer = headers(code, sessionOf(code, VIEWER, 4));
      await http().get(base).set(viewer).expect(200);
      await http().get(`${base}/${CERTIFICATE}`).set(viewer).expect(403);
      await http()
        .post(`${base}/${CERTIFICATE}/decline`)
        .set(viewer)
        .send({ submissionId: SUBMISSION, version: 3, reasonCode: 'x' })
        .expect(403);

      const seller = headers(code, sessionOf(code, SELLER_OWNER, 5, 'seller'), 'seller');
      expect([401, 403]).toContain((await http().get(base).set(seller)).status);
      const anonymous = await http().get(base).set(headers(code));
      expect([401, 403]).toContain(anonymous.status);
    });

    it('refuses a write without the CSRF token', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const session = sessionOf(code, REVIEWER, 6);
      const response = await http()
        .post(`${base}/${CERTIFICATE}/checks`)
        .set(headers(code, { cookie: session.cookie }))
        .send({ submissionId: SUBMISSION, checkCode: required()[0], result: 'done' });
      expect(response.status).toBe(403);
      expect(reviews.submission.checks).toEqual([]);
    });
  });

  describe.each(TEST_MARKETS)('files in market %s', (code) => {
    it('answers 403 while the switch is off', async () => {
      reviews = makeReviews(code);
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code, REVIEWER, 7));
      const response = await http().get(`${base}/${CERTIFICATE}/documents/${DOCUMENT}`).set(h);
      expect(response.status).toBe(403);
      expect((response.body as { code: string }).code).toBe('document.download-disabled');
    });

    it('serves an attachment with the hardening headers once the switch is on', async () => {
      reviews = makeReviews(code);
      await boot({ CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true' });
      await seeded(code);
      const h = headers(code, sessionOf(code, REVIEWER, 8));
      const file = await http()
        .get(`${base}/${CERTIFICATE}/documents/${DOCUMENT}`)
        .set(h)
        .buffer(true)
        .expect(200);
      // Design 9.4: never under its own type, and a server-made file name.
      expect(file.headers['content-type']).toContain('application/octet-stream');
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="certificate-${DOCUMENT}.pdf"`,
      );
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toBe('sandbox');
      expect(file.headers['cache-control']).toContain('no-store');
      await http()
        .get(`${base}/${CERTIFICATE}/documents/${id<'UploadedDocument'>(0xe5ff)}`)
        .set(h)
        .expect(404);
    });
  });

  it.each(TEST_MARKETS)(
    'shows nothing of a certificate of another Market (reviewer of %s)',
    async (code) => {
      const owning = TEST_MARKETS.find((m) => m !== code)!;
      reviews = makeReviews(owning);
      await boot({ CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true' });
      await seeded(code);
      const h = headers(code, sessionOf(code, APPROVER, 9));
      await http().get(`${base}/${CERTIFICATE}`).set(h).expect(404);
      await http().get(`${base}/${CERTIFICATE}/documents/${DOCUMENT}`).set(h).expect(404);
      const queue = await http().get(base).set(h).expect(200);
      expect((queue.body as { total: number }).total).toBe(0);
      await http()
        .post(`${base}/${CERTIFICATE}/checks`)
        .set(h)
        .send({ submissionId: SUBMISSION, checkCode: 'x', result: 'done' })
        .expect(404);
    },
  );

  it('documents the routes and their error codes in OpenAPI', async () => {
    reviews = makeReviews('AU');
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const route = (path: string, method: string) => document.paths[`${base}${path}`]?.[method];
    expect(route('', 'get')?.responses).toHaveProperty('403');
    expect(route('/{certificateId}', 'get')?.responses).toHaveProperty('404');
    for (const path of ['/checks', '/scope', '/issuer-confirmation', '/approve']) {
      const responses = route(`/{certificateId}${path}`, 'post')?.responses ?? {};
      for (const status of ['400', '403', '404', '409']) expect(responses).toHaveProperty(status);
    }
    expect(route('/{certificateId}/approve', 'post')?.responses).toHaveProperty('422');
  });
});
