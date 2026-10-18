import { createHash } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import sharp from 'sharp';
import type { ProductCertificateCipher } from '../../src/modules/certification/application/ports/product-certificate-cipher';
import type { ReviewPolicyProvider } from '../../src/modules/certification/application/ports/review.ports';
import type { ProductCertificationDependencies } from '../../src/modules/certification/application/product/product-certification.shared';
import { ProductCertificateApprove } from '../../src/modules/certification/application/use-cases/product-certificate-approve.use-case';
import { ProductCertificateCreate } from '../../src/modules/certification/application/use-cases/product-certificate-create.use-case';
import { ProductCertificateRead } from '../../src/modules/certification/application/use-cases/product-certificate-read.use-case';
import { ProductCertificateReviewRead } from '../../src/modules/certification/application/use-cases/product-certificate-review-read.use-case';
import { ProductCertificateSaveDraft } from '../../src/modules/certification/application/use-cases/product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from '../../src/modules/certification/application/use-cases/product-certificate-submit.use-case';
import { ProductCertificateRecordCheck } from '../../src/modules/certification/application/use-cases/product-certificate-record-check.use-case';
import { ProductCertificateRemoveDocument } from '../../src/modules/certification/application/use-cases/product-certificate-remove-document.use-case';
import { ProductCertificateUploadDocument } from '../../src/modules/certification/application/use-cases/product-certificate-upload-document.use-case';
import type { TimeZoneId } from '../../src/modules/certification/domain/claim-types';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import { PrismaCertificationRegistryRepository } from '../../src/modules/certification/infrastructure/prisma-certification-registry.repository';
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
import { SharpDocumentIntake } from '../../src/modules/certification/infrastructure/sharp-document-intake';
import { MemoryPlatformVault } from '../support/certification-fakes';

// The files and review checks of a manufacturer certificate (certification slice 15 part 2) on
// PostgreSQL, for both Market fixtures (design 3.4 rows 1 to 3; data design 3.15, 3.16; AC 20, 21):
// the admin use cases over the real repository, intake (sharp), registry, outbox and audit log
// (catalog's references, the number's cipher and the platform vault as fakes). Proved here: a type
// that requires a document refuses the submission without one; a file added to the draft is
// sealed into the revision at submission; the approval waits for every required check, recorded
// by a person who did not edit the revision (an editor's check is refused); removing a file no
// revision holds deletes it, one a revision holds only leaves the draft; only a clean file of the
// product-certificate purpose is linked; a revision's files and checks are insert-only; the
// other Market sees nothing.

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
    checks: [
      { code: 'document-legible', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
      { code: 'issuer-matches', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
      { code: 'scope-noted', required: false, modes: ['THIRD_PARTY_DOCUMENT'] },
      { code: 'selfie-matches', required: true, modes: ['SELF_DECLARATION'] },
    ],
    reasons: [],
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

describe.each(TEST_MARKETS)(
  'manufacturer certificate files and checks in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let persistence: Persistence;
    let sql: Client;
    let owner: Client;
    let audit: AuditWriter;
    let catalog: FakeCatalogReferences;
    let deps: ProductCertificationDependencies;
    let vault: MemoryPlatformVault;

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
      vault = new MemoryPlatformVault();
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
        intake: new SharpDocumentIntake(),
        documents: vault,
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
      upload: new ProductCertificateUploadDocument(gate, deps),
      remove: new ProductCertificateRemoveDocument(gate, deps),
      submit: new ProductCertificateSubmit(gate, deps),
      check: new ProductCertificateRecordCheck(gate, deps),
      approve: new ProductCertificateApprove(gate, deps),
      read: new ProductCertificateRead(gate, deps),
      review: new ProductCertificateReviewRead(gate, deps),
    });

    const adminIn = (m: MarketContext, accountId: string = uuid7()): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId: accountId as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
    const admin = (accountId?: string) => adminIn(market, accountId);

    /** An active third-party type that requires a document. */
    async function seedType(): Promise<{ typeId: string; revisionId: string }> {
      const typeId = uuid7();
      const revisionId = uuid7();
      const scope = [market.marketId, market.tenantId];
      await sql.query(
        `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
        [typeId, ...scope, `pd${typeId.slice(-10)}`, T0.toString()],
      );
      await sql.query('BEGIN');
      await sql.query(
        `INSERT INTO certification.certification_type_revisions
         (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
          requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
          badge_icon_key, author_account_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'THIRD_PARTY_DOCUMENT', true, true, true, 'SELLER_REQUIRED',
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
      return { typeId, revisionId };
    }

    async function seedIssuer(typeId: string): Promise<string> {
      const issuerId = uuid7();
      await sql.query(
        `INSERT INTO certification.issuers
         (id, market_id, tenant_id, type_id, display_name, display_name_key, state,
          expert_reference_ciphertext, state_changed_at, state_changed_by_kind, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $5, 'active', $6, $7, 'seed', 1, $7)`,
        [
          issuerId,
          market.marketId,
          market.tenantId,
          typeId,
          `Issuer ${issuerId}`,
          `v1.${'A'.repeat(40)}`,
          T0.toString(),
        ],
      );
      return issuerId;
    }

    const png = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer()
        .then((bytes) => bytes.toString('base64'));

    /** A saved draft of a type that requires a document: the creator, the editor and the record. */
    async function saved() {
      const u = useCases();
      const type = await seedType();
      const issuerId = await seedIssuer(type.typeId);
      const productId = uuid7() as Id<'Product'>;
      catalog.publish(market, productId, uuid7() as Id<'ProductRevision'>, []);
      const creator = admin();
      const editor = admin();
      const created = await unwrap(u.create.execute(creator, { typeId: type.typeId }));
      const draft = await unwrap(
        u.save.execute(editor, {
          certificateId: created.certificateId,
          version: created.version,
          draft: {
            manufacturerName: 'Maker Foods Pty Ltd',
            issuerId,
            certificateNumber: 'MFR-12345',
            issueDate: '2026-01-01',
            expiryDate: '2027-06-30',
            coverage: [{ productId, variantIds: null }],
          },
        }),
      );
      return {
        u,
        type,
        creator,
        editor,
        certificateId: created.certificateId,
        version: draft.version,
      };
    }

    async function count(table: string, column: string, value: string): Promise<number> {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM certification.${table} WHERE market_id = $1 AND ${column} = $2`,
        [market.marketId, value],
      );
      return Number(rows[0]!.n);
    }

    it('refuses the submission without the required file; seals the file at submission; approves only once another person did every required check', async () => {
      const { u, creator, editor, certificateId, version } = await saved();
      expect(await refusal(u.submit.execute(editor, { certificateId, version }))).toMatchObject({
        code: 'certificate.incomplete',
      });

      // A file the intake refuses is never stored.
      const text = Buffer.from('not a certificate at all').toString('base64');
      expect(
        await refusal(
          u.upload.execute(editor, {
            certificateId,
            version,
            data: text.padEnd(Math.ceil(text.length / 4) * 4, '='),
          }),
        ),
      ).toEqual({ code: 'file.unsupported-type' });
      expect(vault.objects.size).toBe(0);

      const uploader = admin();
      const file = await unwrap(
        u.upload.execute(uploader, { certificateId, version, data: await png('#008800') }),
      );
      expect(file).toMatchObject({ position: 1, mediaType: 'image/png', version: version + 1 });
      const { rows: stored } = await owner.query<{
        purpose: string;
        owner_seller_id: string | null;
        state: string;
        type_id: string;
      }>(
        `SELECT purpose, owner_seller_id, state, type_id FROM certification.uploaded_documents
        WHERE market_id = $1 AND id = $2`,
        [market.marketId, file.documentId],
      );
      expect(stored).toEqual([
        expect.objectContaining({
          purpose: 'product-certificate',
          owner_seller_id: null,
          state: 'clean',
        }),
      ]);

      const sent = await unwrap(u.submit.execute(editor, { certificateId, version: file.version }));
      expect(await count('product_revision_documents', 'revision_id', sent.revisionId)).toBe(1);
      // Sealed: the draft may not change while the revision is pending.
      expect(
        await refusal(
          u.upload.execute(editor, {
            certificateId,
            version: sent.version,
            data: await png('#000088'),
          }),
        ),
      ).toEqual({ code: 'certificate.not-editable' });
      expect(
        await refusal(
          u.remove.execute(editor, {
            certificateId,
            documentId: file.documentId,
            version: sent.version,
          }),
        ),
      ).toEqual({ code: 'certificate.not-editable' });

      // The approval waits for every required check of the Market's list.
      const reviewer = admin();
      const decide = (actor: CallContext, v: number) =>
        u.approve.execute(actor, { certificateId, revisionId: sent.revisionId, version: v });
      expect(await refusal(decide(reviewer, sent.version))).toMatchObject({
        code: 'review.checks-incomplete',
      });
      const review = await unwrap(u.review.execute(reviewer, { certificateId }));
      expect(review.reviewChecks).toEqual([
        { checkCode: 'document-legible', required: true },
        { checkCode: 'issuer-matches', required: true },
        { checkCode: 'scope-noted', required: false },
      ]);
      expect(review.pending!.documents.map((d) => d.documentId)).toEqual([file.documentId]);

      // The creator, an editor and an uploader record no check; nor a check of another mode.
      const tick = (actor: CallContext, v: number, checkCode: string, result = 'done') =>
        u.check.execute(actor, {
          certificateId,
          revisionId: sent.revisionId,
          version: v,
          checkCode,
          result,
        });
      for (const actor of [creator, editor, uploader]) {
        expect(await refusal(tick(actor, sent.version, 'document-legible'))).toEqual({
          code: 'approval.same-admin',
        });
      }
      expect(await refusal(tick(reviewer, sent.version, 'selfie-matches'))).toMatchObject({
        code: 'validation.failed',
      });
      const first = await unwrap(tick(reviewer, sent.version, 'document-legible', 'problem'));
      const second = await unwrap(tick(reviewer, first.version, 'issuer-matches'));
      // A required check last recorded as a problem keeps the approval closed.
      expect(await refusal(decide(reviewer, second.version))).toMatchObject({
        code: 'review.checks-incomplete',
      });
      const third = await unwrap(tick(reviewer, second.version, 'document-legible'));
      // An uploader is an editor of the revision: never its approver.
      expect(await refusal(decide(uploader, third.version))).toEqual({
        code: 'approval.same-admin',
      });
      expect(await unwrap(decide(reviewer, third.version))).toMatchObject({ status: 'approved' });

      const view = await unwrap(u.read.execute(reviewer, { certificateId }));
      expect(view.approved!.documents.map((d) => d.documentId)).toEqual([file.documentId]);
      expect(view.approved!.checks.map((c) => [c.checkCode, c.result])).toEqual([
        ['document-legible', 'done'],
        ['issuer-matches', 'done'],
      ]);
      expect(await count('product_revision_review_checks', 'revision_id', sent.revisionId)).toBe(3);
      const { rows: audits } = await owner.query<{ action: string }>(
        `SELECT action FROM platform.audit_log WHERE market_id = $1 AND target_id = $2`,
        [market.marketId, certificateId],
      );
      const actions = audits.map((a) => a.action);
      expect(actions.filter((a) => a.endsWith('.document-added'))).toHaveLength(1);
      expect(actions.filter((a) => a.endsWith('.check-recorded'))).toHaveLength(3);

      // The file the approved revision holds only leaves the draft; its row and object stay.
      const left = await unwrap(
        u.remove.execute(editor, {
          certificateId,
          documentId: file.documentId,
          version: view.version,
        }),
      );
      expect(left.deleted).toBe(false);
      expect(await count('uploaded_documents', 'id', file.documentId)).toBe(1);
      expect(vault.objects.has(`certification/platform/${file.documentId}`)).toBe(true);
      expect(
        await count('product_certification_draft_documents', 'document_id', file.documentId),
      ).toBe(0);
    });

    it('deletes a file no revision holds, with its object; refuses an eleventh file and a stale version', async () => {
      const { u, editor, certificateId, version } = await saved();
      let v = version;
      const files: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const added = await unwrap(
          u.upload.execute(editor, {
            certificateId,
            version: v,
            data: await png(`#${(i + 1).toString(16).padStart(2, '0')}0000`),
          }),
        );
        files.push(added.documentId);
        v = added.version;
      }
      expect(
        await refusal(
          u.upload.execute(editor, { certificateId, version: v, data: await png('#ffffff') }),
        ),
      ).toEqual({ code: 'document.limit-reached' });
      expect(
        await refusal(
          u.remove.execute(editor, { certificateId, documentId: files[0], version: v - 1 }),
        ),
      ).toEqual({ code: 'conflict.stale' });
      const removed = await unwrap(
        u.remove.execute(editor, { certificateId, documentId: files[0], version: v }),
      );
      expect(removed).toEqual({
        certificateId,
        documentId: files[0],
        deleted: true,
        version: v + 1,
      });
      expect(await count('uploaded_documents', 'id', files[0]!)).toBe(0);
      expect(vault.objects.has(`certification/platform/${files[0]}`)).toBe(false);
      // The next file takes the next place; the gap stays.
      const next = await unwrap(
        u.upload.execute(editor, { certificateId, version: v + 1, data: await png('#00ffff') }),
      );
      expect(next.position).toBe(11);
    });

    it('links only a clean file of the product-certificate purpose; keeps the revision files and checks insert-only; the other Market sees nothing', async () => {
      const { u, editor, certificateId, version, type } = await saved();
      const file = await unwrap(
        u.upload.execute(editor, { certificateId, version, data: await png('#123456') }),
      );
      const scope = [market.marketId, market.tenantId];
      const insertDocument = async (overrides: Record<string, unknown>) => {
        const id = uuid7();
        const row: Record<string, unknown> = {
          id,
          market_id: market.marketId,
          tenant_id: market.tenantId,
          owner_seller_id: null,
          purpose: 'product-certificate',
          type_id: type.typeId,
          state: 'clean',
          media_type: 'image/png',
          byte_size: 100,
          page_count: null,
          data_key_envelope: `v1.${Buffer.from(id).toString('base64url')}`,
          object_key: `certification/platform/${id}`,
          clean_sha256: createHash('sha256').update(id).digest(),
          version: 1,
          created_at: T0.toString(),
          ...overrides,
        };
        const columns = Object.keys(row);
        await sql.query(
          `INSERT INTO certification.uploaded_documents (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
        return id;
      };
      const link = (documentId: string, position: number) =>
        sql
          .query(
            `INSERT INTO certification.product_certification_draft_documents
             (market_id, tenant_id, product_certification_id, type_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [...scope, certificateId, type.typeId, documentId, position],
          )
          .then(
            () => null,
            (error: { code?: string }) => error.code ?? 'unknown',
          );
      const seller = await insertDocument({
        owner_seller_id: uuid7(),
        purpose: 'seller-certificate',
      });
      expect(await link(seller, 2)).toBe('23514');
      const received = await insertDocument({ state: 'received', clean_sha256: null });
      expect(await link(received, 3)).toBe('23514');

      const sent = await unwrap(u.submit.execute(editor, { certificateId, version: file.version }));
      const checked = await unwrap(
        u.check.execute(admin(), {
          certificateId,
          revisionId: sent.revisionId,
          version: sent.version,
          checkCode: 'document-legible',
          result: 'done',
        }),
      );
      expect(checked.version).toBe(sent.version + 1);
      for (const table of ['product_revision_documents', 'product_revision_review_checks']) {
        const update = await sql
          .query(`UPDATE certification.${table} SET market_id = market_id WHERE revision_id = $1`, [
            sent.revisionId,
          ])
          .then(
            () => null,
            (error: { code?: string }) => error.code ?? 'unknown',
          );
        expect([table, update]).toEqual([table, '42501']);
        const ownerDelete = await owner
          .query(`DELETE FROM certification.${table} WHERE revision_id = $1`, [sent.revisionId])
          .then(
            () => null,
            (error: { code?: string }) => error.code ?? 'unknown',
          );
        expect([table, ownerDelete]).toEqual([table, '23001']);
      }

      const stranger = adminIn(other);
      expect(await refusal(u.read.execute(stranger, { certificateId }))).toEqual({
        code: 'certificate.not-found',
      });
      expect(
        await refusal(
          u.upload.execute(stranger, {
            certificateId,
            version: checked.version,
            data: await png('#654321'),
          }),
        ),
      ).toEqual({ code: 'certificate.not-found' });
      // Lock first: the other Market finds no row at the version read.
      expect(
        await refusal(
          u.check.execute(stranger, {
            certificateId,
            revisionId: sent.revisionId,
            version: checked.version,
            checkCode: 'issuer-matches',
            result: 'done',
          }),
        ),
      ).toEqual({ code: 'conflict.stale' });
    });
  },
);
