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
import type { ProductCertificationDependencies } from '../../src/modules/certification/application/product/product-certification.shared';
import { ExpireProductCertificates } from '../../src/modules/certification/application/use-cases/expire-product-certificates.use-case';
import { ProductCertificateApprove } from '../../src/modules/certification/application/use-cases/product-certificate-approve.use-case';
import { ProductCertificateCreate } from '../../src/modules/certification/application/use-cases/product-certificate-create.use-case';
import { ProductCertificateHistoryRead } from '../../src/modules/certification/application/use-cases/product-certificate-history-read.use-case';
import { ProductCertificateRead } from '../../src/modules/certification/application/use-cases/product-certificate-read.use-case';
import { ProductCertificateReinstate } from '../../src/modules/certification/application/use-cases/product-certificate-reinstate.use-case';
import { ProductCertificateRevoke } from '../../src/modules/certification/application/use-cases/product-certificate-revoke.use-case';
import { ProductCertificateSaveDraft } from '../../src/modules/certification/application/use-cases/product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from '../../src/modules/certification/application/use-cases/product-certificate-submit.use-case';
import { ProductCertificateSuspend } from '../../src/modules/certification/application/use-cases/product-certificate-suspend.use-case';
import type {
  CertificationTypeCode,
  TimeZoneId,
} from '../../src/modules/certification/domain/claim-types';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import { expiryBoundary } from '../../src/modules/certification/domain/validity';
import { MarketConfigExpiryPolicy } from '../../src/modules/certification/infrastructure/market-config-expiry-policy';
import { PrismaCertificationRegistryRepository } from '../../src/modules/certification/infrastructure/prisma-certification-registry.repository';
import { PrismaClaimFactsReader } from '../../src/modules/certification/infrastructure/prisma-claim-facts.reader';
import { PrismaProductCertificationRepository } from '../../src/modules/certification/infrastructure/prisma-product-certification.repository';
import { CheckedInReviewPolicy } from '../../src/modules/certification/infrastructure/review-policy/checked-in-review-policy';
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

// Certification slice 15 on PostgreSQL, for both Market fixtures (design 3.4 rows 6 to 9, 8.6, 11;
// data design 3.15, 3.16, 3.18; ADR-0012 d3): a manufacturer certificate after its approval.
// Proved here: suspend and revoke need a reason of the Market's list for their outcome, write the
// status, one history row (reason code, sealed note, actor), one audit row and one event in the
// unit, and the claim (S3) stops at once; a revocation withdraws a pending revision; reinstate is
// by another person than the creator and the approved revision's editors, and only while the
// boundary is ahead; the expiry job warns once per threshold from 00:00 Market time and expires at
// the stored boundary as the system; the other Market sees nothing.
//
// The run database is shared with other specs running in parallel: the job's records here have
// expiry dates before 2026 and each job test runs its clock in its own earlier year, so the job's
// window (A9) never reaches another spec's records (they expire in 2027).

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
  openNumber: (_m, holder, sealed) =>
    Promise.resolve(
      Buffer.from(sealed.slice(3), 'base64url')
        .toString()
        .replace(/~+$/u, '')
        .slice(holder.length + 1),
    ),
  sealHistoryNote: (_m, note) =>
    Promise.resolve(`v1.${Buffer.from(`note:${note}`.padEnd(40, '~')).toString('base64url')}`),
  contentHash: (_m, content) =>
    Promise.resolve(`hmac-sha256:${createHash('sha256').update(content).digest('hex')}`),
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
  'manufacturer certificate lifecycle in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const zone = markets.get(market.marketId).timezone as TimeZoneId;
    const policies = new CheckedInReviewPolicy();
    const reasonFor = (outcome: 'suspended' | 'revoked') =>
      policies.policyFor(market).reasons.find((r) => r.outcomes.includes(outcome))!.code;
    /** A reason the Market lists for a revocation but not for a suspension. */
    const revokeOnly = () =>
      policies
        .policyFor(market)
        .reasons.find((r) => r.outcomes.includes('revoked') && !r.outcomes.includes('suspended'))!
        .code;
    let persistence: Persistence;
    let sql: Client;
    let owner: Client;
    let audit: AuditWriter;
    let catalog: FakeCatalogReferences;
    let clock: FixedClock;
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
      clock = new FixedClock(T0);
      deps = {
        unitOfWork: persistence.unitOfWork,
        products: new PrismaProductCertificationRepository(persistence.service, ids),
        registry: new PrismaCertificationRegistryRepository(persistence.service),
        catalog,
        cipher,
        reviewPolicies: policies,
        audit,
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          persistence.service,
          events,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('certification'),
        clock,
        ids,
        marketZone: (m: MarketContext) => markets.get(m.marketId).timezone as TimeZoneId,
      };
    });
    afterAll(async () => {
      await sql.end();
      await owner.end();
      await persistence.close();
    });
    beforeEach(() => clock.set(T0));

    const useCases = () => ({
      create: new ProductCertificateCreate(gate, deps),
      save: new ProductCertificateSaveDraft(gate, deps),
      submit: new ProductCertificateSubmit(gate, deps),
      approve: new ProductCertificateApprove(gate, deps),
      suspend: new ProductCertificateSuspend(gate, deps),
      revoke: new ProductCertificateRevoke(gate, deps),
      reinstate: new ProductCertificateReinstate(gate, deps),
      history: new ProductCertificateHistoryRead(gate, deps),
      read: new ProductCertificateRead(gate, deps),
    });

    const job = () =>
      new ExpireProductCertificates(gate, {
        unitOfWork: persistence.unitOfWork,
        products: deps.products,
        policies: new MarketConfigExpiryPolicy(markets),
        audit,
        outbox: deps.outbox,
        clock,
        ids,
        marketZone: deps.marketZone,
      });
    const runJob = (m: MarketContext = market) =>
      unwrap(job().execute(testCallContext(m, 'system', `db-${uuid7()}`), {}));

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
    const accountOf = (context: CallContext): string =>
      context.actor.kind === 'authenticated' ? context.actor.accountId : '';

    async function seedType(): Promise<{ typeId: string; code: string }> {
      const typeId = uuid7();
      const revisionId = uuid7();
      const typeCode = `pl${typeId.slice(-10)}`;
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
       VALUES ($1, $2, $3, 'en', 'Lifecycle type', 'Holds a certificate')`,
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
      return { typeId, code: typeCode };
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

    /**
     * An approved certificate expiring on `expiryDate`: recorded by the creator, edited and
     * submitted by the editor, approved by the approver, all at the clock's instant.
     */
    async function approved(expiryDate = '2027-06-30') {
      const u = useCases();
      const type = await seedType();
      const issuerId = await seedIssuer(type.typeId);
      const productId = uuid7() as Id<'Product'>;
      const productRevisionId = uuid7() as Id<'ProductRevision'>;
      catalog.publish(market, productId, productRevisionId, []);
      const creator = admin();
      const editor = admin();
      const approver = admin();
      const created = await unwrap(u.create.execute(creator, { typeId: type.typeId }));
      const saved = await unwrap(
        u.save.execute(editor, {
          certificateId: created.certificateId,
          version: created.version,
          draft: {
            manufacturerName: 'Maker Foods Pty Ltd',
            issuerId,
            certificateNumber: 'MFR-777',
            issueDate: null,
            expiryDate,
            coverage: [{ productId, variantIds: null }],
          },
        }),
      );
      const sent = await unwrap(
        u.submit.execute(editor, { certificateId: created.certificateId, version: saved.version }),
      );
      const decided = await unwrap(
        u.approve.execute(approver, {
          certificateId: created.certificateId,
          revisionId: sent.revisionId,
          version: sent.version,
        }),
      );
      return {
        u,
        type,
        issuerId,
        productId,
        productRevisionId,
        creator,
        editor,
        approver,
        certificateId: created.certificateId,
        revisionId: sent.revisionId,
        version: decided.version,
      };
    }

    async function outboxOf(aggregateId: string) {
      const { rows } = await owner.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM certification.outbox WHERE market_id = $1 AND aggregate_id = $2
        ORDER BY aggregate_version`,
        [market.marketId, aggregateId],
      );
      return rows;
    }

    async function auditsOf(targetId: string) {
      const { rows } = await owner.query<{
        action: string;
        actor_type: string;
        after: Record<string, unknown>;
      }>(
        `SELECT action, actor_type, after FROM platform.audit_log
        WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, action`,
        [market.marketId, targetId],
      );
      return rows;
    }

    async function historyRows(certificateId: string) {
      const { rows } = await owner.query<{
        from_status: string | null;
        to_status: string;
        revision_id: string | null;
        actor_kind: string;
        actor_account_id: string | null;
        reason_code: string | null;
        note_ciphertext: string | null;
      }>(
        `SELECT from_status, to_status, revision_id, actor_kind, actor_account_id, reason_code,
              note_ciphertext
         FROM certification.product_certification_history
        WHERE market_id = $1 AND product_certification_id = $2 ORDER BY occurred_at, id`,
        [market.marketId, certificateId],
      );
      return rows;
    }

    function claimReader() {
      return new PrismaClaimFactsReader(
        persistence.unitOfWork,
        new PrismaRawReadPort(persistence.root).forModule('certification'),
      );
    }

    async function covering(c: Awaited<ReturnType<typeof approved>>, m: MarketContext = market) {
      const [answer] = await claimReader().productCertificates(m, [
        {
          typeCode: c.type.code as CertificationTypeCode,
          productId: c.productId,
          productRevisionId: c.productRevisionId,
          variantId: null,
        },
      ]);
      return answer!.certificates.map((cert) => cert.certificateId);
    }

    it('suspends with a reason and a sealed note: the claim stops at once; another person reinstates', async () => {
      const c = await approved();
      expect(await covering(c)).toEqual([c.certificateId]);
      const suspender = admin();

      // The reason must be of the Market's list for the suspended outcome.
      expect(
        await refusal(
          c.u.suspend.execute(suspender, {
            certificateId: c.certificateId,
            version: c.version,
            reasonCode: revokeOnly(),
          }),
        ),
      ).toEqual({
        code: 'validation.failed',
        fields: [{ path: 'reasonCode', code: 'unknown' }],
      });

      clock.set(T0.add({ hours: 1 }));
      const suspended = await unwrap(
        c.u.suspend.execute(suspender, {
          certificateId: c.certificateId,
          version: c.version,
          reasonCode: reasonFor('suspended'),
          reasonText: 'Checking a complaint with the issuer.',
        }),
      );
      expect(suspended).toMatchObject({
        status: 'suspended',
        revisionId: c.revisionId,
        withdrawnRevisionId: null,
        version: c.version + 1,
      });
      // evaluateClaims reads S3, which covers only an approved record: no badge from the commit on.
      expect(await covering(c)).toEqual([]);
      const afterSuspend = (await historyRows(c.certificateId)).at(-1)!;
      expect(afterSuspend).toMatchObject({
        from_status: 'approved',
        to_status: 'suspended',
        revision_id: c.revisionId,
        actor_kind: 'admin',
        actor_account_id: accountOf(suspender),
        reason_code: reasonFor('suspended'),
      });
      expect(afterSuspend.note_ciphertext).toMatch(/^v1\./u);
      expect(afterSuspend.note_ciphertext).not.toContain('complaint');

      // A second suspension names the state; a stale version is conflict.stale.
      expect(
        await refusal(
          c.u.suspend.execute(suspender, {
            certificateId: c.certificateId,
            version: suspended.version,
            reasonCode: reasonFor('suspended'),
          }),
        ),
      ).toEqual({ code: 'certificate.suspended' });
      expect(
        await refusal(
          c.u.reinstate.execute(admin(), { certificateId: c.certificateId, version: 1 }),
        ),
      ).toEqual({ code: 'conflict.stale' });

      // Reinstate: never the creator nor an editor or submitter of the approved revision (AC 20).
      for (const actor of [c.creator, c.editor]) {
        expect(
          await refusal(
            c.u.reinstate.execute(actor, {
              certificateId: c.certificateId,
              version: suspended.version,
            }),
          ),
        ).toEqual({ code: 'approval.same-admin' });
      }
      const reinstater = admin();
      const reinstated = await unwrap(
        c.u.reinstate.execute(reinstater, {
          certificateId: c.certificateId,
          version: suspended.version,
        }),
      );
      expect(reinstated).toMatchObject({ status: 'approved', revisionId: c.revisionId });
      expect(await covering(c)).toEqual([c.certificateId]);

      expect((await outboxOf(c.certificateId)).map((e) => e.type)).toEqual([
        'certification.product-certification-approved.v1',
        'certification.product-certification-suspended.v1',
        'certification.product-certification-approved.v1',
      ]);
      expect((await outboxOf(c.certificateId))[1]!.payload).toEqual({
        productCertificationId: c.certificateId,
        revisionId: c.revisionId,
        typeId: c.type.typeId,
      });
      const audits = await auditsOf(c.certificateId);
      expect(audits.find((a) => a.action.endsWith('.suspended'))).toMatchObject({
        actor_type: 'USER',
        after: { revisionId: c.revisionId, noteGiven: true },
      });
      expect(audits.map((a) => a.action)).toContain(
        'certification.product-certification.reinstated',
      );
      expect(JSON.stringify(audits)).not.toContain('complaint');

      // The history read: newest first, clear fields only.
      const history = await unwrap(
        c.u.history.execute(admin(), { certificateId: c.certificateId }),
      );
      expect(history.entries.map((e) => [e.fromStatus, e.toStatus])).toEqual([
        ['suspended', 'approved'],
        ['approved', 'suspended'],
        ['in-review', 'approved'],
        ['draft', 'in-review'],
      ]);
      expect(history.entries[1]).toMatchObject({
        actor: { accountId: accountOf(suspender) },
        reasonCode: reasonFor('suspended'),
        noteGiven: true,
      });
      expect(JSON.stringify(history)).not.toContain('complaint');
      // The other Market sees nothing.
      expect(
        await refusal(
          c.u.history.execute(
            testCallContext(
              other,
              testAuthenticatedActor(other, {
                population: 'admin',
                accountId: uuid7() as Id<'Account'>,
                sessionId: uuid7() as Id<'Session'>,
                sellerId: null,
              }),
            ),
            { certificateId: c.certificateId },
          ),
        ),
      ).toEqual({ code: 'certificate.not-found' });
    });

    it('revokes a suspended record and withdraws its pending revision; revoked is terminal', async () => {
      const c = await approved();
      const suspended = await unwrap(
        c.u.suspend.execute(admin(), {
          certificateId: c.certificateId,
          version: c.version,
          reasonCode: reasonFor('suspended'),
        }),
      );
      // A renewal revision is pending on the suspended record (a suspended draft is editable).
      const draftEditor = admin();
      const saved = await unwrap(
        c.u.save.execute(draftEditor, {
          certificateId: c.certificateId,
          version: suspended.version,
          draft: {
            manufacturerName: 'Maker Foods Pty Ltd',
            issuerId: c.issuerId,
            issueDate: null,
            expiryDate: '2028-06-30',
            coverage: [{ productId: c.productId, variantIds: null }],
          },
        }),
      );
      const pending = await unwrap(
        c.u.submit.execute(draftEditor, { certificateId: c.certificateId, version: saved.version }),
      );
      // Revoke needs a reason of the revoked outcome.
      expect(
        await refusal(
          c.u.revoke.execute(admin(), {
            certificateId: c.certificateId,
            version: pending.version,
            reasonCode: undefined,
          }),
        ),
      ).toEqual({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'required' }] });
      const revoker = admin();
      const revoked = await unwrap(
        c.u.revoke.execute(revoker, {
          certificateId: c.certificateId,
          version: pending.version,
          reasonCode: reasonFor('revoked'),
        }),
      );
      expect(revoked).toMatchObject({
        status: 'revoked',
        revisionId: c.revisionId,
        withdrawnRevisionId: pending.revisionId,
      });
      const view = await unwrap(c.u.read.execute(admin(), { certificateId: c.certificateId }));
      expect(view).toMatchObject({ status: 'revoked', pending: null });
      const { rows: decisions } = await owner.query<{ outcome: string; decided_by: string | null }>(
        `SELECT outcome, decided_by_account_id AS decided_by FROM certification.product_revision_decisions
        WHERE market_id = $1 AND revision_id = $2`,
        [market.marketId, pending.revisionId],
      );
      expect(decisions).toEqual([{ outcome: 'withdrawn', decided_by: null }]);
      expect((await historyRows(c.certificateId)).at(-1)).toMatchObject({
        from_status: 'suspended',
        to_status: 'revoked',
        actor_account_id: accountOf(revoker),
        reason_code: reasonFor('revoked'),
        note_ciphertext: null,
      });
      expect((await auditsOf(c.certificateId)).at(-1)).toMatchObject({
        action: 'certification.product-certification.revoked',
        after: { withdrawnRevisionId: pending.revisionId, noteGiven: false },
      });
      expect((await outboxOf(c.certificateId)).at(-1)!.type).toBe(
        'certification.product-certification-revoked.v1',
      );

      for (const [action, expected] of [
        ['revoke', 'certificate.revoked'],
        ['suspend', 'certificate.closed'],
      ] as const) {
        expect(
          await refusal(
            c.u[action].execute(admin(), {
              certificateId: c.certificateId,
              version: revoked.version,
              reasonCode: reasonFor(action === 'revoke' ? 'revoked' : 'suspended'),
            }),
          ),
        ).toEqual({ code: expected });
      }
      expect(
        await refusal(
          c.u.reinstate.execute(admin(), {
            certificateId: c.certificateId,
            version: revoked.version,
          }),
        ),
      ).toEqual({ code: 'certificate.closed' });
      expect(await covering(c)).toEqual([]);
    });

    it('refuses to suspend or revoke a record never approved, and to reinstate past the boundary', async () => {
      const u = useCases();
      const type = await seedType();
      const created = await unwrap(u.create.execute(admin(), { typeId: type.typeId }));
      expect(
        await refusal(
          u.suspend.execute(admin(), {
            certificateId: created.certificateId,
            version: 1,
            reasonCode: reasonFor('suspended'),
          }),
        ),
      ).toEqual({ code: 'certificate.not-suspendable' });
      expect(
        await refusal(
          u.revoke.execute(admin(), {
            certificateId: created.certificateId,
            version: 1,
            reasonCode: reasonFor('revoked'),
          }),
        ),
      ).toEqual({ code: 'certificate.not-revocable' });

      const c = await approved('2026-12-31');
      const suspended = await unwrap(
        c.u.suspend.execute(admin(), {
          certificateId: c.certificateId,
          version: c.version,
          reasonCode: reasonFor('suspended'),
        }),
      );
      clock.set(expiryBoundary(Temporal.PlainDate.from('2026-12-31'), zone));
      expect(
        await refusal(
          c.u.reinstate.execute(admin(), {
            certificateId: c.certificateId,
            version: suspended.version,
          }),
        ),
      ).toEqual({ code: 'certificate.expired' });
      // Nothing was written by the refusals: the version is where the suspension left it.
      expect(
        (await unwrap(c.u.read.execute(admin(), { certificateId: c.certificateId }))).version,
      ).toBe(suspended.version);
    });

    it('the job warns once per threshold from 00:00 Market time and expires at the stored boundary', async () => {
      // Its own year (see the header): the window never reaches another spec's records.
      clock.set(Temporal.Instant.from('2020-01-01T00:00:00Z'));
      const expiry = Temporal.PlainDate.from('2020-06-30');
      const c = await approved(expiry.toString());
      const boundary = expiryBoundary(expiry, zone);
      const view = await unwrap(c.u.read.execute(admin(), { certificateId: c.certificateId }));
      expect(view.approvedBoundaryAt).toBe(boundary.toString());

      const thresholds = new MarketConfigExpiryPolicy(markets).policyFor(
        market,
      ).warningThresholdsDays;
      const largest = Math.max(...thresholds);
      const warnDay = expiry.add({ days: 1 }).subtract({ days: largest });
      const warnStart = warnDay.toZonedDateTime(zone).toInstant();
      clock.set(warnStart.subtract({ seconds: 1 }));
      await runJob();
      expect(await outboxOf(c.certificateId)).toHaveLength(1);

      clock.set(warnStart);
      expect(await runJob()).toMatchObject({ warned: 1, expired: 0 });
      await runJob(); // a re-run writes nothing (the marker)
      // The other Market's run never touches this record.
      expect(await runJob(other)).toMatchObject({ warned: 0, expired: 0 });
      const warnings = (await outboxOf(c.certificateId)).slice(1);
      expect(warnings).toEqual([
        {
          type: 'certification.product-certification-expiry-warning-due.v1',
          payload: {
            productCertificationId: c.certificateId,
            revisionId: c.revisionId,
            typeId: c.type.typeId,
            thresholdDays: largest,
          },
        },
      ]);
      const { rows: markers } = await owner.query<{ version_kind: string; threshold_days: number }>(
        `SELECT version_kind, threshold_days FROM certification.expiry_warnings
        WHERE market_id = $1 AND version_id = $2`,
        [market.marketId, c.revisionId],
      );
      expect(markers).toEqual([{ version_kind: 'product-revision', threshold_days: largest }]);

      clock.set(boundary.subtract({ seconds: 1 }));
      await runJob(); // the most urgent threshold now
      expect((await outboxOf(c.certificateId)).at(-1)!.payload).toMatchObject({
        thresholdDays: Math.min(...thresholds),
      });
      expect(await covering(c)).toEqual([c.certificateId]);

      clock.set(boundary);
      expect(await runJob()).toMatchObject({ expired: 1 });
      expect(await runJob()).toMatchObject({ expired: 0 });
      expect(await covering(c)).toEqual([]);
      const after = await unwrap(c.u.read.execute(admin(), { certificateId: c.certificateId }));
      expect(after.status).toBe('expired');
      expect((await outboxOf(c.certificateId)).at(-1)).toEqual({
        type: 'certification.product-certification-expired.v1',
        payload: {
          productCertificationId: c.certificateId,
          revisionId: c.revisionId,
          typeId: c.type.typeId,
        },
      });
      expect((await historyRows(c.certificateId)).at(-1)).toMatchObject({
        from_status: 'approved',
        to_status: 'expired',
        actor_kind: 'system',
        actor_account_id: null,
      });
      expect((await auditsOf(c.certificateId)).at(-1)).toMatchObject({
        action: 'certification.product-certification.expired',
        actor_type: 'SYSTEM',
      });
    });

    it('the job leaves a suspended record alone; it never becomes expired from suspended', async () => {
      clock.set(Temporal.Instant.from('2021-01-01T00:00:00Z'));
      const expiry = Temporal.PlainDate.from('2021-03-31');
      const c = await approved(expiry.toString());
      await unwrap(
        c.u.suspend.execute(admin(), {
          certificateId: c.certificateId,
          version: c.version,
          reasonCode: reasonFor('suspended'),
        }),
      );
      clock.set(expiryBoundary(expiry, zone).add({ hours: 1 }));
      await runJob();
      expect(
        (await unwrap(c.u.read.execute(admin(), { certificateId: c.certificateId }))).status,
      ).toBe('suspended');
      expect((await outboxOf(c.certificateId)).map((e) => e.type)).toEqual([
        'certification.product-certification-approved.v1',
        'certification.product-certification-suspended.v1',
      ]);
    });
  },
);
