import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import sharp from 'sharp';
import {
  CERTIFICATE_TYPE_CATALOG,
  type CertificateTypeCatalog,
} from '../src/modules/certification/application/ports/certificate-type-catalog';
import { SELLER_ZONES_SOURCE } from '../src/modules/certification/application/ports/tokens';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_VAULT,
} from '../src/modules/certification/application/ports/document-ports';
import {
  RATE_COUNTER_KEYS,
  RATE_COUNTER_REPOSITORY,
} from '../src/modules/certification/application/ports/rate-counters';
import { SELLER_CERTIFICATE_REPOSITORY } from '../src/modules/certification/application/ports/seller-certificate.repository';
import { OWN_CERTIFICATE_STATUS } from '../src/modules/certification/presentation/own-certificate.controller';
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
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller certificate routes over HTTP (certification slices 3 to 5): the real guards, body
// parsers, controller, gate, use cases and file intake, with identity's ports, the certificate
// stores, the registry and the vault as in-memory fakes. Proved here: the session, the CSRF token,
// the closed bodies, the larger body of the upload route and no other, the status of every
// refusal, the headers of a served file, and the whole path from an empty draft to a withdrawal.

const START = Temporal.Instant.from('2026-10-16T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const OTHER_SELLER = id<'Seller'>(0xb099);
const HALAL_TYPE = id<'CertificationType'>(0xc101);
const VEGAN_TYPE = id<'CertificationType'>(0xc102);
const ISSUER = id<'Issuer'>(0xd101);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n',
);
const JS_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page /OpenAction <</S /JavaScript>>>> endobj\n%%EOF\n',
);

describe('seller certificate routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let certificates: MemoryCertificates;
  let catalog: MemoryTypeCatalog;
  let counters: MemoryCounters;
  let vault: MemoryVault;
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
          .overrideProvider(SELLER_CERTIFICATE_REPOSITORY)
          .useValue(certificates)
          .overrideProvider(CERTIFICATE_TYPE_CATALOG)
          .useValue(catalog as CertificateTypeCatalog)
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue(counters)
          .overrideProvider(RATE_COUNTER_KEYS)
          .useValue(fakeCounterKeys)
          .overrideProvider(DOCUMENT_VAULT)
          .useValue(vault)
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

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'cert-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
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
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'Owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
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
    const market = marketOf(code);
    catalog.addType(market, {
      typeId: HALAL_TYPE,
      code: 'halal',
      status: 'active',
      revisionId: id<'CertificationTypeRevision'>(0xc201),
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      names: { en: 'Halal' },
    });
    catalog.addType(market, {
      typeId: VEGAN_TYPE,
      code: 'vegan',
      status: 'active',
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
    certificates.typeCodes.set(HALAL_TYPE, 'halal');
    certificates.typeCodes.set(VEGAN_TYPE, 'vegan');
  }

  function sessionOf(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf101),
        marketId: code as AccountState['marketId'],
        accountId: OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const headers = (code: string, extra: Record<string, string>) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'seller'),
    ...extra,
  });
  const base = '/certification/seller';
  const draft = (overrides: Record<string, unknown> = {}) => ({
    issuerId: ISSUER,
    certificateNumber: 'HC-2026-001',
    issueDate: '2026-01-01',
    expiryDate: '2027-12-31',
    selfDeclared: null,
    selfDeclarationNote: null,
    ...overrides,
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    certificates = new MemoryCertificates();
    catalog = new MemoryTypeCatalog();
    counters = new MemoryCounters();
    vault = new MemoryVault();
    outbox = new MemoryOutbox();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal of the routes to its status', () => {
    expect(OWN_CERTIFICATE_STATUS).toMatchObject({
      'validation.failed': 400,
      'certificate.not-found': 404,
      'document.not-found': 404,
      'certificate.exists': 409,
      'certificate.not-editable': 409,
      'conflict.stale': 409,
      'certificate.incomplete': 422,
      'file.too-large': 413,
      'file.unsupported-type': 415,
      'file.active-content': 422,
      'request.throttled': 429,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('walks a certificate from an empty draft to a withdrawn submission', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const h = headers(code, session);

      const options = await http().get(`${base}/certificate-options`).set(h).expect(200);
      expect(options.headers['cache-control']).toContain('no-store');
      expect((options.body as { types: { code: string }[] }).types.map((t) => t.code)).toEqual(
        expect.arrayContaining(['halal', 'vegan']),
      );

      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal' })
        .expect(201);
      const certificateId = (created.body as { certificateId: string }).certificateId;
      expect(created.body).toMatchObject({ typeCode: 'halal', status: 'draft', editable: true });
      await http().post(`${base}/certificates`).set(h).send({ typeCode: 'halal' }).expect(409);

      // Incomplete: the 422 names the missing fields.
      const incomplete = await http()
        .post(`${base}/certificates/${certificateId}/submit`)
        .set(h)
        .expect(422);
      expect((incomplete.body as { code: string }).code).toBe('certificate.incomplete');

      const saved = await http()
        .put(`${base}/certificates/${certificateId}`)
        .set(h)
        .send(draft())
        .expect(200);
      expect((saved.body as { draft: { certificateNumber: string } }).draft.certificateNumber).toBe(
        'HC-2026-001',
      );

      // A photo of noise is far past the 64 KiB JSON limit: the upload route takes it.
      const noise = await sharp(randomBytes(900 * 700 * 3), {
        raw: { width: 900, height: 700, channels: 3 },
      })
        .png({ compressionLevel: 0 })
        .toBuffer();
      const data = noise.toString('base64');
      expect(data.length).toBeGreaterThan(64 * 1024);
      const uploaded = await http()
        .post(`${base}/certificates/${certificateId}/documents`)
        .set(h)
        .send({ data })
        .expect(201);
      expect(uploaded.body).toMatchObject({ position: 1, mediaType: 'image/png' });
      const documentId = (uploaded.body as { documentId: string }).documentId;

      const file = await http()
        .get(`${base}/certificates/${certificateId}/documents/${documentId}`)
        .set(h)
        .buffer(true)
        .expect(200);
      expect(file.headers['content-type']).toContain('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['cache-control']).toContain('no-store');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect(file.headers['content-disposition']).toContain('attachment');

      const submitted = await http()
        .post(`${base}/certificates/${certificateId}/submit`)
        .set(h)
        .expect(201);
      expect(submitted.body).toMatchObject({ certificateId, kind: 'initial' });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-submitted.v1',
      ]);

      const read = await http().get(`${base}/certificates/${certificateId}`).set(h).expect(200);
      expect(read.body).toMatchObject({
        certificate: { status: 'awaiting-review', editable: false, withdrawable: true },
        documents: [{ documentId }],
      });
      // Pending: no edit, no new file, no second submit.
      await http().put(`${base}/certificates/${certificateId}`).set(h).send(draft()).expect(409);
      await http().post(`${base}/certificates/${certificateId}/submit`).set(h).expect(409);
      await http().delete(`${base}/certificates/${certificateId}`).set(h).expect(409);

      const withdrawn = await http()
        .post(`${base}/certificates/${certificateId}/withdraw`)
        .set(h)
        .expect(200);
      expect(withdrawn.body).toMatchObject({ status: 'draft', withdrawable: false });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-submitted.v1',
        'certification.seller-certification-withdrawn.v1',
      ]);

      const listed = await http().get(`${base}/certificates`).set(h).expect(200);
      expect((listed.body as { certificates: unknown[] }).certificates).toHaveLength(1);

      await http()
        .delete(`${base}/certificates/${certificateId}/documents/${documentId}`)
        .set(h)
        .expect(200);
    });

    it('deletes a draft that was never submitted', async () => {
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code));
      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'vegan' })
        .expect(201);
      const certificateId = (created.body as { certificateId: string }).certificateId;
      await http().delete(`${base}/certificates/${certificateId}`).set(h).expect(200);
      await http().get(`${base}/certificates/${certificateId}`).set(h).expect(404);
    });

    it('refuses what the intake refuses with the status of its code, storing nothing', async () => {
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code));
      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal' })
        .expect(201);
      const route = `${base}/certificates/${(created.body as { certificateId: string }).certificateId}/documents`;
      const post = (bytes: Buffer) =>
        http()
          .post(route)
          .set(h)
          .send({ data: bytes.toString('base64') });

      expect((await post(JS_PDF)).status).toBe(422);
      expect((await post(Buffer.from('MZ not an image'))).status).toBe(415);
      expect((await post(Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]))).status).toBe(413);
      await http().post(route).set(h).send({ data: 'not base64 !' }).expect(400);
      expect(vault.objects.size).toBe(0);
      expect(certificates.documents.size).toBe(0);
    });

    it('keeps the upload limit to the upload route and the 64 KiB limit everywhere else', async () => {
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code));
      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal' })
        .expect(201);
      const certificateId = (created.body as { certificateId: string }).certificateId;
      await http()
        .put(`${base}/certificates/${certificateId}`)
        .set(h)
        .send(draft({ selfDeclarationNote: 'x'.repeat(70_000) }))
        .expect(413);
      await http()
        .post(`${base}/certificates/${certificateId}/documents`)
        .set(h)
        .send({ data: 'A'.repeat(15_000_000) })
        .expect(413);
    });

    it('refuses a missing CSRF token, a wrong content type, an unknown field and a missing field', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const noCsrf = Object.fromEntries(
        Object.entries(session).filter(([name]) => name !== 'x-csrf-token'),
      );
      await http()
        .post(`${base}/certificates`)
        .set(headers(code, noCsrf))
        .send({ typeCode: 'halal' })
        .expect(403);
      const h = headers(code, session);
      await http()
        .post(`${base}/certificates`)
        .set({ ...h, 'content-type': 'text/plain' })
        .send('halal')
        .expect(415);
      await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal', extra: 1 })
        .expect(400);
      await http().post(`${base}/certificates`).set(h).send({}).expect(400);
      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal' })
        .expect(201);
      const certificateId = (created.body as { certificateId: string }).certificateId;
      // The draft is the whole draft: a missing field is refused, a bad date names its path.
      await http()
        .put(`${base}/certificates/${certificateId}`)
        .set(h)
        .send({ certificateNumber: 'x' })
        .expect(400);
      const bad = await http()
        .put(`${base}/certificates/${certificateId}`)
        .set(h)
        .send(draft({ expiryDate: '31/12/2027' }))
        .expect(400);
      expect(bad.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'expiryDate', code: 'format' }] },
      });
      expect(certificates.certificates.size).toBe(1);
    });

    it('needs a seller session: nothing for an anonymous caller', async () => {
      await boot();
      await seeded(code);
      await http()
        .get(`${base}/certificates`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .expect(401);
    });

    it("answers another seller's certificate and file as 404, like an unknown id", async () => {
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code));
      const foreign = id<'SellerCertification'>(0x7001);
      await certificates.add(marketOf(code), {
        id: foreign,
        sellerId: OTHER_SELLER,
        typeId: HALAL_TYPE,
        now: START,
      });
      const unknown = id<'SellerCertification'>(0x7002);
      for (const certificateId of [foreign, unknown]) {
        await http().get(`${base}/certificates/${certificateId}`).set(h).expect(404);
        await http().put(`${base}/certificates/${certificateId}`).set(h).send(draft()).expect(404);
        await http().post(`${base}/certificates/${certificateId}/submit`).set(h).expect(404);
        await http().post(`${base}/certificates/${certificateId}/withdraw`).set(h).expect(404);
        await http().delete(`${base}/certificates/${certificateId}`).set(h).expect(404);
        await http()
          .post(`${base}/certificates/${certificateId}/documents`)
          .set(h)
          .send({ data: PDF.toString('base64') })
          .expect(404);
        await http()
          .get(`${base}/certificates/${certificateId}/documents/${id<'UploadedDocument'>(0x9001)}`)
          .set(h)
          .expect(404);
      }
      await http().get(`${base}/certificates/not-an-id`).set(h).expect(400);
      expect(certificates.certificates.get(foreign)).toBeDefined();
    });

    it('answers 429 with Retry-After when the day budget of uploads is spent', async () => {
      await boot();
      await seeded(code);
      const h = headers(code, sessionOf(code));
      const created = await http()
        .post(`${base}/certificates`)
        .set(h)
        .send({ typeCode: 'halal' })
        .expect(201);
      const route = `${base}/certificates/${(created.body as { certificateId: string }).certificateId}/documents`;
      let last = 0;
      let retryAfter: string | undefined;
      for (let i = 0; i < 31; i += 1) {
        const response = await http()
          .post(route)
          .set(h)
          .send({ data: JS_PDF.toString('base64') });
        last = response.status;
        retryAfter = response.headers['retry-after'] as string | undefined;
      }
      expect(last).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });
  });
});
