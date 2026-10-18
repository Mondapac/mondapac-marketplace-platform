import { createHash } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ProductCertificateCipher } from '../../src/modules/certification/application/ports/product-certificate-cipher';
import type { ReviewPolicyProvider } from '../../src/modules/certification/application/ports/review.ports';
import type { ProductCertificationDependencies } from '../../src/modules/certification/application/product/product-certification.shared';
import { ProductCertificateApprove } from '../../src/modules/certification/application/use-cases/product-certificate-approve.use-case';
import { ProductCertificateCreate } from '../../src/modules/certification/application/use-cases/product-certificate-create.use-case';
import { ProductCertificateRead } from '../../src/modules/certification/application/use-cases/product-certificate-read.use-case';
import { ProductCertificateReject } from '../../src/modules/certification/application/use-cases/product-certificate-reject.use-case';
import { ProductCertificateReviewRead } from '../../src/modules/certification/application/use-cases/product-certificate-review-read.use-case';
import { ProductCertificateSaveDraft } from '../../src/modules/certification/application/use-cases/product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from '../../src/modules/certification/application/use-cases/product-certificate-submit.use-case';
import { ProductCertificatesList } from '../../src/modules/certification/application/use-cases/product-certificates-list.use-case';
import type {
  CertificationTypeCode,
  TimeZoneId,
} from '../../src/modules/certification/domain/claim-types';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import { PrismaCertificationRegistryRepository } from '../../src/modules/certification/infrastructure/prisma-certification-registry.repository';
import { PrismaClaimFactsReader } from '../../src/modules/certification/infrastructure/prisma-claim-facts.reader';
import { PrismaProductCertificationRepository } from '../../src/modules/certification/infrastructure/prisma-product-certification.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { FakeCatalogReferences } from '../support/certification-claim-policy-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The manufacturer certificate of certification slice 14 on PostgreSQL, for both Market fixtures
// (design 3.4; data design 3.15, 3.16; ADR-0012 d3; AC 20; CERT-41; M3): the admin use cases over
// the real repository, registry, outbox and audit log (catalog's references and the number's
// cipher as fakes: no catalog rows and no subject keys are needed). Proved here: a draft is
// recorded with its coverage at the product's published revision, submitted as a pending revision
// that records the type revision (I1) and its editors, approved only by another person (the
// creator, an editor and the submitter are refused; so is the database CHECK), with the boundary
// in the Market zone and one event in the same unit; a second approval of other coverage is
// `coverage-changed`; a rejection keeps the approved revision; S3 reads the approval; the
// insert-only tables refuse UPDATE and DELETE; the other Market sees nothing.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

/** A deterministic stand-in for the platform-subject cipher: shaped like the v1 envelope. */
const cipher: ProductCertificateCipher = {
  sealNumber: (_m, holder, number) =>
    Promise.resolve(
      `v1.${Buffer.from(`${holder}:${number}`.padEnd(40, '~')).toString('base64url')}`,
    ),
  openNumber: (_m, holder, sealed) => {
    const text = Buffer.from(sealed.slice(3), 'base64url').toString().replace(/~+$/u, '');
    if (!text.startsWith(`${holder}:`)) throw new Error('wrong label');
    return Promise.resolve(text.slice(holder.length + 1));
  },
  sealHistoryNote: (_m, note) =>
    Promise.resolve(`v1.${Buffer.from(`note:${note}`.padEnd(40, '~')).toString('base64url')}`),
  contentHash: (_m, content) =>
    Promise.resolve(`hmac-sha256:${createHash('sha256').update(content).digest('hex')}`),
};

const reviewPolicies: ReviewPolicyProvider = {
  policyFor: () => ({
    checks: [],
    reasons: [
      {
        code: 'not-genuine',
        check: null,
        nextStep: 'contact-support',
        label: 'Not genuine',
        outcomes: ['declined'],
      },
    ],
    issuerRequestReasons: [],
  }),
};

async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function refusal<T, E>(promise: Promise<Result<T, E>>): Promise<E> {
  const result = await promise;
  if (result.ok) throw new Error(`unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe.each(TEST_MARKETS)('manufacturer certificates in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const zone = markets.get(market.marketId).timezone as TimeZoneId;
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let audit: AuditWriter;
  let catalog: FakeCatalogReferences;
  let deps: ProductCertificationDependencies;

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('certification', CERTIFICATION_AUDIT_ACTIONS);
    auditCatalogue.seal();
    audit = PersistenceModule.auditWriterFor('certification').useFactory(
      auditCatalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    const events = new EventCatalogue();
    events.register('certification', CERTIFICATION_EVENTS);
    events.seal();
    catalog = new FakeCatalogReferences();
    deps = {
      unitOfWork: persistence.unitOfWork,
      products: new PrismaProductCertificationRepository(persistence.service, ids),
      registry: new PrismaCertificationRegistryRepository(persistence.service),
      catalog,
      cipher,
      reviewPolicies,
      audit,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        persistence.service,
        events,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('certification'),
      clock: new FixedClock(T0),
      ids,
      marketZone: (m: MarketContext) => markets.get(m.marketId).timezone as TimeZoneId,
    };
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  const useCases = () => ({
    create: new ProductCertificateCreate(gate, deps),
    save: new ProductCertificateSaveDraft(gate, deps),
    submit: new ProductCertificateSubmit(gate, deps),
    approve: new ProductCertificateApprove(gate, deps),
    reject: new ProductCertificateReject(gate, deps),
    read: new ProductCertificateRead(gate, deps),
    review: new ProductCertificateReviewRead(gate, deps),
    list: new ProductCertificatesList(gate, deps),
  });

  const admin = (accountId: string = uuid7()): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: accountId as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );

  /** An active third-party type without a document requirement (documents come later). */
  async function seedType(): Promise<{ typeId: string; revisionId: string; code: string }> {
    const typeId = uuid7();
    const revisionId = uuid7();
    const typeCode = `pc${typeId.slice(-10)}`;
    const scope = [market.marketId, market.tenantId];
    await sql.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
      [typeId, ...scope, typeCode, T0.toString()],
    );
    await sql.query('BEGIN');
    await sql.query(
      `INSERT INTO certification.certification_type_revisions
         (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
          requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
          badge_icon_key, author_account_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'THIRD_PARTY_DOCUMENT', true, false, true, 'SELLER_REQUIRED',
               false, 'halal', $5, $6)`,
      [revisionId, ...scope, typeId, uuid7(), T0.toString()],
    );
    await sql.query(
      `INSERT INTO certification.type_revision_texts
         (market_id, tenant_id, type_revision_id, locale, name, customer_description)
       VALUES ($1, $2, $3, 'en', 'Manufacturer type', 'Holds a certificate')`,
      [...scope, revisionId],
    );
    await sql.query(
      `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
       VALUES ($1, $2, $3, 'en', $4)`,
      [...scope, revisionId, `term${typeId.slice(-10)}`],
    );
    await sql.query('COMMIT');
    await owner.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, typeId],
    );
    return { typeId, revisionId, code: typeCode };
  }

  async function seedIssuer(typeId: string, state = 'active'): Promise<string> {
    const issuerId = uuid7();
    await sql.query(
      `INSERT INTO certification.issuers
         (id, market_id, tenant_id, type_id, display_name, display_name_key, state,
          expert_reference_ciphertext, state_changed_at, state_changed_by_kind, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, 'seed', 1, $8)`,
      [
        issuerId,
        market.marketId,
        market.tenantId,
        typeId,
        `Issuer ${issuerId}`,
        state,
        `v1.${'A'.repeat(40)}`,
        T0.toString(),
      ],
    );
    return issuerId;
  }

  /** A product published in catalog's fake at a revision, with variants. */
  function product(variants = 0) {
    const productId = uuid7() as Id<'Product'>;
    const revisionId = uuid7() as Id<'ProductRevision'>;
    const variantIds = Array.from({ length: variants }, () => uuid7() as Id<'Variant'>);
    catalog.publish(market, productId, revisionId, variantIds);
    return { productId, revisionId, variantIds };
  }

  const draftOf = (
    issuerId: string,
    coverage: readonly { productId: string; variantIds?: string[] | null }[],
    overrides: Record<string, unknown> = {},
  ) => ({
    manufacturerName: 'Maker Foods Pty Ltd',
    issuerId,
    certificateNumber: 'MFR-12345',
    issueDate: '2026-01-01',
    expiryDate: '2027-06-30',
    coverage: coverage.map((c) => ({ productId: c.productId, variantIds: c.variantIds ?? null })),
    ...overrides,
  });

  async function outboxOf(aggregateId: string) {
    const { rows } = await owner.query<{ type: string; payload: Record<string, string> }>(
      `SELECT type, payload FROM certification.outbox WHERE market_id = $1 AND aggregate_id = $2
        ORDER BY aggregate_version`,
      [market.marketId, aggregateId],
    );
    return rows;
  }

  /** A recorded, submitted certificate: the creator, the editor (submitter) and the revision. */
  async function submitted(coverage: ReturnType<typeof product>[] = [product()]) {
    const u = useCases();
    const type = await seedType();
    const issuerId = await seedIssuer(type.typeId);
    const creator = admin();
    const editor = admin();
    const created = await unwrap(u.create.execute(creator, { typeId: type.typeId }));
    const saved = await unwrap(
      u.save.execute(editor, {
        certificateId: created.certificateId,
        version: created.version,
        draft: draftOf(
          issuerId,
          coverage.map((p) => ({ productId: p.productId })),
        ),
      }),
    );
    const sent = await unwrap(
      u.submit.execute(editor, { certificateId: created.certificateId, version: saved.version }),
    );
    return { u, type, issuerId, creator, editor, created, sent };
  }

  it('records, submits and has another person approve: boundary in the Market zone, I1, event and audit in the unit', async () => {
    const p = product();
    const { u, type, creator, editor, created, sent } = await submitted([p]);
    expect(sent).toMatchObject({ revisionNo: 1, status: 'in-review' });

    // The creator, an editor and the submitter can never approve it (AC 20).
    for (const actor of [creator, editor]) {
      expect(
        await refusal(
          u.approve.execute(actor, {
            certificateId: created.certificateId,
            revisionId: sent.revisionId,
            version: sent.version,
          }),
        ),
      ).toEqual({ code: 'approval.same-admin' });
    }
    const approver = admin();
    const decided = await unwrap(
      u.approve.execute(approver, {
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: sent.version,
      }),
    );
    expect(decided).toMatchObject({ outcome: 'approved', status: 'approved' });

    const view = await unwrap(u.read.execute(approver, { certificateId: created.certificateId }));
    expect(view.status).toBe('approved');
    expect(view.pending).toBeNull();
    expect(view.approved).toMatchObject({
      id: sent.revisionId,
      typeRevisionId: type.revisionId,
      coverage: [{ productId: p.productId, productRevisionId: p.revisionId, variantId: null }],
      decision: { outcome: 'approved', boundaryZone: zone },
    });
    expect(view.approved!.editors.map((e) => e.accountId)).toEqual([
      editor.actor.kind === 'authenticated' ? editor.actor.accountId : '',
    ]);
    expect(view.approvedBoundaryAt).toBe(
      code === 'AU' ? '2027-06-30T14:00:00Z' : '2027-06-30T15:00:00Z',
    );
    // The view never holds the number; the review read decrypts it.
    expect(JSON.stringify(view)).not.toContain('MFR-12345');
    const review = await unwrap(
      u.review.execute(approver, { certificateId: created.certificateId }),
    );
    expect(review.approved?.certificateNumber).toBe('MFR-12345');
    expect(review.draft.certificateNumber).toBe('MFR-12345');

    expect(await outboxOf(created.certificateId)).toEqual([
      {
        type: 'certification.product-certification-approved.v1',
        payload: {
          productCertificationId: created.certificateId,
          revisionId: sent.revisionId,
          typeId: type.typeId,
        },
      },
    ]);
    const { rows: audits } = await owner.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE market_id = $1 AND target_id = $2
        ORDER BY occurred_at, action`,
      [market.marketId, created.certificateId],
    );
    expect(audits.map((a) => a.action).sort()).toEqual(
      [
        'certification.product-certificate.number-viewed',
        'certification.product-certification.approved',
        'certification.product-certification.edited',
        'certification.product-certification.edited',
        'certification.product-certification.recorded',
      ].sort(),
    );

    // S3 reads the approval for the covered revision only (M3), with the certificate's own type
    // revision (I1).
    const reader = new PrismaClaimFactsReader(
      persistence.unitOfWork,
      new PrismaRawReadPort(persistence.root).forModule('certification'),
    );
    const ask = (revisionId: string) => ({
      typeCode: type.code as CertificationTypeCode,
      productId: p.productId,
      productRevisionId: revisionId as Id<'ProductRevision'>,
      variantId: null,
    });
    const [covered, moved] = await reader.productCertificates(market, [
      ask(p.revisionId),
      ask(uuid7()),
    ]);
    expect(covered!.certificates.map((c) => c.approved?.typeRevisionId)).toEqual([type.revisionId]);
    expect(moved!.certificates).toEqual([]);
    const [elsewhere] = await reader.productCertificates(other, [ask(p.revisionId)]);
    expect(elsewhere!.certificates).toEqual([]);
  });

  it('records each editor of the draft: an admin who only saved the draft cannot approve', async () => {
    const u = useCases();
    const type = await seedType();
    const issuerId = await seedIssuer(type.typeId);
    const p = product();
    const created = await unwrap(u.create.execute(admin(), { typeId: type.typeId }));
    const firstEditor = admin();
    const saved = await unwrap(
      u.save.execute(firstEditor, {
        certificateId: created.certificateId,
        version: 1,
        draft: draftOf(issuerId, [{ productId: p.productId }]),
      }),
    );
    const submitter = admin();
    const sent = await unwrap(
      u.submit.execute(submitter, { certificateId: created.certificateId, version: saved.version }),
    );
    expect(
      await refusal(
        u.approve.execute(firstEditor, {
          certificateId: created.certificateId,
          revisionId: sent.revisionId,
          version: sent.version,
        }),
      ),
    ).toEqual({ code: 'approval.same-admin' });
    // The database half: a decision by the record's author is refused by its CHECK.
    const { rows } = await owner.query<{ author_account_id: string }>(
      `SELECT author_account_id FROM certification.product_certification_revisions WHERE id = $1`,
      [sent.revisionId],
    );
    const state = await sql
      .query(
        `INSERT INTO certification.product_revision_decisions
           (market_id, tenant_id, revision_id, outcome, author_account_id, decided_by_account_id, decided_at)
         VALUES ($1, $2, $3, 'rejected', $4, $4, $5)`,
        [
          market.marketId,
          market.tenantId,
          sent.revisionId,
          rows[0]!.author_account_id,
          T0.toString(),
        ],
      )
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint ?? 'unknown',
      );
    expect(state).toBe('product_revision_decisions_not_author_check');
  });

  it('refuses coverage of an unpublished product, an unknown variant and an issuer of another type', async () => {
    const u = useCases();
    const type = await seedType();
    const issuerId = await seedIssuer(type.typeId);
    const otherType = await seedType();
    const foreignIssuer = await seedIssuer(otherType.typeId);
    const p = product(2);
    const created = await unwrap(u.create.execute(admin(), { typeId: type.typeId }));
    const save = (draft: Record<string, unknown>) =>
      refusal(u.save.execute(admin(), { certificateId: created.certificateId, version: 1, draft }));
    expect(await save(draftOf(issuerId, [{ productId: uuid7() }]))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'coverage[0].productId', code: 'product-unknown' }],
    });
    expect(
      await save(draftOf(issuerId, [{ productId: p.productId, variantIds: [uuid7()] }])),
    ).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'coverage[0].variantIds[0]', code: 'variant-unknown' }],
    });
    expect(await save(draftOf(foreignIssuer, [{ productId: p.productId }]))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'issuerId', code: 'unknown' }],
    });
    // A narrowed entry stores one row per variant at the product's published revision.
    const saved = await unwrap(
      u.save.execute(admin(), {
        certificateId: created.certificateId,
        version: 1,
        draft: draftOf(issuerId, [{ productId: p.productId, variantIds: p.variantIds }]),
      }),
    );
    expect(saved.coverageEntries).toBe(2);
  });

  it('refuses to submit when a covered product published a newer revision since the save (M3)', async () => {
    const u = useCases();
    const type = await seedType();
    const issuerId = await seedIssuer(type.typeId);
    const p = product();
    const created = await unwrap(u.create.execute(admin(), { typeId: type.typeId }));
    const saved = await unwrap(
      u.save.execute(admin(), {
        certificateId: created.certificateId,
        version: 1,
        draft: draftOf(issuerId, [{ productId: p.productId }]),
      }),
    );
    catalog.publish(market, p.productId, uuid7() as Id<'ProductRevision'>);
    expect(
      await refusal(
        u.submit.execute(admin(), { certificateId: created.certificateId, version: saved.version }),
      ),
    ).toEqual({
      code: 'certificate.incomplete',
      fields: [{ path: 'coverage[0].productRevisionId', code: 'product-revision-changed' }],
    });
  });

  it('refuses to approve under a deactivated issuer (share-locked in the unit)', async () => {
    const { u, issuerId, created, sent } = await submitted();
    await owner.query(`UPDATE certification.issuers SET state = 'closed-to-new' WHERE id = $1`, [
      issuerId,
    ]);
    expect(
      await refusal(
        u.approve.execute(admin(), {
          certificateId: created.certificateId,
          revisionId: sent.revisionId,
          version: sent.version,
        }),
      ),
    ).toEqual({ code: 'issuer.not-active' });
  });

  it('a second approval of other coverage is coverage-changed; a rejection keeps the approved revision', async () => {
    const first = product();
    const { u, type, issuerId, created, sent } = await submitted([first]);
    const approved = await unwrap(
      u.approve.execute(admin(), {
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: sent.version,
      }),
    );
    const second = product();
    const editor = admin();
    const saved = await unwrap(
      u.save.execute(editor, {
        certificateId: created.certificateId,
        version: approved.version,
        draft: draftOf(issuerId, [{ productId: first.productId }, { productId: second.productId }]),
      }),
    );
    const sent2 = await unwrap(
      u.submit.execute(editor, { certificateId: created.certificateId, version: saved.version }),
    );
    expect(sent2).toMatchObject({ revisionNo: 2, status: 'approved' });
    // While N+1 waits, N stays the approved revision (T3); the draft may not be edited.
    expect(
      await refusal(
        u.save.execute(editor, {
          certificateId: created.certificateId,
          version: sent2.version,
          draft: draftOf(issuerId, [{ productId: first.productId }]),
        }),
      ),
    ).toEqual({ code: 'certificate.not-editable' });
    await unwrap(
      u.approve.execute(admin(), {
        certificateId: created.certificateId,
        revisionId: sent2.revisionId,
        version: sent2.version,
      }),
    );
    const events = await outboxOf(created.certificateId);
    expect(events.map((e) => e.type)).toEqual([
      'certification.product-certification-approved.v1',
      'certification.product-certification-coverage-changed.v1',
    ]);
    expect(events[1]!.payload).toEqual({
      productCertificationId: created.certificateId,
      revisionId: sent2.revisionId,
      previousRevisionId: sent.revisionId,
      typeId: type.typeId,
    });

    // A rejected third revision leaves the second approved.
    const view = await unwrap(u.read.execute(admin(), { certificateId: created.certificateId }));
    const saved3 = await unwrap(
      u.save.execute(editor, {
        certificateId: created.certificateId,
        version: view.version,
        draft: draftOf(issuerId, [{ productId: second.productId }]),
      }),
    );
    const sent3 = await unwrap(
      u.submit.execute(editor, { certificateId: created.certificateId, version: saved3.version }),
    );
    const rejecter = admin();
    expect(
      await refusal(
        u.reject.execute(rejecter, {
          certificateId: created.certificateId,
          revisionId: sent3.revisionId,
          version: sent3.version,
          reasonCode: 'made-up',
        }),
      ),
    ).toEqual({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'unknown' }] });
    const rejected = await unwrap(
      u.reject.execute(rejecter, {
        certificateId: created.certificateId,
        revisionId: sent3.revisionId,
        version: sent3.version,
        reasonCode: 'not-genuine',
      }),
    );
    expect(rejected).toMatchObject({ outcome: 'rejected', status: 'approved' });
    const after = await unwrap(u.read.execute(admin(), { certificateId: created.certificateId }));
    expect(after.approved?.id).toBe(sent2.revisionId);
    expect(after.pending).toBeNull();
    expect((await outboxOf(created.certificateId)).length).toBe(2);
  });

  it('a rejection of a first revision ends the record rejected; a stale version is conflict.stale', async () => {
    const { u, created, sent } = await submitted();
    expect(
      await refusal(
        u.reject.execute(admin(), {
          certificateId: created.certificateId,
          revisionId: sent.revisionId,
          version: sent.version - 1,
          reasonCode: 'not-genuine',
        }),
      ),
    ).toEqual({ code: 'conflict.stale' });
    const rejected = await unwrap(
      u.reject.execute(admin(), {
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: sent.version,
        reasonCode: 'not-genuine',
      }),
    );
    expect(rejected.status).toBe('rejected');
    expect(await outboxOf(created.certificateId)).toEqual([]);
  });

  it('refuses the creator, an editor and a submitter who never saved the draft both decisions (Hassan L3)', async () => {
    const u = useCases();
    const type = await seedType();
    const issuerId = await seedIssuer(type.typeId);
    const p = product();
    const creator = admin();
    const editor = admin();
    const submitter = admin();
    const created = await unwrap(u.create.execute(creator, { typeId: type.typeId }));
    const saved = await unwrap(
      u.save.execute(editor, {
        certificateId: created.certificateId,
        version: created.version,
        draft: draftOf(issuerId, [{ productId: p.productId }]),
      }),
    );
    const sent = await unwrap(
      u.submit.execute(submitter, { certificateId: created.certificateId, version: saved.version }),
    );
    const decision = { certificateId: created.certificateId, revisionId: sent.revisionId };
    for (const actor of [creator, editor, submitter]) {
      expect(
        await refusal(
          u.reject.execute(actor, {
            ...decision,
            version: sent.version,
            reasonCode: 'not-genuine',
          }),
        ),
      ).toEqual({ code: 'approval.same-admin' });
    }
    expect(
      await refusal(u.approve.execute(submitter, { ...decision, version: sent.version })),
    ).toEqual({ code: 'approval.same-admin' });
    // Another person may decide.
    expect(
      await unwrap(
        u.reject.execute(admin(), {
          ...decision,
          version: sent.version,
          reasonCode: 'not-genuine',
        }),
      ),
    ).toMatchObject({ outcome: 'rejected' });
  });

  it('audits each review read once, after the numbers are opened, naming the revisions and never the number (Hassan M1)', async () => {
    const { u, created, sent } = await submitted();
    const approverId = uuid7();
    const approver = admin(approverId);
    const viewed = async () => {
      const { rows } = await owner.query<{ after: Record<string, unknown>; actor_id: string }>(
        `SELECT after, actor_id FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2
            AND action = 'certification.product-certificate.number-viewed'
          ORDER BY occurred_at, id`,
        [market.marketId, created.certificateId],
      );
      return rows;
    };
    // The plain read opens nothing and writes nothing.
    await unwrap(u.read.execute(approver, { certificateId: created.certificateId }));
    expect(await viewed()).toEqual([]);

    const pending = await unwrap(
      u.review.execute(approver, { certificateId: created.certificateId }),
    );
    expect(pending.pending?.certificateNumber).toBe('MFR-12345');
    expect(await viewed()).toEqual([
      { after: { revisionIds: [sent.revisionId] }, actor_id: approverId },
    ]);
    const decided = await unwrap(
      u.approve.execute(approver, {
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: sent.version,
      }),
    );
    expect(decided.status).toBe('approved');
    await unwrap(u.review.execute(approver, { certificateId: created.certificateId }));
    const rows = await viewed();
    expect(rows.map((r) => r.after)).toEqual([
      { revisionIds: [sent.revisionId] },
      { revisionIds: [sent.revisionId] },
    ]);
    expect(JSON.stringify(rows)).not.toContain('MFR-12345');
    // A read of another Market's id is not found and audits nothing.
    const elsewhere = await refusal(
      u.review.execute(
        testCallContext(
          other,
          testAuthenticatedActor(other, {
            population: 'admin',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: null,
          }),
        ),
        { certificateId: created.certificateId },
      ),
    );
    expect(elsewhere).toEqual({ code: 'certificate.not-found' });
    expect(await viewed()).toHaveLength(2);
  });

  it('S3 never covers through a pending revision or a superseded approved one (Hassan L3)', async () => {
    const first = product();
    const second = product();
    const { u, type, issuerId, created, sent } = await submitted([first]);
    const reader = new PrismaClaimFactsReader(
      persistence.unitOfWork,
      new PrismaRawReadPort(persistence.root).forModule('certification'),
    );
    const ask = (p: ReturnType<typeof product>) => ({
      typeCode: type.code as CertificationTypeCode,
      productId: p.productId,
      productRevisionId: p.revisionId,
      variantId: null,
    });
    const covered = async () =>
      (await reader.productCertificates(market, [ask(first), ask(second)])).map((a) =>
        a.certificates.map((c) => c.approved?.revisionId ?? null),
      );
    // Pending only: nothing covers.
    expect(await covered()).toEqual([[], []]);
    const approved = await unwrap(
      u.approve.execute(admin(), {
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: sent.version,
      }),
    );
    expect(await covered()).toEqual([[sent.revisionId], []]);

    // Revision 2 moves the coverage to the second product; while pending it covers nothing.
    const editor = admin();
    const saved = await unwrap(
      u.save.execute(editor, {
        certificateId: created.certificateId,
        version: approved.version,
        draft: draftOf(issuerId, [{ productId: second.productId }]),
      }),
    );
    const sent2 = await unwrap(
      u.submit.execute(editor, { certificateId: created.certificateId, version: saved.version }),
    );
    expect(await covered()).toEqual([[sent.revisionId], []]);
    await unwrap(
      u.approve.execute(admin(), {
        certificateId: created.certificateId,
        revisionId: sent2.revisionId,
        version: sent2.version,
      }),
    );
    // Revision 1 is superseded: its coverage of the first product no longer counts.
    expect(await covered()).toEqual([[], [sent2.revisionId]]);
  });

  it('reads the coverage of one revision from its own index (Mojtaba F1)', async () => {
    await owner.query('SET enable_seqscan = off');
    try {
      const plan = await owner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id, product_id, product_revision_id, variant_id
           FROM certification.product_revision_coverage
          WHERE market_id = $1 AND revision_id = $2 AND type_id = $3`,
        [market.marketId, uuid7(), uuid7()],
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'product_revision_coverage_market_id_revision_id_type_id_idx',
      );
    } finally {
      await owner.query('RESET enable_seqscan');
    }
  });

  it('lists the Market only, and keeps revisions, coverage, editors, decisions and history insert-only', async () => {
    const { u, created, sent } = await submitted();
    const listed = await unwrap(u.list.execute(admin(), { status: 'in-review', limit: 100 }));
    expect(listed.items.map((i) => i.id)).toContain(created.certificateId);
    const otherList = await unwrap(
      new ProductCertificatesList(gate, deps).execute(
        testCallContext(
          other,
          testAuthenticatedActor(other, {
            population: 'admin',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: null,
          }),
        ),
        { limit: 100 },
      ),
    );
    expect(otherList.items.map((i) => i.id)).not.toContain(created.certificateId);
    for (const table of [
      'product_certification_revisions',
      'product_revision_coverage',
      'product_revision_editors',
      'product_certification_history',
    ]) {
      const column =
        table === 'product_certification_revisions'
          ? 'id'
          : table === 'product_certification_history'
            ? 'revision_id'
            : 'revision_id';
      const update = await sql
        .query(`UPDATE certification.${table} SET market_id = market_id WHERE ${column} = $1`, [
          sent.revisionId,
        ])
        .then(
          () => null,
          (error: { code?: string }) => error.code ?? 'unknown',
        );
      expect([table, update]).toEqual([table, '42501']);
      const ownerDelete = await owner
        .query(`DELETE FROM certification.${table} WHERE ${column} = $1`, [sent.revisionId])
        .then(
          () => null,
          (error: { code?: string }) => error.code ?? 'unknown',
        );
      expect([table, ownerDelete]).toEqual([table, '23001']);
    }
  });
});
