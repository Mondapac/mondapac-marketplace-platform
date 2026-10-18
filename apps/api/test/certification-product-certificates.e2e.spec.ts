import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import sharp from 'sharp';
import {
  PRODUCT_CERTIFICATION_REPOSITORY,
  type ProductCertificationRepository,
  type ProductCertificationSummary,
  type ProductDocumentWrite,
  type ProductHistoryRow,
  type StoredProductCertification,
} from '../src/modules/certification/application/ports/product-certification.repository';
import { CERTIFICATION_REGISTRY_REPOSITORY } from '../src/modules/certification/application/ports/registry.repository';
import type { TypeRevisionContent } from '../src/modules/certification/domain/type-revision';
import { PRODUCT_CERTIFICATE_STATUS } from '../src/modules/certification/presentation/admin-product-certificate.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { StaleAggregateError } from '../src/platform/unit-of-work/errors';
import { PLATFORM_DOCUMENT_VAULT } from '../src/modules/certification/application/ports/document-ports';
import { MemoryOutbox, MemoryPlatformVault } from './support/certification-fakes';
import { MemoryRegistry } from './support/certification-registry-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The manufacturer certificate admin routes over HTTP (certification slice 14; design 3.4, 7.1,
// 7.2): the real guards, CSRF, closed bodies, controller, gate with the real role seed and use
// cases; identity's ports, the registry and the certificate store as in-memory fakes. Proved
// here: nobody signed in is 401; a default role reads (the view key is in catalogue-moderator,
// certification-reviewer and viewer) but neither records nor reads the number (both keys are
// protected); a custom role with the edit key records a draft of an active third-party type, and
// the refusals map to their status. The full flow over the real tables is
// test/db/certification-product-certification.db-spec.ts.

const START = Temporal.Instant.from('2026-10-18T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xa401);
const EDITOR = id<'Account'>(0xa402);
const TYPE = id<'CertificationType'>(0xc401);
const SELF_TYPE = id<'CertificationType'>(0xc402);
const EDITOR_ROLE = id<'Role'>(0xf411);
const REVOKER = id<'Account'>(0xa403);
const REVOKER_ROLE = id<'Role'>(0xf412);

/** The certificate roots only: enough for create, read and list (no revisions here). */
class MemoryProductCertificates implements ProductCertificationRepository {
  readonly roots = new Map<string, StoredProductCertification & { marketId: string }>();

  create(
    market: MarketContext,
    root: {
      id: Id<'ProductCertification'>;
      typeId: Id<'CertificationType'>;
      authorAccountId: Id<'Account'>;
      now: Temporal.Instant;
    },
  ): Promise<void> {
    this.roots.set(root.id, {
      marketId: market.marketId,
      id: root.id,
      typeId: root.typeId,
      status: 'draft',
      pendingRevisionId: null,
      approvedRevisionId: null,
      approvedBoundaryAt: null,
      authorAccountId: root.authorAccountId,
      draft: {
        manufacturerName: null,
        issuerId: null,
        certificateNumberCiphertext: null,
        issueDate: null,
        expiryDate: null,
        coverage: [],
      },
      draftEditorAccountIds: [],
      draftDocuments: [],
      statusChangedAt: root.now,
      lastChangedAt: root.now,
      version: 1,
      createdAt: root.now,
    });
    return Promise.resolve();
  }
  get(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
  ): Promise<StoredProductCertification | null> {
    const root = this.roots.get(certificateId);
    return Promise.resolve(root && root.marketId === market.marketId ? root : null);
  }
  revision(): Promise<null> {
    return Promise.resolve(null);
  }
  list(market: MarketContext): Promise<readonly ProductCertificationSummary[]> {
    return Promise.resolve(
      [...this.roots.values()]
        .filter((r) => r.marketId === market.marketId)
        .map((r) => ({
          id: r.id,
          typeId: r.typeId,
          status: r.status,
          pendingRevisionId: null,
          approvedRevisionId: null,
          manufacturerName: r.draft.manufacturerName,
          coverageEntries: r.draft.coverage.length,
          lastChangedAt: r.lastChangedAt,
          version: r.version,
        })),
    );
  }
  lock(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    expectedVersion: number,
  ): Promise<void> {
    const root = this.roots.get(certificateId);
    if (root === undefined || root.marketId !== market.marketId) return Promise.resolve();
    if (root.version !== expectedVersion) {
      return Promise.reject(new StaleAggregateError('product-certification', certificateId));
    }
    this.roots.set(certificateId, { ...root, version: expectedVersion + 1 });
    return Promise.resolve();
  }
  saveDraft(): Promise<void> {
    return Promise.reject(new Error('not in this suite'));
  }
  submit(): Promise<number> {
    return Promise.reject(new Error('not in this suite'));
  }
  decide(): Promise<void> {
    return Promise.reject(new Error('not in this suite'));
  }
  shareRegistryRows(): Promise<never> {
    return Promise.reject(new Error('not in this suite'));
  }
  transition(): Promise<void> {
    return Promise.reject(new Error('not in this suite'));
  }
  expiryCandidates(): Promise<never> {
    return Promise.reject(new Error('not in this suite'));
  }
  expiryCandidate(): Promise<never> {
    return Promise.reject(new Error('not in this suite'));
  }
  recordWarning(): Promise<void> {
    return Promise.reject(new Error('not in this suite'));
  }
  history(): Promise<readonly ProductHistoryRow[]> {
    return Promise.resolve([]);
  }
  addDocument(market: MarketContext, write: ProductDocumentWrite): Promise<void> {
    const root = this.roots.get(write.certificateId)!;
    this.roots.set(write.certificateId, {
      ...root,
      draftDocuments: [
        ...root.draftDocuments,
        {
          id: write.documentId,
          position: write.position,
          mediaType: write.mediaType,
          byteSize: write.byteSize,
          pageCount: write.pageCount,
          createdAt: write.now,
          objectKey: write.objectKey,
          cleanSha256: write.cleanSha256,
          submitted: false,
        },
      ],
      draftEditorAccountIds: [...new Set([...root.draftEditorAccountIds, write.editorAccountId])],
    });
    return Promise.resolve();
  }
  removeDocument(
    market: MarketContext,
    write: { certificateId: Id<'ProductCertification'>; documentId: Id<'UploadedDocument'> },
  ): Promise<'deleted' | 'missing'> {
    const root = this.roots.get(write.certificateId)!;
    const kept = root.draftDocuments.filter((d) => d.id !== write.documentId);
    if (kept.length === root.draftDocuments.length) return Promise.resolve('missing');
    this.roots.set(write.certificateId, { ...root, draftDocuments: kept });
    return Promise.resolve('deleted');
  }
  recordCheck(): Promise<void> {
    return Promise.reject(new Error('not in this suite'));
  }
}

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

jest.setTimeout(30_000);

describe('manufacturer certificate admin routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let registry: MemoryRegistry;
  let products: MemoryProductCertificates;
  let vault: MemoryPlatformVault;
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(OUTBOX_WRITER)
          .useValue(new MemoryOutbox())
          .overrideProvider(CERTIFICATION_REGISTRY_REPOSITORY)
          .useValue(registry)
          .overrideProvider(PRODUCT_CERTIFICATION_REPOSITORY)
          .useValue(products)
          .overrideProvider(PLATFORM_DOCUMENT_VAULT)
          .useValue(vault),
    }));
  }

  function seedTypes(code: string) {
    const content = (verificationMode: TypeRevisionContent['verificationMode']) =>
      ({
        verificationMode,
        requiresIssuerRegistry: verificationMode === 'THIRD_PARTY_DOCUMENT',
        requiresDocument: false,
        requiresExpiry: true,
        defaultBasis: 'SELLER_OR_MANUFACTURER',
        autoApproveSelfDeclaration: false,
        badgeIconKey: 'seal',
        locales: {},
      }) as unknown as TypeRevisionContent;
    registry.addType(
      marketOf(code),
      { id: TYPE, code: 'qorvane', status: 'active' },
      { id: id<'CertificationTypeRevision'>(0xc411), content: content('THIRD_PARTY_DOCUMENT') },
      START,
      'seed',
    );
    registry.addType(
      marketOf(code),
      { id: SELF_TYPE, code: 'plainly', status: 'active' },
      { id: id<'CertificationTypeRevision'>(0xc412), content: content('SELF_DECLARATION') },
      START,
      'seed',
    );
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'product-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    // The edit key is protected: only a custom role granted by an administrator holds it.
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Manufacturer certificate editor',
      permissionKeys: [
        'certification.product-certificate.view',
        'certification.product-certificate.edit',
      ],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    const account = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
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
        id: id<'RoleAssignment'>(0xe960 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    // The revoke key is protected too (slice 15): a custom role holds it with the edit key.
    fakes.seedRole({
      id: REVOKER_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Manufacturer certificate revoker',
      permissionKeys: [
        'certification.product-certificate.view',
        'certification.product-certificate.edit',
        'certification.product-certificate.revoke',
      ],
      version: 1,
      createdAt: START,
    });
    account(MODERATOR, 'moderator', roleOf('catalogue-moderator'));
    account(EDITOR, 'editor', EDITOR_ROLE);
    account(REVOKER, 'revoker', REVOKER_ROLE);
  }

  function headersOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf700 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const base = '/certification/admin/product-certificates';

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    registry = new MemoryRegistry();
    products = new MemoryProductCertificates();
    vault = new MemoryPlatformVault();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals to their status', () => {
    expect(PRODUCT_CERTIFICATE_STATUS).toMatchObject({
      'certificate.not-found': 404,
      'type.not-found': 404,
      'type.manufacturer-basis-not-allowed': 422,
      'approval.same-admin': 403,
      'conflict.stale': 409,
      'review.not-current-revision': 409,
      'certificate.suspended': 409,
      'certificate.not-suspendable': 409,
      'certificate.not-suspended': 409,
      'certificate.revoked': 409,
      'certificate.not-revocable': 409,
      'document.not-found': 404,
      'document.limit-reached': 409,
      'file.too-large': 413,
      'file.unsupported-type': 415,
      'request.throttled': 429,
      'review.checks-incomplete': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('treats a request without a session as not signed in', async () => {
      await boot();
      const refused = await http()
        .get(base)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
      expect(refused.status).toBe(401);
      expect((refused.body as { code: string }).code).toBe('access.unauthenticated');
    });

    it('lets a default role read, but not record, edit or read the number: both keys are protected', async () => {
      await boot();
      seedTypes(code);
      await seeded(code);
      const h = headersOf(code, MODERATOR, 1);
      const list = await http().get(base).set(h).expect(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).toEqual({ items: [], limit: 50, offset: 0 });
      const create = await http().post(base).set(h).send({ typeId: TYPE }).expect(403);
      expect((create.body as { code: string }).code).toBe('access.denied');
      const review = await http()
        .get(`${base}/${id(0xe501)}/review`)
        .set(h)
        .expect(403);
      expect((review.body as { code: string }).code).toBe('access.denied');
      expect(products.roots.size).toBe(0);
    });

    it('suspends, revokes and reinstates only with their protected keys; maps a wrong status to 409 and reads the history with the view key (slice 15)', async () => {
      await boot();
      seedTypes(code);
      await seeded(code);
      const editor = headersOf(code, EDITOR, 3);
      const revoker = headersOf(code, REVOKER, 4);
      const moderator = headersOf(code, MODERATOR, 5);
      const created = await http().post(base).set(editor).send({ typeId: TYPE }).expect(201);
      const { certificateId } = created.body as { certificateId: string };
      const reason = { version: 1, reasonCode: 'under-investigation' };

      // A default role and the edit key alone hold neither the revoke nor the approve key.
      for (const h of [moderator, editor]) {
        for (const action of ['suspend', 'revoke']) {
          const refused = await http()
            .post(`${base}/${certificateId}/${action}`)
            .set(h)
            .send(reason)
            .expect(403);
          expect((refused.body as { code: string }).code).toBe('access.denied');
        }
        const reinstate = await http()
          .post(`${base}/${certificateId}/reinstate`)
          .set(h)
          .send({ version: 1 })
          .expect(403);
        expect((reinstate.body as { code: string }).code).toBe('access.denied');
      }
      // Closed bodies: the reason is required, unknown keys are refused, CSRF is checked.
      await http()
        .post(`${base}/${certificateId}/suspend`)
        .set(revoker)
        .send({ version: 1 })
        .expect(400);
      await http()
        .post(`${base}/${certificateId}/suspend`)
        .set(revoker)
        .send({ ...reason, status: 'suspended' })
        .expect(400);
      const noCsrf: Record<string, string> = { ...revoker };
      delete noCsrf['x-csrf-token'];
      await http().post(`${base}/${certificateId}/suspend`).set(noCsrf).send(reason).expect(403);
      // A draft was never approved: 409 with the domain's code, nothing written.
      const draft = await http()
        .post(`${base}/${certificateId}/revoke`)
        .set(revoker)
        .send({ version: 1, reasonCode: code === 'AU' ? 'approved-in-error' : 'forged' })
        .expect(409);
      expect((draft.body as { code: string }).code).toBe('certificate.not-revocable');
      expect(products.roots.get(certificateId)!.status).toBe('draft');

      const history = await http()
        .get(`${base}/${certificateId}/history`)
        .set(moderator)
        .expect(200);
      expect(history.headers['cache-control']).toContain('no-store');
      expect(history.body).toEqual({ certificateId, entries: [] });
      await http()
        .get(`${base}/${id(0xe5fe)}/history`)
        .set(moderator)
        .expect(404);
    });

    it('adds and removes a draft file with the edit key only, sealed under the platform vault; records no check without the approve key (slice 15 part 2)', async () => {
      await boot();
      seedTypes(code);
      await seeded(code);
      const editor = headersOf(code, EDITOR, 6);
      const moderator = headersOf(code, MODERATOR, 7);
      const created = await http().post(base).set(editor).send({ typeId: TYPE }).expect(201);
      const { certificateId } = created.body as { certificateId: string };
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#00aa00' },
      })
        .png()
        .toBuffer();
      const data = png.toString('base64');
      const documents = `${base}/${certificateId}/documents`;

      // The view key alone, no CSRF, a closed body, a stale version, a file of no known type.
      const denied = await http().post(documents).set(moderator).send({ version: 1, data });
      expect(denied.status).toBe(403);
      expect((denied.body as { code: string }).code).toBe('access.denied');
      const noCsrf: Record<string, string> = { ...editor };
      delete noCsrf['x-csrf-token'];
      await http().post(documents).set(noCsrf).send({ version: 1, data }).expect(403);
      await http()
        .post(documents)
        .set(editor)
        .send({ version: 1, data, name: 'a.png' })
        .expect(400);
      const stale = await http().post(documents).set(editor).send({ version: 9, data }).expect(409);
      expect((stale.body as { code: string }).code).toBe('conflict.stale');
      const text = Buffer.from('plain text, not a certificate').toString('base64');
      const unsupported = await http()
        .post(documents)
        .set(editor)
        .send({ version: 1, data: text.padEnd(Math.ceil(text.length / 4) * 4, '=') })
        .expect(415);
      expect((unsupported.body as { code: string }).code).toBe('file.unsupported-type');
      expect(vault.objects.size).toBe(0);

      const added = await http().post(documents).set(editor).send({ version: 1, data }).expect(201);
      const file = added.body as { documentId: string; version: number; mediaType: string };
      expect(file).toMatchObject({
        certificateId,
        version: 2,
        position: 1,
        mediaType: 'image/png',
      });
      expect([...vault.objects.keys()]).toEqual([`certification/platform/${file.documentId}`]);
      const one = await http().get(`${base}/${certificateId}`).set(moderator).expect(200);
      expect(one.body).toMatchObject({
        version: 2,
        draft: { documents: [{ documentId: file.documentId, position: 1 }] },
      });
      expect(JSON.stringify(one.body)).not.toContain('objectKey');
      expect(JSON.stringify(one.body)).not.toContain('Sha256');

      // No reviewer download route: the file is only listed.
      await http().get(`${documents}/${file.documentId}`).set(editor).expect(404);

      // The checks need the approve key.
      const check = await http()
        .post(`${base}/${certificateId}/checks`)
        .set(editor)
        .send({ version: 2, revisionId: id(0xe777), checkCode: 'document-legible', result: 'done' })
        .expect(403);
      expect((check.body as { code: string }).code).toBe('access.denied');

      await http().delete(`${documents}/${file.documentId}?version=2`).set(moderator).expect(403);
      await http().delete(`${documents}/${file.documentId}?version=x`).set(editor).expect(400);
      const removed = await http()
        .delete(`${documents}/${file.documentId}?version=2`)
        .set(editor)
        .expect(200);
      expect(removed.body).toEqual({
        certificateId,
        documentId: file.documentId,
        deleted: true,
        version: 3,
      });
      expect(vault.objects.size).toBe(0);
      const gone = await http()
        .delete(`${documents}/${file.documentId}?version=3`)
        .set(editor)
        .expect(404);
      expect((gone.body as { code: string }).code).toBe('document.not-found');
    });

    it('records a draft with the edit key, then reads and lists it; refuses no CSRF, a bad body, an unknown or self-declared type', async () => {
      await boot();
      seedTypes(code);
      await seeded(code);
      const h = headersOf(code, EDITOR, 2);
      const noCsrf: Record<string, string> = { ...h };
      delete noCsrf['x-csrf-token'];
      await http().post(base).set(noCsrf).send({ typeId: TYPE }).expect(403);
      const malformed = await http().post(base).set(h).send({ typeId: 'nope' }).expect(400);
      expect(malformed.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'typeId' }] },
      });
      await http().post(base).set(h).send({ typeId: TYPE, status: 'approved' }).expect(400);
      const unknown = await http()
        .post(base)
        .set(h)
        .send({ typeId: id(0xc4ff) })
        .expect(404);
      expect((unknown.body as { code: string }).code).toBe('type.not-found');
      const self = await http().post(base).set(h).send({ typeId: SELF_TYPE }).expect(422);
      expect((self.body as { code: string }).code).toBe('type.manufacturer-basis-not-allowed');
      expect(products.roots.size).toBe(0);

      const created = await http().post(base).set(h).send({ typeId: TYPE }).expect(201);
      const body = created.body as { certificateId: string; status: string; version: number };
      expect(body).toMatchObject({ status: 'draft', version: 1 });

      const one = await http().get(`${base}/${body.certificateId}`).set(h).expect(200);
      expect(one.headers['cache-control']).toContain('no-store');
      expect(one.body).toMatchObject({
        id: body.certificateId,
        typeId: TYPE,
        status: 'draft',
        version: 1,
        author: { accountId: EDITOR },
        pending: null,
        approved: null,
      });
      expect(JSON.stringify(one.body)).not.toContain('certificateNumber"');
      const list = await http().get(`${base}?status=draft`).set(h).expect(200);
      expect((list.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
        body.certificateId,
      ]);
      await http().get(`${base}?status=lost`).set(h).expect(400);
      await http()
        .get(`${base}/${id(0xe5ff)}`)
        .set(h)
        .expect(404);
    });
  });
});
