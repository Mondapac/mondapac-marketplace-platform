import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  CERTIFICATE_TYPE_CATALOG,
  type CertificateTypeCatalog,
} from '../src/modules/certification/application/ports/certificate-type-catalog';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_VAULT,
} from '../src/modules/certification/application/ports/document-ports';
import { ISSUER_REQUEST_REPOSITORY } from '../src/modules/certification/application/ports/issuer-request.repository';
import {
  RATE_COUNTER_KEYS,
  RATE_COUNTER_REPOSITORY,
} from '../src/modules/certification/application/ports/rate-counters';
import { REVIEW_SELLER_SOURCE } from '../src/modules/certification/application/ports/review.ports';
import { SELLER_CERTIFICATE_REPOSITORY } from '../src/modules/certification/application/ports/seller-certificate.repository';
import { SELLER_ZONES_SOURCE } from '../src/modules/certification/application/ports/tokens';
import { CheckedInReviewPolicy } from '../src/modules/certification/infrastructure/review-policy/checked-in-review-policy';
import { ADMIN_ISSUER_REQUEST_STATUS } from '../src/modules/certification/presentation/admin-issuer-request.controller';
import { OWN_ISSUER_REQUEST_STATUS } from '../src/modules/certification/presentation/own-issuer-request.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  fakeCounterKeys,
  FakeCipher,
  MemoryCertificates,
  MemoryCounters,
  MemoryOutbox,
  MemoryTypeCatalog,
  MemoryVault,
  zonesOf,
} from './support/certification-fakes';
import { MemoryIssuerRequests } from './support/certification-issuer-request-fakes';
import { FixedReviewSellers } from './support/certification-review-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// "My issuer is not listed" over HTTP (certification slice 6): the real guards, body parsers,
// CSRF, closed bodies, controllers, gate with the real role seed, use cases and file intake; the
// stores, the registry, the cipher and the vault as in-memory fakes. Proved here: the larger body
// of the request route, who may do what (a reviewer reads the queue but cannot answer; the
// protected answer key comes only through a custom role; a viewer and a seller see nothing of the
// queue), the status of each refusal, the headers of the served file, and that no answer, header
// or log carries the typed name.

const START = Temporal.Instant.from('2026-10-17T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const CANARY = 'Canary Certifiers 7Q9 of Nowhere';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n',
);

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const REVIEWER = id<'Account'>(0xa201);
const ANSWERER = id<'Account'>(0xa202);
const VIEWER = id<'Account'>(0xa203);
const SELLER = id<'Seller'>(0xb020);
const HALAL_TYPE = id<'CertificationType'>(0xc101);
const VEGAN_TYPE = id<'CertificationType'>(0xc102);
const ISSUER = id<'Issuer'>(0xd101);
const ANSWERER_ROLE = id<'Role'>(0xf301);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const policies = new CheckedInReviewPolicy();

describe('issuer request routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let certificates: MemoryCertificates;
  let requests: MemoryIssuerRequests;
  let catalog: MemoryTypeCatalog;
  let vault: MemoryVault;
  let outbox: MemoryOutbox;
  let logged: string[];
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
          .overrideProvider(SELLER_CERTIFICATE_REPOSITORY)
          .useValue(certificates)
          .overrideProvider(ISSUER_REQUEST_REPOSITORY)
          .useValue(requests)
          .overrideProvider(CERTIFICATE_TYPE_CATALOG)
          .useValue(catalog as CertificateTypeCatalog)
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue(new MemoryCounters())
          .overrideProvider(RATE_COUNTER_KEYS)
          .useValue(fakeCounterKeys)
          .overrideProvider(DOCUMENT_VAULT)
          .useValue(vault)
          .overrideProvider(CERTIFICATE_FIELD_CIPHER)
          .useValue(new FakeCipher())
          .overrideProvider(REVIEW_SELLER_SOURCE)
          .useValue(new FixedReviewSellers())
          .overrideProvider(SELLER_ZONES_SOURCE)
          .useValue(
            zonesOf({
              [SELLER]: { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' },
            }),
          ),
    }));
    // Every line the app writes, as text, for the canary search.
    const out = process.stdout.write.bind(process.stdout);
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app
      .get(SeedRoles)
      .execute(testCallContext(marketOf(code), 'system', 'issuer-request-0001'), {});
    const market = marketOf(code);
    const marketId = code as AccountState['marketId'];
    const roleOf = (scope: 'platform' | 'seller', seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
      )!.id;
    // The answer key is protected: no default role holds it, a custom role does.
    fakes.seedRole({
      id: ANSWERER_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Issuer registry editor',
      permissionKeys: ['certification.issuer.view', 'certification.issuer.edit'],
      version: 1,
      createdAt: START,
    });
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
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
    account(OWNER, 'owner', 'seller', roleOf('seller', 'seller-owner'));
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    account(REVIEWER, 'reviewer', 'admin', roleOf('platform', 'certification-reviewer'));
    account(ANSWERER, 'answerer', 'admin', ANSWERER_ROLE);
    account(VIEWER, 'viewer', 'admin', roleOf('platform', 'viewer'));

    const base = {
      status: 'active' as const,
      verificationMode: 'THIRD_PARTY_DOCUMENT' as const,
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
    };
    catalog.addType(market, {
      ...base,
      typeId: HALAL_TYPE,
      code: 'halal',
      revisionId: id<'CertificationTypeRevision'>(0xc201),
      names: { en: 'Halal' },
    });
    catalog.addType(market, {
      ...base,
      typeId: VEGAN_TYPE,
      code: 'vegan',
      revisionId: id<'CertificationTypeRevision'>(0xc202),
      verificationMode: 'SELF_DECLARATION',
      requiresIssuerRegistry: false,
      requiresDocument: false,
      requiresExpiry: false,
      names: { en: 'Vegan' },
    });
    catalog.addIssuer(market, {
      id: ISSUER,
      typeId: HALAL_TYPE,
      displayName: 'Halal Authority',
      state: 'active',
    });
    for (const [typeId, typeCode] of [
      [HALAL_TYPE, 'halal'],
      [VEGAN_TYPE, 'vegan'],
    ] as const) {
      certificates.typeCodes.set(typeId, typeCode);
      requests.typeCodes.set(typeId, typeCode);
    }
  }

  function sessionOf(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'seller',
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

  const headers = (
    code: string,
    session: Record<string, string>,
    population: 'admin' | 'seller',
  ) => ({
    'x-market-id': code,
    ...panelHeaders(code, population),
    ...session,
  });
  const sellerBase = '/certification/seller/issuer-requests';
  const adminBase = '/certification/admin/issuer-requests';
  const body = (over: Record<string, unknown> = {}) => ({
    typeCode: 'halal',
    issuerName: CANARY,
    data: PDF.toString('base64'),
    ...over,
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    certificates = new MemoryCertificates();
    requests = new MemoryIssuerRequests(certificates.openIssuerRequests);
    catalog = new MemoryTypeCatalog();
    vault = new MemoryVault();
    outbox = new MemoryOutbox();
    logged = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('maps every refusal of the routes to its status', () => {
    expect(OWN_ISSUER_REQUEST_STATUS).toMatchObject({
      'validation.failed': 400,
      'type.not-found': 404,
      'type.inactive': 409,
      'type.no-issuer-registry': 409,
      'file.too-large': 413,
      'file.unsupported-type': 415,
      'file.active-content': 422,
      'request.throttled': 429,
    });
    expect(ADMIN_ISSUER_REQUEST_STATUS).toEqual({
      'validation.failed': 400,
      'issuer-request.not-found': 404,
      'document.not-found': 404,
      'document.download-disabled': 403,
      'issuer-request.already-answered': 409,
      'conflict.stale': 409,
      'issuer.not-found': 422,
      'issuer.not-active': 422,
      'issuer-request.reason-unknown': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('walks a request from the seller to the queue, the read, the file and the answer', async () => {
      await boot({ CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true' });
      await seeded(code);
      const seller = headers(code, sessionOf(code, OWNER, 1, 'seller'), 'seller');
      const reviewer = headers(code, sessionOf(code, REVIEWER, 2, 'admin'), 'admin');
      const answerer = headers(code, sessionOf(code, ANSWERER, 3, 'admin'), 'admin');

      const created = await http().post(sellerBase).set(seller).send(body()).expect(201);
      expect(created.body).toEqual({
        issuerRequestId: expect.any(String) as string,
        typeCode: 'halal',
        state: 'open',
        createdAt: START.toString(),
      });
      const requestId = (created.body as { issuerRequestId: string }).issuerRequestId;

      const queue = await http().get(adminBase).set(reviewer).expect(200);
      expect(queue.headers['cache-control']).toContain('no-store');
      expect(queue.body).toMatchObject({
        total: 1,
        items: [{ issuerRequestId: requestId, typeCode: 'halal', sellerId: SELLER, version: 1 }],
      });

      const page = await http().get(`${adminBase}/${requestId}`).set(reviewer).expect(200);
      expect(page.headers['cache-control']).toBe('private, no-store');
      expect(page.body).toMatchObject({ typedIssuerName: CANARY, state: 'open' });
      const documentId = (page.body as { documents: { documentId: string }[] }).documents[0]!
        .documentId;

      const file = await http()
        .get(`${adminBase}/${requestId}/documents/${documentId}`)
        .set(reviewer)
        .expect(200);
      expect(file.headers['content-type']).toContain('application/octet-stream');
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="issuer-request-${documentId}.pdf"`,
      );
      expect(file.headers['x-content-type-options']).toBe('nosniff');

      // The reviewer holds only the view key: the protected answer is refused.
      const reason = policies.policyFor(marketOf(code)).issuerRequestReasons[0]!.code;
      const answer = { version: 1, outcome: 'not-accepted', reasonCode: reason };
      await http().post(`${adminBase}/${requestId}/answer`).set(reviewer).send(answer).expect(403);
      const answered = await http()
        .post(`${adminBase}/${requestId}/answer`)
        .set(answerer)
        .send(answer)
        .expect(200);
      expect(answered.body).toMatchObject({ state: 'not-accepted', version: 2 });
      await http().post(`${adminBase}/${requestId}/answer`).set(answerer).send(answer).expect(409);
      await http()
        .post(`${adminBase}/${requestId}/answer`)
        .set(answerer)
        .send({ version: 2, outcome: 'issuer-added', issuerId: ISSUER })
        .expect(409);
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.issuer-request-answered.v1',
      ]);
      expect(fakes.audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'certification.issuer-request.viewed',
          'certification.issuer-request.document-downloaded',
          'certification.issuer-request.answered',
        ]),
      );

      // The typed name went back only in the decrypted read, never in a log line, event or audit.
      const everything = JSON.stringify({ logged, events: outbox.events, audits: fakes.audits });
      expect(everything).not.toContain(CANARY);
    }, 30_000);

    it('keeps the queue from a viewer and a seller, and the seller route from an admin', async () => {
      await boot();
      await seeded(code);
      const viewer = headers(code, sessionOf(code, VIEWER, 4, 'admin'), 'admin');
      const seller = headers(code, sessionOf(code, OWNER, 5, 'seller'), 'seller');
      await http().get(adminBase).set(viewer).expect(403);
      // A seller session on an admin route is not authenticated there.
      expect([401, 403]).toContain((await http().get(adminBase).set(seller)).status);
      expect([401, 403]).toContain((await http().post(sellerBase).set(viewer).send(body())).status);
      expect(requests.rows.size).toBe(0);
    }, 30_000);

    it('refuses the file read while its switch is off', async () => {
      await boot();
      await seeded(code);
      const seller = headers(code, sessionOf(code, OWNER, 6, 'seller'), 'seller');
      const reviewer = headers(code, sessionOf(code, REVIEWER, 7, 'admin'), 'admin');
      const created = await http().post(sellerBase).set(seller).send(body()).expect(201);
      const requestId = (created.body as { issuerRequestId: string }).issuerRequestId;
      const documentId = [...requests.rows.values()][0]!.documents[0]!.id;
      const refused = await http()
        .get(`${adminBase}/${requestId}/documents/${documentId}`)
        .set(reviewer)
        .expect(403);
      expect((refused.body as { code: string }).code).toBe('document.download-disabled');
    }, 30_000);

    it('takes the larger body on the request route, a closed JSON body and the CSRF token', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, OWNER, 8, 'seller');
      const seller = headers(code, session, 'seller');
      // A body over 64 KiB passes the parser (and the intake refuses its content), unlike elsewhere.
      const large = Buffer.concat([PDF, Buffer.alloc(200 * 1024)]);
      expect(
        (
          await http()
            .post(sellerBase)
            .set(seller)
            .send(body({ data: large.toString('base64') }))
        ).status,
      ).not.toBe(413);
      await http()
        .post(sellerBase)
        .set(seller)
        .send(
          body({ data: Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]).toString('base64') }),
        )
        .expect(413);
      await http()
        .post(sellerBase)
        .set(seller)
        .send(body({ extra: 1 }))
        .expect(400);
      await http()
        .post(sellerBase)
        .set(seller)
        .send({ typeCode: 'halal', data: PDF.toString('base64') })
        .expect(400);
      await http()
        .post(sellerBase)
        .set(seller)
        .send(body({ typeCode: 'vegan' }))
        .expect(409);
      await http()
        .post(sellerBase)
        .set(seller)
        .send(body({ typeCode: 'kosher' }))
        .expect(404);
      const noCsrf = headers(
        code,
        Object.fromEntries(Object.entries(session).filter(([name]) => name !== 'x-csrf-token')),
        'seller',
      );
      await http().post(sellerBase).set(noCsrf).send(body()).expect(403);
      expect(requests.rows.size).toBe(0);
    }, 30_000);
  });
});
