import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { TimeZoneId } from '../../src/modules/certification/domain/claim-types';
import { ExpireSellerCertificates } from '../../src/modules/certification/application/use-cases/expire-seller-certificates.use-case';
import type { SubmitWrite } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import { expiryBoundary } from '../../src/modules/certification/domain/validity';
import { MarketConfigExpiryPolicy } from '../../src/modules/certification/infrastructure/market-config-expiry-policy';
import type { SellerZonesSource } from '../../src/modules/certification/application/ports/claim-facts.ports';
import { PrismaCertificateReviewRepository } from '../../src/modules/certification/infrastructure/prisma-certificate-review.repository';
import { PrismaSellerCertificateExpiryRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate-expiry.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
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
import { jobLockKey } from '../../src/platform/scheduler/job-lock';
import { EXPIRY_AND_WARNINGS_JOB } from '../../src/modules/certification/presentation/jobs/expiry-and-warnings.job';
import { zonesOf } from '../support/certification-fakes';
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

// Certification slice 9 on PostgreSQL (design 3.1, 8.6; data design 3.18, A9; AC 8, AC 9), for
// both Market fixtures: the job's use case over the real tables, outbox and audit log. Expiry
// writes the status, one history row, one audit row with the system actor and one event; a
// warning writes one marker and one event; a re-run and two concurrent runs write nothing twice;
// the other Market is untouched; the marker table is insert-only.
//
// The run database is shared with the other specs running in parallel, so every record here has
// an expiry date before 2026 and each test runs its clock in its own earlier year: the job's
// window (A9) never reaches another spec's records, and no later test reaches an earlier one's.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const ZONE = { AU: 'Australia/Brisbane', ZZ: 'Pacific/Auckland' } as const;
const ENVELOPE = `v1.${'A'.repeat(48)}`;
const HASH = `hmac-sha256:${'b'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

describe.each(TEST_MARKETS)('certification expiry job in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const zone = ZONE[code] as TimeZoneId;
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let sellerSide: PrismaSellerCertificateRepository;
  let reviews: PrismaCertificateReviewRepository;
  let audit: AuditWriter;
  const answers: Record<string, { zone: string | null; addressZone: string | null }> = {};

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    sellerSide = new PrismaSellerCertificateRepository(persistence.service);
    reviews = new PrismaCertificateReviewRepository(persistence.service);
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('certification', CERTIFICATION_AUDIT_ACTIONS);
    auditCatalogue.seal();
    audit = PersistenceModule.auditWriterFor('certification').useFactory(
      auditCatalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  function job(now: Temporal.Instant, zones: SellerZonesSource = zonesOf(answers)) {
    const events = new EventCatalogue();
    events.register('certification', CERTIFICATION_EVENTS);
    events.seal();
    return new ExpireSellerCertificates(gate, {
      unitOfWork: persistence.unitOfWork,
      expiries: new PrismaSellerCertificateExpiryRepository(persistence.service),
      zones,
      policies: new MarketConfigExpiryPolicy(markets),
      audit,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        persistence.service,
        events,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('certification'),
      clock: new FixedClock(now),
      ids,
    });
  }
  async function run(now: Temporal.Instant, m = market, zones?: SellerZonesSource) {
    const result = await job(now, zones).execute(testCallContext(m, 'system', `db-${uuid7()}`), {});
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });
  async function insert(client: Client, table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  async function type(m = market, requiresExpiry = true) {
    const typeId = uuid7();
    const revisionId = uuid7();
    const T = '2019-01-01T00:00:00Z';
    await insert(sql, 'certification_types', {
      id: typeId,
      ...base(m),
      code: `t${typeId.slice(-12)}`,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T,
    });
    await sql.query('BEGIN');
    await insert(sql, 'certification_type_revisions', {
      id: revisionId,
      ...base(m),
      type_id: typeId,
      revision_no: 1,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      requires_issuer_registry: true,
      requires_document: true,
      requires_expiry: requiresExpiry,
      default_basis: 'SELLER_REQUIRED',
      auto_approve_self_declaration: false,
      badge_icon_key: 'halal',
      author_account_id: uuid7(),
      created_at: T,
    });
    await insert(sql, 'type_revision_texts', {
      ...base(m),
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
    await insert(sql, 'issuers', {
      id: issuerId,
      ...base(m),
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
    return { typeId, revisionId, issuerId };
  }

  /** An approved certificate with the given expiry date, approved in the Market's zone. */
  async function approved(
    expiryDate: string,
    options: { m?: typeof market; requiresExpiry?: boolean } = {},
  ) {
    const m = options.m ?? market;
    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork
        .run(m, async () => ok(await work()))
        .then((r) => {
          if (!r.ok) throw new Error('refused');
          return r.value;
        });
    const { typeId, revisionId, issuerId } = await type(m, options.requiresExpiry ?? true);
    const seller = uuid7() as Id<'Seller'>;
    answers[seller] = { zone, addressZone: zone };
    const id = uuid7() as Id<'SellerCertification'>;
    const T = Temporal.Instant.from('2019-01-01T00:00:00Z');
    await unit(() =>
      sellerSide.add(m, {
        id,
        sellerId: seller,
        typeId: typeId as Id<'CertificationType'>,
        now: T,
      }),
    );
    const documentId = uuid7() as Id<'UploadedDocument'>;
    await unit(() =>
      sellerSide.addDocument(m, {
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
      issueDate: Temporal.PlainDate.from('2018-01-01'),
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
    await unit(() => sellerSide.submit(m, write));
    const boundary = options.requiresExpiry === false ? null : expiryBoundary(expiry, zone);
    await unit(async () => {
      await reviews.lockForDecision(m, id, 3, T);
      await reviews.decide(m, {
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
    return {
      id,
      seller,
      typeId,
      revisionId,
      issuerId,
      submissionId: write.submissionId,
      boundary: boundary!,
      expiry,
      write,
    };
  }

  const root = async (id: string) =>
    (
      await sql.query<{ status: string; version: number }>(
        `SELECT status, version FROM certification.seller_certifications WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const outbox = async (id: string) =>
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
      (row) => !row.type.endsWith('-approved.v1') && !row.type.endsWith('-submitted.v1'),
    );
  const markers = async (submissionId: string) =>
    (
      await sql.query<{ threshold_days: number }>(
        `SELECT threshold_days FROM certification.expiry_warnings
         WHERE market_id = $1 AND version_kind = 'submission' AND version_id = $2
         ORDER BY threshold_days DESC`,
        [market.marketId, submissionId],
      )
    ).rows.map((r) => r.threshold_days);

  it('uses the lock key of data design 11', () => {
    expect(jobLockKey(EXPIRY_AND_WARNINGS_JOB)).toBe(3131801444743177164n);
  });

  it('expires at the local boundary with one event, one system audit row and one history row; a re-run adds nothing; the other Market is untouched', async () => {
    const mine = await approved('2025-03-31');
    const theirs = await approved('2025-03-31', { m: other });
    await run(mine.boundary.subtract({ seconds: 1 }));
    expect((await root(mine.id)).status).toBe('approved');

    await run(mine.boundary);
    await run(mine.boundary.add({ minutes: 15 }));
    expect(await root(mine.id)).toEqual({ status: 'expired', version: 6 });
    expect((await root(theirs.id)).status).toBe('approved');

    const events = await outbox(mine.id);
    // The 1-day warning fell due on the last local day (the 30 and 14 ones before it, only the
    // most urgent was sent at the first run), then the expiry.
    expect(events.map((e) => [e.type, e.aggregate_version])).toEqual([
      ['certification.seller-certification-expiry-warning-due.v1', 5],
      ['certification.seller-certification-expired.v1', 6],
    ]);
    expect(events[1]!.payload).toEqual({
      sellerCertificationId: mine.id,
      sellerId: mine.seller,
      submissionId: mine.submissionId,
      typeId: mine.typeId,
    });
    const audits = await sql.query<{ action: string; actor_type: string; after: unknown }>(
      `SELECT action, actor_type, after FROM platform.audit_log
       WHERE market_id = $1 AND target_id = $2 AND action = 'certification.seller-certification.expired'`,
      [market.marketId, mine.id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.actor_type).toBe('SYSTEM');
    const history = await sql.query<{ from_status: string; to_status: string; actor_kind: string }>(
      `SELECT from_status, to_status, actor_kind FROM certification.seller_certification_history
       WHERE seller_certification_id = $1 ORDER BY occurred_at, id`,
      [mine.id],
    );
    expect(history.rows.at(-1)).toEqual({
      from_status: 'approved',
      to_status: 'expired',
      actor_kind: 'system',
    });
  });

  it('warns 30, 14 and 1 days ahead on the seller local day, each once; nothing for a type without expiry', async () => {
    const c = await approved('2024-03-31');
    const none = await approved('2024-03-31', { requiresExpiry: false });
    const start = (day: string) => Temporal.PlainDate.from(day).toZonedDateTime(zone).toInstant();
    await run(start('2024-03-02').subtract({ seconds: 1 }));
    expect(await markers(c.submissionId)).toEqual([]);
    for (const [day, expected] of [
      ['2024-03-02', [30]],
      ['2024-03-18', [30, 14]],
      ['2024-03-31', [30, 14, 1]],
    ] as const) {
      await run(start(day));
      await run(start(day).add({ minutes: 15 }));
      expect(await markers(c.submissionId)).toEqual(expected);
    }
    expect((await outbox(c.id)).map((e) => e.payload.thresholdDays)).toEqual([30, 14, 1]);
    expect(await root(c.id)).toEqual({ status: 'approved', version: 7 });
    expect(await markers(none.submissionId)).toEqual([]);
    expect(await outbox(none.id)).toEqual([]);
  });

  it('two concurrent runs expire and warn each record exactly once', async () => {
    const due = await Promise.all([1, 2, 3, 4].map(() => approved('2023-03-31')));
    const warn = await Promise.all([1, 2, 3, 4].map(() => approved('2023-04-10')));
    const now = due[0]!.boundary.add({ minutes: 1 });
    const results = await Promise.all([run(now), run(now), run(now)]);
    for (const c of due) {
      expect((await root(c.id)).status).toBe('expired');
      expect((await outbox(c.id)).map((e) => e.type)).toEqual([
        'certification.seller-certification-expired.v1',
      ]);
    }
    for (const c of warn) {
      expect(await markers(c.submissionId)).toEqual([14]);
      expect(await outbox(c.id)).toHaveLength(1);
    }
    const total = results.reduce((sum, r) => sum + r.expired + r.warned, 0);
    expect(total).toBe(8);
  });

  it('writes nothing when a renewal is approved through the review path between the read and the write (Hassan L2)', async () => {
    const c = await approved('2022-06-30');
    const now = c.boundary.add({ minutes: 1 });
    const renewalId = uuid7() as Id<'Submission'>;
    const later = Temporal.PlainDate.from('2023-06-30');
    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork
        .run(market, async () => ok(await work()))
        .then((r) => {
          if (!r.ok) throw new Error('refused');
          return r.value;
        });
    // The renewal is submitted and approved by a reviewer after the job read its page and before
    // it locks the record: the zone read runs between the two, outside any unit.
    const racing: SellerZonesSource = {
      zonesOf: async (context, sellerIds) => {
        await unit(() =>
          sellerSide.submit(market, {
            ...c.write,
            expectedVersion: 4,
            submissionId: renewalId,
            submissionNo: 2,
            kind: 'renewal',
            expiryDate: later,
            documentIds: [],
            numberIndexHmac: null,
            fromStatus: 'approved',
            toStatus: 'approved',
            submittedAt: now,
            historyId: uuid7() as Id<'CertificationHistory'>,
          }),
        );
        await unit(async () => {
          await reviews.lockForDecision(market, c.id, 5, now);
          await reviews.decide(market, {
            certificateId: c.id,
            submissionId: renewalId,
            outcome: 'approved',
            accountId: uuid7() as Id<'Account'>,
            decidedAt: now,
            approvedZone: zone,
            expiryBoundaryAt: expiryBoundary(later, zone),
            reasonCode: null,
            reasonTextCiphertext: null,
            fromStatus: 'approved',
            toStatus: 'approved',
            historyId: uuid7() as Id<'CertificationHistory'>,
          });
        });
        return zonesOf(answers).zonesOf(context, sellerIds);
      },
    };
    const out = await run(now, market, racing);
    expect(out.expired).toBe(0);
    expect(out.contended + out.changed).toBeGreaterThanOrEqual(1);
    expect(await root(c.id)).toEqual({ status: 'approved', version: 6 });
    expect(await outbox(c.id)).toEqual([]);
    const audits = await sql.query(
      `SELECT 1 FROM platform.audit_log WHERE market_id = $1 AND target_id = $2
       AND action = 'certification.seller-certification.expired'`,
      [market.marketId, c.id],
    );
    expect(audits.rows).toHaveLength(0);
    // The renewed record is not expired by a later run either: its new boundary is a year on.
    await run(now.add({ minutes: 15 }));
    expect((await root(c.id)).status).toBe('approved');
  });

  it('keeps the marker table insert-only and its values checked', async () => {
    const row = {
      ...base(),
      version_kind: 'submission',
      version_id: uuid7(),
      threshold_days: 14,
      created_at: '2022-01-01T00:00:00Z',
    };
    await insert(sql, 'expiry_warnings', row);
    expect(
      await sqlState(
        sql,
        `INSERT INTO certification.expiry_warnings
        (market_id, tenant_id, version_kind, version_id, threshold_days, created_at)
        VALUES ($1, $2, 'submission', $3, 14, now())`,
        [market.marketId, market.tenantId, row.version_id],
      ),
    ).toBe('23505');
    // The application role holds no UPDATE or DELETE; the owner is stopped by the trigger.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.expiry_warnings SET threshold_days = 1 WHERE version_id = $1`,
        [row.version_id],
      ),
    ).toBe('42501');
    expect(
      await sqlState(sql, `DELETE FROM certification.expiry_warnings WHERE version_id = $1`, [
        row.version_id,
      ]),
    ).toBe('42501');
    expect(
      await sqlState(owner, `DELETE FROM certification.expiry_warnings WHERE version_id = $1`, [
        row.version_id,
      ]),
    ).toBe('23001');
    expect(
      await sqlState(
        owner,
        `UPDATE certification.expiry_warnings SET threshold_days = 1 WHERE version_id = $1`,
        [row.version_id],
      ),
    ).toBe('23001');
    for (const bad of [{ version_kind: 'offer' }, { threshold_days: 0 }, { threshold_days: 400 }]) {
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.expiry_warnings
          (market_id, tenant_id, version_kind, version_id, threshold_days, created_at)
          VALUES ($1, $2, $3, $4, $5, now())`,
          [
            market.marketId,
            market.tenantId,
            bad.version_kind ?? 'submission',
            uuid7(),
            bad.threshold_days ?? 14,
          ],
        ),
      ).toBe('23514');
    }
  });

  it('uses the partial index A9 for the selection', async () => {
    await owner.query('SET enable_seqscan = off');
    const plan = await owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM certification.seller_certifications
       WHERE market_id = $1 AND status = 'approved' AND approved_boundary_at < $2
       ORDER BY approved_boundary_at, id LIMIT 100`,
      [market.marketId, '2022-01-01T00:00:00Z'],
    );
    // With a cursor, the redundant lower bound is in the index condition (Mojtaba R1).
    const paged = await owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM certification.seller_certifications
       WHERE market_id = $1 AND status = 'approved'
         AND approved_boundary_at < $2 AND approved_boundary_at >= $3
         AND (approved_boundary_at > $3 OR (approved_boundary_at = $3 AND id > $4))
       ORDER BY approved_boundary_at, id LIMIT 100`,
      [market.marketId, '2022-01-01T00:00:00Z', '2021-01-01T00:00:00Z', uuid7()],
    );
    await owner.query('RESET enable_seqscan');
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'seller_certifications_market_id_approved_boundary_at_idx',
    );
    const pagedPlan = paged.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(pagedPlan).toContain('seller_certifications_market_id_approved_boundary_at_idx');
    expect(pagedPlan).toMatch(/Index Cond: .*approved_boundary_at >= /);
  });
});
