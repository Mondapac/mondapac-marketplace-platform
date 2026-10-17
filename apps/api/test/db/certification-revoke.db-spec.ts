import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { CertificationTypeCode } from '../../src/modules/certification';
import type { SellerZonesSource } from '../../src/modules/certification/application/ports/claim-facts.ports';
import type { SubmitWrite } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import type { ReviewDependencies } from '../../src/modules/certification/application/review/review.shared';
import { ExpireSellerCertificates } from '../../src/modules/certification/application/use-cases/expire-seller-certificates.use-case';
import { DeclineSellerCertificate } from '../../src/modules/certification/application/use-cases/seller-certificate-decline.use-case';
import { SellerCertificateHistoryRead } from '../../src/modules/certification/application/use-cases/seller-certificate-history-read.use-case';
import { RevokeSellerCertificate } from '../../src/modules/certification/application/use-cases/seller-certificate-revoke.use-case';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import type { TimeZoneId } from '../../src/modules/certification/domain/claim-types';
import {
  expiryBoundary,
  sellerCertificateValidAt,
} from '../../src/modules/certification/domain/validity';
import { MarketConfigExpiryPolicy } from '../../src/modules/certification/infrastructure/market-config-expiry-policy';
import { PrismaCertificateReviewRepository } from '../../src/modules/certification/infrastructure/prisma-certificate-review.repository';
import { PrismaClaimFactsReader } from '../../src/modules/certification/infrastructure/prisma-claim-facts.reader';
import { PrismaSellerCertificateExpiryRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate-expiry.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { CheckedInReviewPolicy } from '../../src/modules/certification/infrastructure/review-policy/checked-in-review-policy';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { FakeCipher, MemoryVault, zonesOf } from '../support/certification-fakes';
import { FixedReviewSellers } from '../support/certification-review-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Certification slice 11 on PostgreSQL (design 3.1, 3.2 row 2, 11; data design 3.4, 3.6, 3.13;
// AC 16, AC 22), for both Market fixtures, with the real repositories, unit of work, outbox and
// audit writer: a revoke writes the status, one history row, one audit row and one event in one
// unit and withdraws a pending renewal; `evaluateClaims`' facts read answers "not valid" at once;
// the full history read pages; a revoke racing a renewal decision and racing the expiry job
// leaves exactly one winner, the loser answering `conflict.stale` (or the job `contended`) and
// writing nothing. No migration: slice 11 uses the tables of migrations 1, 5 and 7.
//
// The expiry races give their records an expiry date in 2027, beyond every run of the expiry spec
// (its records and clocks are 2022 to 2025), so its runs never touch them; and this spec's job sees
// only its own record as a candidate (`OnlyThese`), so it never touches another spec's records.
// The job's lock, re-read and writes are the real SQL.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new CheckedInReviewPolicy();
const ZONE = { AU: 'Australia/Brisbane', ZZ: 'Pacific/Auckland' } as const;
const ENVELOPE = `v1.${'A'.repeat(48)}`;
const HASH = `hmac-sha256:${'b'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real expiry repository whose selection keeps only the named records (see the header). */
class OnlyThese extends PrismaSellerCertificateExpiryRepository {
  constructor(
    persistenceService: ConstructorParameters<typeof PrismaSellerCertificateExpiryRepository>[0],
    private readonly ids: ReadonlySet<string>,
  ) {
    super(persistenceService);
  }
  override async candidates(
    ...args: Parameters<PrismaSellerCertificateExpiryRepository['candidates']>
  ): ReturnType<PrismaSellerCertificateExpiryRepository['candidates']> {
    const page = await super.candidates(...args);
    return {
      ...page,
      candidates: page.candidates.filter((c) => this.ids.has(c.certificateId)),
    };
  }
}

/** An audit writer that can hold the unit that calls it open until released. */
class HoldingAudit implements AuditWriter {
  #hold: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #entered: (() => void) | null = null;
  constructor(private readonly inner: AuditWriter) {}
  /** The next `record` waits; resolves `entered` once the unit is inside it. */
  holdNext(): { entered: Promise<void>; release: () => void } {
    this.#hold = new Promise<void>((resolve) => (this.#release = resolve));
    const entered = new Promise<void>((resolve) => (this.#entered = resolve));
    return { entered, release: () => this.#release?.() };
  }
  async record(context: CallContext, entry: AuditEntry): Promise<void> {
    await this.inner.record(context, entry);
    const hold = this.#hold;
    if (hold !== null) {
      this.#hold = null;
      this.#entered?.();
      await hold;
    }
  }
}

describe.each(TEST_MARKETS)('certification revoke in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const zone = ZONE[code] as TimeZoneId;
  const revokeCode = policies
    .policyFor(market)
    .reasons.find((r) => r.outcomes.includes('revoked'))!.code;
  const declineCode = policies
    .policyFor(market)
    .reasons.find((r) => r.outcomes.includes('declined'))!.code;
  let persistence: Persistence;
  let sql: Client;
  let sellerSide: PrismaSellerCertificateRepository;
  let reviews: PrismaCertificateReviewRepository;
  let baseAudit: AuditWriter;
  let outboxWriter: OutboxWriter;
  const answers: Record<string, { zone: string | null; addressZone: string | null }> = {};

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    sellerSide = new PrismaSellerCertificateRepository(persistence.service);
    reviews = new PrismaCertificateReviewRepository(persistence.service);
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('certification', CERTIFICATION_AUDIT_ACTIONS);
    auditCatalogue.seal();
    baseAudit = PersistenceModule.auditWriterFor('certification').useFactory(
      auditCatalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    const events = new EventCatalogue();
    events.register('certification', CERTIFICATION_EVENTS);
    events.seal();
    outboxWriter = new PrismaOutboxWriterFactory(
      modelMap,
      persistence.service,
      events,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('certification');
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  function reviewDeps(audit: AuditWriter, now: Temporal.Instant): ReviewDependencies {
    return {
      unitOfWork: persistence.unitOfWork,
      reviews,
      cipher: new FakeCipher(),
      vault: new MemoryVault(),
      audit,
      zones: zonesOf(answers),
      sellers: new FixedReviewSellers(),
      policies,
      outbox: outboxWriter,
      clock: new FixedClock(now),
      ids,
      documentDownloadEnabled: false,
    };
  }
  function job(
    audit: AuditWriter,
    now: Temporal.Instant,
    only: string,
    zones: SellerZonesSource = zonesOf(answers),
  ) {
    return new ExpireSellerCertificates(gate, {
      unitOfWork: persistence.unitOfWork,
      expiries: new OnlyThese(persistence.service, new Set([only])),
      zones,
      policies: new MarketConfigExpiryPolicy(markets),
      audit,
      outbox: outboxWriter,
      clock: new FixedClock(now),
      ids,
    });
  }
  const admin = (m = market): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'admin',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );

  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });
  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  const unit = <T>(work: () => Promise<T>, m = market) =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()))
      .then((r) => {
        if (!r.ok) throw new Error('refused');
        return r.value;
      });

  async function type() {
    const typeId = uuid7();
    const revisionId = uuid7();
    const T = '2014-01-01T00:00:00Z';
    const typeCode = `t${typeId.slice(-12)}`;
    await insert('certification_types', {
      id: typeId,
      ...base(),
      code: typeCode,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T,
    });
    await sql.query('BEGIN');
    await insert('certification_type_revisions', {
      id: revisionId,
      ...base(),
      type_id: typeId,
      revision_no: 1,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      requires_issuer_registry: true,
      requires_document: true,
      requires_expiry: true,
      default_basis: 'SELLER_REQUIRED',
      auto_approve_self_declaration: false,
      badge_icon_key: 'halal',
      author_account_id: uuid7(),
      created_at: T,
    });
    await insert('type_revision_texts', {
      ...base(),
      type_revision_id: revisionId,
      locale: 'en',
      name: 'Halal',
      customer_description: 'Halal certified',
    });
    await sql.query('COMMIT');
    await sql.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, typeId],
    );
    const issuerId = uuid7();
    await insert('issuers', {
      id: issuerId,
      ...base(),
      type_id: typeId,
      display_name: 'Halal Authority',
      display_name_key: `issuer ${issuerId}`,
      accreditation_number: null,
      state: 'active',
      expert_reference_ciphertext: ENVELOPE,
      state_changed_at: T,
      state_changed_by_kind: 'seed',
      state_changed_by_account_id: null,
      version: 1,
      created_at: T,
    });
    return { typeId, revisionId, issuerId, typeCode };
  }

  /**
   * An approved certificate with the given expiry date (version 4 after the approval), and with
   * `renewal` a pending renewal beside it (version 5).
   */
  async function approved(expiryDate: string, options: { renewal?: boolean } = {}) {
    const { typeId, revisionId, issuerId, typeCode } = await type();
    const seller = uuid7() as Id<'Seller'>;
    answers[seller] = { zone, addressZone: zone };
    const id = uuid7() as Id<'SellerCertification'>;
    const T = Temporal.Instant.from('2014-01-01T00:00:00Z');
    await unit(() =>
      sellerSide.add(market, {
        id,
        sellerId: seller,
        typeId: typeId as Id<'CertificationType'>,
        now: T,
      }),
    );
    const documentId = uuid7() as Id<'UploadedDocument'>;
    await unit(() =>
      sellerSide.addDocument(market, {
        id: documentId,
        certificateId: id,
        expectedVersion: 1,
        sellerId: seller,
        typeId: typeId as Id<'CertificationType'>,
        position: 1,
        mediaType: 'application/pdf',
        byteSize: 1000,
        pageCount: 1,
        objectKey: `certification/${seller}/${documentId}`,
        dataKeyEnvelope: ENVELOPE,
        cleanSha256: sha(documentId),
        indexHmac: crypto.getRandomValues(new Uint8Array(32)),
        now: T,
      }),
    );
    const expiry = Temporal.PlainDate.from(expiryDate);
    const write: SubmitWrite = {
      certificateId: id,
      expectedVersion: 2,
      sellerId: seller,
      typeId: typeId as Id<'CertificationType'>,
      typeRevisionId: revisionId as Id<'CertificationTypeRevision'>,
      submissionId: uuid7() as Id<'Submission'>,
      submissionNo: 1,
      kind: 'initial',
      issuerId: issuerId as Id<'Issuer'>,
      certificateNumberCiphertext: ENVELOPE,
      issueDate: Temporal.PlainDate.from('2013-01-01'),
      expiryDate: expiry,
      selfDeclared: null,
      selfDeclarationNoteCiphertext: null,
      contentSchemaVersion: 1,
      contentHash: HASH,
      submittedZone: zone,
      submittedAt: T,
      submittedByAccountId: uuid7() as Id<'Account'>,
      documentIds: [documentId],
      fromStatus: 'draft',
      toStatus: 'in-review',
      numberIndexHmac: crypto.getRandomValues(new Uint8Array(32)),
      historyId: uuid7() as Id<'CertificationHistory'>,
    };
    await unit(() => sellerSide.submit(market, write));
    const boundary = expiryBoundary(expiry, zone);
    await unit(async () => {
      await reviews.lockForDecision(market, id, 3, T);
      await reviews.decide(market, {
        certificateId: id,
        submissionId: write.submissionId,
        outcome: 'approved',
        accountId: uuid7() as Id<'Account'>,
        decidedAt: T,
        approvedZone: zone,
        expiryBoundaryAt: boundary,
        reasonCode: null,
        reasonTextCiphertext: null,
        fromStatus: 'in-review',
        toStatus: 'approved',
        historyId: uuid7() as Id<'CertificationHistory'>,
      });
    });
    let renewalId: Id<'Submission'> | null = null;
    if (options.renewal === true) {
      renewalId = uuid7() as Id<'Submission'>;
      await unit(() =>
        sellerSide.submit(market, {
          ...write,
          expectedVersion: 4,
          submissionId: renewalId!,
          submissionNo: 2,
          kind: 'renewal',
          expiryDate: expiry.add({ years: 2 }),
          numberIndexHmac: crypto.getRandomValues(new Uint8Array(32)),
          fromStatus: 'approved',
          toStatus: 'approved',
          historyId: uuid7() as Id<'CertificationHistory'>,
        }),
      );
    }
    return {
      id,
      seller,
      typeId,
      typeCode,
      revisionId,
      submissionId: write.submissionId,
      renewalId,
      boundary,
      version: options.renewal === true ? 5 : 4,
    };
  }

  const root = async (id: string) =>
    (
      await sql.query<{
        status: string;
        version: number;
        pending_submission_id: string | null;
        approved_submission_id: string | null;
      }>(
        `SELECT status, version, pending_submission_id, approved_submission_id
         FROM certification.seller_certifications WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const auditRows = async (id: string, action: string) =>
    (
      await sql.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM platform.audit_log WHERE market_id = $1 AND target_id = $2 AND action = $3`,
        [market.marketId, id, action],
      )
    ).rows;
  const outboxTypes = async (id: string) =>
    (
      await sql.query<{
        type: string;
        aggregate_version: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT type, aggregate_version, payload FROM certification.outbox
         WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [market.marketId, id],
      )
    ).rows.filter(
      (row) => !row.type.endsWith('-submitted.v1') && !row.type.endsWith('-approved.v1'),
    );
  const decisionOf = async (submissionId: string) =>
    (
      await sql.query<{ outcome: string; withdraw_cause: string | null; actor_kind: string }>(
        `SELECT outcome, withdraw_cause, actor_kind FROM certification.seller_submission_decisions
         WHERE submission_id = $1`,
        [submissionId],
      )
    ).rows;

  it('revokes in one unit: status, history with the sealed note, one audit row, one event; the claim is "no" at once', async () => {
    const f = await approved('2030-06-30');
    const reader = new PrismaClaimFactsReader(
      persistence.unitOfWork,
      new PrismaRawReadPort(persistence.root).forModule('certification'),
    );
    const facts = async () =>
      (
        await reader.sellerCertificates(market, [
          { sellerId: f.seller, typeCode: f.typeCode as CertificationTypeCode },
        ])
      )[0]!.certificate;
    const now = Temporal.Instant.from('2026-10-17T00:00:00Z');
    const zones = { zone, addressZone: zone } as never;
    expect(sellerCertificateValidAt((await facts())!, zones, now)).toMatchObject({ valid: true });

    const revoke = new RevokeSellerCertificate(gate, reviewDeps(baseAudit, now));
    const result = await revoke.execute(admin(), {
      certificateId: f.id,
      version: 4,
      reasonCode: revokeCode,
      reasonText: 'The issuer withdrew it on the phone.',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'revoked',
        version: 5,
        submissionId: f.submissionId,
        withdrawnSubmissionId: null,
      },
    });
    expect(await root(f.id)).toMatchObject({
      status: 'revoked',
      version: 5,
      pending_submission_id: null,
      approved_submission_id: f.submissionId,
    });
    const answer = await facts();
    expect(answer === null || !sellerCertificateValidAt(answer, zones, now).valid).toBe(true);

    const audit = await auditRows(f.id, 'certification.seller-certification.revoked');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({
      submissionId: f.submissionId,
      typeRevisionId: f.revisionId,
      noteGiven: true,
    });
    expect(await outboxTypes(f.id)).toEqual([
      {
        type: 'certification.seller-certification-revoked.v1',
        aggregate_version: 5,
        payload: {
          sellerCertificationId: f.id,
          sellerId: f.seller,
          submissionId: f.submissionId,
          typeId: f.typeId,
        },
      },
    ]);
    const leaked = JSON.stringify([audit, await outboxTypes(f.id)]);
    expect(leaked).not.toContain('withdrew it');
    expect(leaked).not.toContain(revokeCode);

    // The full history: newest first, paged, the note decrypted, the read audited.
    const history = new SellerCertificateHistoryRead(gate, reviewDeps(baseAudit, now));
    const page1 = await history.execute(admin(), { certificateId: f.id, limit: 2 });
    expect(page1).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            fromStatus: 'approved',
            toStatus: 'revoked',
            reasonCode: revokeCode,
            note: 'The issuer withdrew it on the phone.',
          },
          { fromStatus: 'in-review', toStatus: 'approved' },
        ],
      },
    });
    const nextBeforeId = page1.ok ? page1.value.nextBeforeId : null;
    expect(nextBeforeId).not.toBeNull();
    const page2 = await history.execute(admin(), { certificateId: f.id, beforeId: nextBeforeId });
    expect(page2).toMatchObject({
      ok: true,
      value: { entries: [{ fromStatus: 'draft', toStatus: 'in-review' }], nextBeforeId: null },
    });
    expect(await auditRows(f.id, 'certification.history.viewed')).toHaveLength(2);

    // Terminal; and the other Market never sees the record.
    expect(
      await revoke.execute(admin(), { certificateId: f.id, version: 5, reasonCode: revokeCode }),
    ).toEqual({ ok: false, error: { code: 'certificate.revoked' } });
    expect(await history.execute(admin(other), { certificateId: f.id })).toEqual({
      ok: false,
      error: { code: 'certificate.not-found' },
    });

    // The (seller, type) place is free again (T1): a new certificate of the type can be added.
    await expect(
      unit(() =>
        sellerSide.add(market, {
          id: uuid7() as Id<'SellerCertification'>,
          sellerId: f.seller,
          typeId: f.typeId as Id<'CertificationType'>,
          now,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('withdraws a pending renewal in the same unit (decision withdrawn, cause revoked, by the admin)', async () => {
    const f = await approved('2030-06-30', { renewal: true });
    const now = Temporal.Instant.from('2026-10-17T00:00:00Z');
    const result = await new RevokeSellerCertificate(gate, reviewDeps(baseAudit, now)).execute(
      admin(),
      { certificateId: f.id, version: 5, reasonCode: revokeCode },
    );
    expect(result).toMatchObject({ ok: true, value: { withdrawnSubmissionId: f.renewalId } });
    expect(await decisionOf(f.renewalId!)).toEqual([
      { outcome: 'withdrawn', withdraw_cause: 'revoked', actor_kind: 'admin' },
    ]);
    // The approved submission's decision row is untouched (data design 3.6).
    expect(await decisionOf(f.submissionId)).toEqual([
      { outcome: 'approved', withdraw_cause: null, actor_kind: 'admin' },
    ]);
    expect(await root(f.id)).toMatchObject({ status: 'revoked', pending_submission_id: null });
  });

  describe('races (lock first, version guard)', () => {
    const now = Temporal.Instant.from('2026-10-17T00:00:00Z');

    it('a revoke holding the lock makes a renewal decision wait and then answer conflict.stale', async () => {
      const f = await approved('2030-06-30', { renewal: true });
      const audit = new HoldingAudit(baseAudit);
      const held = audit.holdNext();
      const revoking = new RevokeSellerCertificate(gate, reviewDeps(audit, now)).execute(admin(), {
        certificateId: f.id,
        version: 5,
        reasonCode: revokeCode,
      });
      await held.entered;
      let declined: unknown = null;
      const declining = new DeclineSellerCertificate(gate, reviewDeps(baseAudit, now))
        .execute(admin(), {
          certificateId: f.id,
          submissionId: f.renewalId,
          version: 5,
          reasonCode: declineCode,
        })
        .then((r) => (declined = r));
      await delay(300);
      expect(declined).toBeNull(); // waiting on the row lock
      held.release();
      expect(await revoking).toMatchObject({ ok: true, value: { status: 'revoked' } });
      await declining;
      expect(declined).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(await decisionOf(f.renewalId!)).toEqual([
        { outcome: 'withdrawn', withdraw_cause: 'revoked', actor_kind: 'admin' },
      ]);
      expect(await auditRows(f.id, 'certification.seller-certification.declined')).toHaveLength(0);
      expect((await outboxTypes(f.id)).map((r) => r.type)).toEqual([
        'certification.seller-certification-revoked.v1',
      ]);
    });

    it('a renewal decision holding the lock makes a revoke answer conflict.stale; the retry on the new version revokes', async () => {
      const f = await approved('2030-06-30', { renewal: true });
      const audit = new HoldingAudit(baseAudit);
      const held = audit.holdNext();
      const declining = new DeclineSellerCertificate(gate, reviewDeps(audit, now)).execute(
        admin(),
        { certificateId: f.id, submissionId: f.renewalId, version: 5, reasonCode: declineCode },
      );
      await held.entered;
      const revoke = new RevokeSellerCertificate(gate, reviewDeps(baseAudit, now));
      let revoked: unknown = null;
      const revoking = revoke
        .execute(admin(), { certificateId: f.id, version: 5, reasonCode: revokeCode })
        .then((r) => (revoked = r));
      await delay(300);
      expect(revoked).toBeNull();
      held.release();
      expect(await declining).toMatchObject({ ok: true, value: { outcome: 'declined' } });
      await revoking;
      expect(revoked).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(await root(f.id)).toMatchObject({ status: 'approved', version: 6 });

      expect(
        await revoke.execute(admin(), { certificateId: f.id, version: 6, reasonCode: revokeCode }),
      ).toMatchObject({ ok: true, value: { status: 'revoked', withdrawnSubmissionId: null } });
    });

    it('a revoke holding the lock makes the expiry job count the record contended and write nothing', async () => {
      const f = await approved('2027-02-28');
      const after = f.boundary.add({ minutes: 15 });
      const audit = new HoldingAudit(baseAudit);
      const held = audit.holdNext();
      const revoking = new RevokeSellerCertificate(gate, reviewDeps(audit, after)).execute(
        admin(),
        { certificateId: f.id, version: 4, reasonCode: revokeCode },
      );
      await held.entered;
      const running = job(baseAudit, after, f.id).execute(
        testCallContext(market, 'system', `db-${uuid7()}`),
        {},
      );
      await delay(300);
      held.release();
      expect(await revoking).toMatchObject({ ok: true, value: { status: 'revoked' } });
      const ran = await running;
      expect(ran).toMatchObject({ ok: true, value: { contended: 1, expired: 0 } });
      expect(await root(f.id)).toMatchObject({ status: 'revoked', version: 5 });
      expect(await auditRows(f.id, 'certification.seller-certification.expired')).toHaveLength(0);
      expect((await outboxTypes(f.id)).map((r) => r.type)).toEqual([
        'certification.seller-certification-revoked.v1',
      ]);
      // A later run finds nothing: the job selects only approved records.
      expect(
        await job(baseAudit, after.add({ minutes: 15 }), f.id).execute(
          testCallContext(market, 'system', `db-${uuid7()}`),
          {},
        ),
      ).toMatchObject({ ok: true, value: { expired: 0, contended: 0 } });
    });

    it('the expiry job holding the lock makes a revoke answer conflict.stale; the retry revokes the expired record', async () => {
      const f = await approved('2027-02-28');
      const after = f.boundary.add({ minutes: 15 });
      const audit = new HoldingAudit(baseAudit);
      const held = audit.holdNext();
      const running = job(audit, after, f.id).execute(
        testCallContext(market, 'system', `db-${uuid7()}`),
        {},
      );
      await held.entered;
      const revoke = new RevokeSellerCertificate(gate, reviewDeps(baseAudit, after));
      let revoked: unknown = null;
      const revoking = revoke
        .execute(admin(), { certificateId: f.id, version: 4, reasonCode: revokeCode })
        .then((r) => (revoked = r));
      await delay(300);
      expect(revoked).toBeNull();
      held.release();
      expect(await running).toMatchObject({ ok: true, value: { expired: 1 } });
      await revoking;
      expect(revoked).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(await root(f.id)).toMatchObject({ status: 'expired', version: 5 });

      expect(
        await revoke.execute(admin(), { certificateId: f.id, version: 5, reasonCode: revokeCode }),
      ).toMatchObject({ ok: true, value: { status: 'revoked', version: 6 } });
      expect((await outboxTypes(f.id)).map((r) => r.type)).toEqual([
        'certification.seller-certification-expired.v1',
        'certification.seller-certification-revoked.v1',
      ]);
    });
  });
});
