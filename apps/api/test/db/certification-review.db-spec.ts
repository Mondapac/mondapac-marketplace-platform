import { createHash } from 'node:crypto';
import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import { withdrawForEdit } from '../../src/modules/certification/application/own/own-certificate.shared';
import { CERTIFICATION_EVENTS } from '../../src/modules/certification/domain/events';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { ids } from './outbox-support';
import { Client } from 'pg';
import type { SubmitWrite } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import type { CertificationTypeCode } from '../../src/modules/certification';
import { sellerCertificateValidAt } from '../../src/modules/certification/domain/validity';
import { PrismaClaimFactsReader } from '../../src/modules/certification/infrastructure/prisma-claim-facts.reader';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { PrismaCertificateReviewRepository } from '../../src/modules/certification/infrastructure/prisma-certificate-review.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Certification migration 4 (admin review of seller certificates) on PostgreSQL, for both Market
// fixtures: the review repository over the real tables (queue, snapshot, checks, scope,
// confirmation, decisions, overview, duplicate hints, erasure), and the constraints, triggers and
// grants of the five new tables (docs/design/data/certification.md 3.10, 3.16a, 3.17, 6.1, 8).

const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const T2 = T0.add({ minutes: 10 });
const ENVELOPE = `v1.${'A'.repeat(48)}`;
const HASH = `hmac-sha256:${'b'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();
const hmac = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const randomHmac = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

describe.each(TEST_MARKETS)('certification admin review in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let sellerSide: PrismaSellerCertificateRepository;
  let reviews: PrismaCertificateReviewRepository;

  const inUnit = <T>(work: () => Promise<T>, m = market): Promise<T> =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unexpected refusal');
        return result.value;
      });

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    sellerSide = new PrismaSellerCertificateRepository(persistence.service);
    reviews = new PrismaCertificateReviewRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }
  async function constraintOf(text: string, values: unknown[] = []): Promise<string | null> {
    try {
      await sql.query(text, values);
      return null;
    } catch (error) {
      return (
        (error as { constraint?: string }).constraint ?? (error as { code?: string }).code ?? null
      );
    }
  }
  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });
  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  async function type() {
    const typeId = uuid7();
    const revisionId = uuid7();
    await insert('certification_types', {
      id: typeId,
      ...base(),
      code: `t${typeId.slice(-12)}`,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T0.toString(),
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
      created_at: T0.toString(),
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
    return { typeId, revisionId, code: `t${typeId.slice(-12)}` };
  }

  async function issuer(typeId: string) {
    const id = uuid7();
    const channelId = uuid7();
    await insert('issuers', {
      id,
      ...base(),
      type_id: typeId,
      display_name: 'Halal Authority',
      display_name_key: `issuer ${id}`,
      accreditation_number: null,
      state: 'active',
      expert_reference_ciphertext: ENVELOPE,
      state_changed_at: T0.toString(),
      state_changed_by_kind: 'seed',
      state_changed_by_account_id: null,
      version: 1,
      created_at: T0.toString(),
    });
    await insert('issuer_contact_channels', {
      id: channelId,
      ...base(),
      issuer_id: id,
      kind: 'web-page',
      value: 'https://authority.example.test',
      created_at: T0.toString(),
    });
    return { issuerId: id, channelId };
  }

  /** A submitted certificate with one file and both index rows, as the seller side writes it. */
  async function submitted(
    typeId: string,
    revisionId: string,
    issuerId: string,
    options: { seller?: string; numberHmac?: Uint8Array; fileHmac?: Uint8Array } = {},
  ) {
    const seller = options.seller ?? uuid7();
    const id = uuid7() as Id<'SellerCertification'>;
    await inUnit(() =>
      sellerSide.add(market, {
        id,
        sellerId: seller as Id<'Seller'>,
        typeId: typeId as Id<'CertificationType'>,
        now: T0,
      }),
    );
    const documentId = uuid7() as Id<'UploadedDocument'>;
    await inUnit(() =>
      sellerSide.addDocument(market, {
        id: documentId,
        certificateId: id,
        expectedVersion: 1,
        sellerId: seller as Id<'Seller'>,
        typeId: typeId as Id<'CertificationType'>,
        position: 1,
        mediaType: 'application/pdf',
        byteSize: 1000,
        pageCount: 1,
        objectKey: `certification/${seller}/${documentId}`,
        dataKeyEnvelope: ENVELOPE,
        cleanSha256: sha(documentId),
        indexHmac: options.fileHmac ?? randomHmac(),
        now: T0,
      }),
    );
    const write: SubmitWrite = {
      certificateId: id,
      expectedVersion: 2,
      sellerId: seller as Id<'Seller'>,
      typeId: typeId as Id<'CertificationType'>,
      typeRevisionId: revisionId as Id<'CertificationTypeRevision'>,
      submissionId: uuid7() as Id<'Submission'>,
      submissionNo: 1,
      kind: 'initial',
      issuerId: issuerId as Id<'Issuer'>,
      certificateNumberCiphertext: ENVELOPE,
      issueDate: Temporal.PlainDate.from('2026-01-01'),
      expiryDate: Temporal.PlainDate.from('2028-01-01'),
      selfDeclared: null,
      selfDeclarationNoteCiphertext: null,
      contentSchemaVersion: 1,
      contentHash: HASH,
      submittedZone: 'Australia/Brisbane',
      submittedAt: T1,
      submittedByAccountId: uuid7() as Id<'Account'>,
      documentIds: [documentId],
      fromStatus: 'draft',
      toStatus: 'in-review',
      numberIndexHmac: options.numberHmac ?? randomHmac(),
      historyId: uuid7() as Id<'CertificationHistory'>,
    };
    await inUnit(() => sellerSide.submit(market, write));
    return { id, seller, documentId, submissionId: write.submissionId, write };
  }

  async function fixture(options: Parameters<typeof submitted>[3] = {}) {
    const { typeId, revisionId } = await type();
    const { issuerId, channelId } = await issuer(typeId);
    const sub = await submitted(typeId, revisionId, issuerId, options);
    return { typeId, issuerId, channelId, ...sub };
  }

  const account = () => uuid7() as Id<'Account'>;
  /** The decision as the use case runs it: lock under the version first, then write. */
  const decideAt = async (
    write: Parameters<PrismaCertificateReviewRepository['decide']>[1] & { expectedVersion: number },
  ) => {
    const { expectedVersion, ...rest } = write;
    await reviews.lockForDecision(market, write.certificateId, expectedVersion, write.decidedAt);
    await reviews.decide(market, rest);
  };
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const checkWrite = (submissionId: Id<'Submission'>, result: 'done' | 'problem') => ({
    id: uuid7() as Id<'ReviewCheck'>,
    submissionId,
    code: 'holder-name',
    result,
    accountId: account(),
    now: T1,
  });

  describe('the repository over the real tables', () => {
    it('lists the waiting submission and reads the snapshot with its issuer and files', async () => {
      const f = await fixture();
      const queue = await inUnit(() => reviews.queue(market, 1000));
      const entry = queue.find((row) => row.certificateId === f.id);
      expect(entry).toMatchObject({
        sellerId: f.seller,
        submissionId: f.submissionId,
        submissionNo: 1,
        kind: 'initial',
        version: 3,
        issuerName: 'Halal Authority',
      });
      // Another Market sees none of it.
      expect(
        (await inUnit(() => reviews.queue(other, 1000), other)).some(
          (r) => r.certificateId === f.id,
        ),
      ).toBe(false);

      const snapshot = await inUnit(() => reviews.snapshot(market, f.id));
      expect(snapshot).toMatchObject({
        pending: true,
        certificate: { id: f.id, version: 3, status: 'in-review' },
        submission: {
          id: f.submissionId,
          verificationMode: 'THIRD_PARTY_DOCUMENT',
          requiresIssuerRegistry: true,
          issuer: { id: f.issuerId, state: 'active' },
          checks: [],
          scope: null,
          confirmation: null,
          decision: null,
        },
      });
      expect(snapshot!.submission!.issuer!.channels.map((c) => c.id)).toEqual([f.channelId]);
      expect(snapshot!.submission!.documents.map((d) => d.id)).toEqual([f.documentId]);
      expect(snapshot!.history.map((h) => h.toStatus)).toEqual(['in-review']);
      expect(await inUnit(() => reviews.snapshot(other, f.id), other)).toBeNull();
    });

    it('keeps the latest result per check and does not move the version', async () => {
      const f = await fixture();
      const write = (result: 'done' | 'problem', at: Temporal.Instant) => ({
        id: uuid7() as Id<'ReviewCheck'>,
        submissionId: f.submissionId,
        code: 'holder-name',
        result,
        accountId: account(),
        now: at,
      });
      await inUnit(() => reviews.recordCheck(market, write('problem', T1)));
      await inUnit(() => reviews.recordCheck(market, write('done', T2)));
      const snapshot = await inUnit(() => reviews.snapshot(market, f.id));
      expect(snapshot!.submission!.checks.map((c) => [c.code, c.result])).toEqual([
        ['holder-name', 'done'],
      ]);
      expect(snapshot!.certificate.version).toBe(3);
      expect(
        (
          await sql.query(
            `SELECT count(*)::int AS n FROM certification.submission_review_checks WHERE submission_id = $1`,
            [f.submissionId],
          )
        ).rows[0],
      ).toEqual({ n: 2 });
    });

    it('records the scope and one confirmation, which moves the version', async () => {
      const f = await fixture();
      await inUnit(() =>
        reviews.recordScope(market, {
          id: uuid7() as Id<'ScopeReading'>,
          submissionId: f.submissionId,
          locationCiphertext: ENVELOPE,
          scopeCiphertext: ENVELOPE,
          accountId: account(),
          now: T1,
        }),
      );
      const confirmation = (expectedVersion: number) => ({
        certificateId: f.id,
        expectedVersion,
        submissionId: f.submissionId,
        issuerId: f.issuerId as Id<'Issuer'>,
        channelId: f.channelId as Id<'IssuerContactChannel'>,
        confirmedOn: Temporal.PlainDate.from('2026-10-16'),
        referenceCiphertext: ENVELOPE,
        accountId: account(),
        now: T1,
      });
      await expect(inUnit(() => reviews.recordConfirmation(market, confirmation(3)))).resolves.toBe(
        'recorded',
      );
      const snapshot = await inUnit(() => reviews.snapshot(market, f.id));
      expect(snapshot!.certificate.version).toBe(4);
      expect(snapshot!.submission!.scope).not.toBeNull();
      expect(snapshot!.submission!.confirmation).toMatchObject({ issuerId: f.issuerId });
      // A reviewer who saw version 3 lost the race.
      await expect(
        inUnit(() => reviews.recordConfirmation(market, confirmation(3))),
      ).rejects.toBeInstanceOf(StaleAggregateError);
    });

    it('approves: decision, history, root pointers and version in one unit; then it is not pending', async () => {
      const f = await fixture();
      const decision = (expectedVersion: number) => ({
        expectedVersion,
        certificateId: f.id,
        submissionId: f.submissionId,
        outcome: 'approved' as const,
        accountId: account(),
        decidedAt: T2,
        approvedZone: 'Australia/Brisbane',
        expiryBoundaryAt: Temporal.Instant.from('2028-01-01T14:00:00Z'),
        reasonCode: null,
        reasonTextCiphertext: null,
        fromStatus: 'in-review' as const,
        toStatus: 'approved' as const,
        historyId: uuid7() as Id<'CertificationHistory'>,
      });
      await expect(inUnit(() => decideAt(decision(2)))).rejects.toBeInstanceOf(StaleAggregateError);
      await inUnit(() => decideAt(decision(3)));

      const snapshot = await inUnit(() => reviews.snapshot(market, f.id));
      expect(snapshot).toMatchObject({
        pending: false,
        certificate: {
          status: 'approved',
          version: 4,
          pendingSubmissionId: null,
          approvedSubmissionId: f.submissionId,
        },
        submission: { id: f.submissionId, decision: { outcome: 'approved', reasonCode: null } },
      });
      expect(snapshot!.history.map((h) => h.toStatus)).toEqual(['in-review', 'approved']);
      expect(
        (await inUnit(() => reviews.queue(market, 1000))).some((r) => r.certificateId === f.id),
      ).toBe(false);

      const overview = await inUnit(() => reviews.overview(market, [f.seller as Id<'Seller'>], T2));
      expect(overview).toEqual([
        expect.objectContaining({ sellerId: f.seller, pendingTypeCodes: [] }),
      ]);
      expect(overview[0]!.validTypeCodes).toHaveLength(1);
      const notice = await inUnit(() => reviews.decisionNotice(market, f.submissionId));
      expect(notice).toMatchObject({ outcome: 'approved', sellerId: f.seller, reasonCode: null });
      // The same decision cannot be written twice.
      await expect(inUnit(() => decideAt(decision(4)))).rejects.toThrow();
    });

    it('records a refusal with its reason and moves the record to changes-needed', async () => {
      const f = await fixture();
      await inUnit(() =>
        decideAt({
          certificateId: f.id,
          expectedVersion: 3,
          submissionId: f.submissionId,
          outcome: 'changes-requested',
          accountId: account(),
          decidedAt: T2,
          approvedZone: null,
          expiryBoundaryAt: null,
          reasonCode: 'unreadable',
          reasonTextCiphertext: ENVELOPE,
          fromStatus: 'in-review',
          toStatus: 'changes-needed',
          historyId: uuid7() as Id<'CertificationHistory'>,
        }),
      );
      const snapshot = await inUnit(() => reviews.snapshot(market, f.id));
      expect(snapshot!.certificate).toMatchObject({
        status: 'changes-needed',
        pendingSubmissionId: null,
        approvedSubmissionId: null,
      });
      expect(await inUnit(() => reviews.decisionNotice(market, f.submissionId))).toMatchObject({
        outcome: 'changes-requested',
        reasonCode: 'unreadable',
      });
    });

    it('R3 order 1: a check holding its share lock first makes the decision wait and then see it', async () => {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const checkUnit = inUnit(async () => {
        await expect(
          reviews.recordCheck(market, checkWrite(f.submissionId, 'problem')),
        ).resolves.toBe(true);
        await gate;
      });
      await delay(300);
      let seen: string[] | null = null;
      const decisionUnit = inUnit(async () => {
        await reviews.lockForDecision(market, f.id, 3, T2);
        const snapshot = await reviews.snapshot(market, f.id);
        seen = snapshot!.submission!.checks.map((c) => c.result);
      });
      await delay(300);
      expect(seen).toBeNull(); // still waiting on the share lock
      release();
      await Promise.all([checkUnit, decisionUnit]);
      expect(seen).toEqual(['problem']);
    });

    it('R3 order 2: a decision holding the lock first makes a check wait and then find nothing pending', async () => {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const decisionUnit = inUnit(async () => {
        await decideAt({
          expectedVersion: 3,
          certificateId: f.id,
          submissionId: f.submissionId,
          outcome: 'changes-requested',
          accountId: account(),
          decidedAt: T2,
          approvedZone: null,
          expiryBoundaryAt: null,
          reasonCode: 'unreadable',
          reasonTextCiphertext: null,
          fromStatus: 'in-review',
          toStatus: 'changes-needed',
          historyId: uuid7() as Id<'CertificationHistory'>,
        });
        await gate;
      });
      await delay(300);
      let written: boolean | null = null;
      const checkUnit = inUnit(async () => {
        written = await reviews.recordCheck(market, checkWrite(f.submissionId, 'done'));
      });
      await delay(300);
      expect(written).toBeNull(); // blocked behind the decision
      release();
      await Promise.all([decisionUnit, checkUnit]);
      expect(written).toBe(false);
      expect(
        (
          await sql.query(
            `SELECT count(*)::int AS n FROM certification.submission_review_checks WHERE submission_id = $1`,
            [f.submissionId],
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    });

    it('does not record a scope on a submission that is not pending', async () => {
      const f = await fixture();
      await inUnit(() =>
        decideAt({
          expectedVersion: 3,
          certificateId: f.id,
          submissionId: f.submissionId,
          outcome: 'declined',
          accountId: account(),
          decidedAt: T2,
          approvedZone: null,
          expiryBoundaryAt: null,
          reasonCode: 'forged',
          reasonTextCiphertext: null,
          fromStatus: 'in-review',
          toStatus: 'declined',
          historyId: uuid7() as Id<'CertificationHistory'>,
        }),
      );
      await expect(
        inUnit(() =>
          reviews.recordScope(market, {
            id: uuid7() as Id<'ScopeReading'>,
            submissionId: f.submissionId,
            locationCiphertext: ENVELOPE,
            scopeCiphertext: ENVELOPE,
            accountId: account(),
            now: T2,
          }),
        ),
      ).resolves.toBe(false);
    });

    it('hints at other sellers with the same number or file, never at the seller itself', async () => {
      const shared = { numberHmac: hmac(41), fileHmac: hmac(42) };
      const first = await fixture(shared);
      const second = await fixture(shared);
      const lone = await fixture();
      const hints = await inUnit(() =>
        reviews.duplicateHints(market, first.submissionId, first.seller as Id<'Seller'>),
      );
      expect(hints.map((h) => [h.kind, h.certificateId, h.sellerId]).sort()).toEqual(
        [
          ['file', second.id, second.seller],
          ['number', second.id, second.seller],
        ].sort(),
      );
      expect(
        await inUnit(() =>
          reviews.duplicateHints(market, lone.submissionId, lone.seller as Id<'Seller'>),
        ),
      ).toEqual([]);
      // A second certificate of the same seller is not a duplicate of it.
      const same = await fixture({ ...shared, seller: first.seller });
      expect(
        (
          await inUnit(() =>
            reviews.duplicateHints(market, same.submissionId, same.seller as Id<'Seller'>),
          )
        ).every((h) => h.sellerId !== same.seller),
      ).toBe(true);
    });

    it('erases the index rows of one seller only', async () => {
      const keep = await fixture({ numberHmac: hmac(51), fileHmac: hmac(52) });
      const gone = await fixture({ numberHmac: hmac(51), fileHmac: hmac(52) });
      const removed = await inUnit(() =>
        reviews.eraseIndexRows(market, gone.seller as Id<'Seller'>),
      );
      expect(removed).toBe(2);
      const left = await sql.query(
        `SELECT (SELECT count(*)::int FROM certification.certificate_number_index WHERE seller_id = $1) AS numbers,
                (SELECT count(*)::int FROM certification.document_index WHERE seller_id = $1) AS files,
                (SELECT count(*)::int FROM certification.certificate_number_index WHERE seller_id = $2) AS kept`,
        [gone.seller, keep.seller],
      );
      expect(left.rows[0]).toEqual({ numbers: 0, files: 0, kept: 1 });
      expect(await inUnit(() => reviews.eraseIndexRows(market, gone.seller as Id<'Seller'>))).toBe(
        0,
      );
    });
  });

  describe('resubmission and renewal over the real tables (slice 8, AC 15)', () => {
    const ZONES = { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' } as never;
    const B1 = Temporal.Instant.from('2028-01-01T14:00:00Z');
    const B4 = Temporal.Instant.from('2029-01-01T14:00:00Z');

    it('keeps the approved certificate valid and confirmed while a renewal is pending, sent back, withdrawn by edit, then approved', async () => {
      const { typeId, revisionId, code: typeCode } = await type();
      const { issuerId, channelId } = await issuer(typeId);
      const f = await submitted(typeId, revisionId, issuerId);
      const sellerId = f.seller as Id<'Seller'>;
      const reader = new PrismaClaimFactsReader(
        persistence.unitOfWork,
        new PrismaRawReadPort(persistence.root).forModule('certification'),
      );
      const facts = async () =>
        (
          await reader.sellerCertificates(market, [
            { sellerId, typeCode: typeCode as CertificationTypeCode },
          ])
        )[0]!.certificate!;
      const decision = (
        submissionId: Id<'Submission'>,
        expectedVersion: number,
        outcome: 'approved' | 'changes-requested',
        fromStatus: 'in-review' | 'approved',
        boundary: Temporal.Instant | null = null,
      ) => ({
        expectedVersion,
        certificateId: f.id,
        submissionId,
        outcome,
        accountId: account(),
        decidedAt: T2,
        approvedZone: outcome === 'approved' ? 'Australia/Brisbane' : null,
        expiryBoundaryAt: boundary,
        reasonCode: outcome === 'approved' ? null : 'unreadable',
        reasonTextCiphertext: outcome === 'approved' ? null : ENVELOPE,
        fromStatus,
        toStatus: 'approved' as const,
        historyId: uuid7() as Id<'CertificationHistory'>,
      });
      const renewal = (no: number, expectedVersion: number, expiry: string): SubmitWrite => ({
        ...f.write,
        expectedVersion,
        submissionId: uuid7() as Id<'Submission'>,
        submissionNo: no,
        kind: 'renewal',
        expiryDate: Temporal.PlainDate.from(expiry),
        submittedAt: T2,
        numberIndexHmac: randomHmac(),
        fromStatus: 'approved',
        toStatus: 'approved',
        historyId: uuid7() as Id<'CertificationHistory'>,
      });

      // 1. The first submission is approved and confirmed with the issuer (versions 3 -> 5).
      await inUnit(() => decideAt(decision(f.submissionId, 3, 'approved', 'in-review', B1)));
      await inUnit(() =>
        reviews.recordConfirmation(market, {
          certificateId: f.id,
          expectedVersion: 4,
          submissionId: f.submissionId,
          issuerId: issuerId as Id<'Issuer'>,
          channelId: channelId as Id<'IssuerContactChannel'>,
          confirmedOn: Temporal.PlainDate.from('2026-10-16'),
          referenceCiphertext: ENVELOPE,
          accountId: account(),
          now: T2,
        }),
      );
      expect(await facts()).toMatchObject({
        status: 'approved',
        approved: { submissionId: f.submissionId, verifiedWithIssuer: true },
      });

      // 2. A renewal is pending: the record stays approved, the claim still reads submission 1.
      const second = renewal(2, 5, '2029-01-01');
      await inUnit(() => sellerSide.submit(market, second));
      const own = () => inUnit(() => sellerSide.findOwn(market, sellerId, f.id));
      expect(await own()).toMatchObject({
        status: 'approved',
        pendingSubmissionId: second.submissionId,
        pendingKind: 'renewal',
        approvedSubmissionId: f.submissionId,
        latestOutcome: null,
      });
      const pendingFacts = await facts();
      expect(pendingFacts).toMatchObject({
        status: 'approved',
        approved: { submissionId: f.submissionId, verifiedWithIssuer: true },
      });
      // Valid until its own boundary, invalid after it until a renewal is approved (AC 15).
      expect(
        sellerCertificateValidAt(pendingFacts, ZONES, B1.subtract({ seconds: 1 })),
      ).toMatchObject({ valid: true, submissionId: f.submissionId });
      expect(sellerCertificateValidAt(pendingFacts, ZONES, B1)).toMatchObject({ valid: false });

      // 3. The renewal is sent back: the approved one is untouched (version 7).
      await inUnit(() =>
        decideAt(decision(second.submissionId, 6, 'changes-requested', 'approved')),
      );
      expect(await own()).toMatchObject({
        status: 'approved',
        pendingSubmissionId: null,
        approvedSubmissionId: f.submissionId,
        latestOutcome: 'changes-requested',
        approvedBoundaryAt: B1,
      });
      expect(await facts()).toMatchObject({ approved: { submissionId: f.submissionId } });

      // 4. A correction is sent, then withdrawn by edit in one root update (versions 8 -> 9).
      const third = renewal(3, 7, '2029-01-01');
      await inUnit(() => sellerSide.submit(market, third));
      const newDraft = {
        ...(await own())!.draft,
        expiryDate: Temporal.PlainDate.from('2029-02-01'),
      };
      await expect(
        inUnit(() =>
          sellerSide.withdraw(market, {
            certificateId: f.id,
            expectedVersion: 7,
            submissionId: third.submissionId,
            cause: 'edited',
            draft: newDraft,
            accountId: account(),
            decidedAt: T2,
            fromStatus: 'approved',
            toStatus: 'approved',
            historyId: uuid7() as Id<'CertificationHistory'>,
          }),
        ),
      ).rejects.toBeInstanceOf(StaleAggregateError);
      await inUnit(() =>
        sellerSide.withdraw(market, {
          certificateId: f.id,
          expectedVersion: 8,
          submissionId: third.submissionId,
          cause: 'edited',
          draft: newDraft,
          accountId: account(),
          decidedAt: T2,
          fromStatus: 'approved',
          toStatus: 'approved',
          historyId: uuid7() as Id<'CertificationHistory'>,
        }),
      );
      const afterEdit = await own();
      expect(afterEdit).toMatchObject({
        version: 9,
        status: 'approved',
        pendingSubmissionId: null,
        approvedSubmissionId: f.submissionId,
        latestOutcome: 'withdrawn',
      });
      expect(afterEdit!.draft.expiryDate!.toString()).toBe('2029-02-01');

      // 5. The next renewal is approved: the pointer moves; the confirmation does not follow.
      const fourth = renewal(4, 9, '2029-01-01');
      await inUnit(() => sellerSide.submit(market, fourth));
      await inUnit(() => decideAt(decision(fourth.submissionId, 10, 'approved', 'approved', B4)));
      expect(await own()).toMatchObject({
        status: 'approved',
        approvedSubmissionId: fourth.submissionId,
        approvedBoundaryAt: B4,
        latestOutcome: 'approved',
      });
      const renewed = await facts();
      expect(renewed).toMatchObject({
        approved: { submissionId: fourth.submissionId, verifiedWithIssuer: false },
      });
      expect(sellerCertificateValidAt(renewed, ZONES, B1)).toMatchObject({ valid: true });

      // 6. The reviewer's list: newest first, each with its decision.
      const snapshot = await inUnit(() => reviews.snapshot(market, f.id, { others: true }));
      expect(snapshot!.submission!.id).toBe(fourth.submissionId);
      expect(
        snapshot!.others.map((o) => [
          o.submissionNo,
          o.kind,
          o.decision?.outcome,
          o.decision?.reasonCode ?? o.decision?.withdrawCause ?? null,
        ]),
      ).toEqual([
        [3, 'renewal', 'withdrawn', 'edited'],
        [2, 'renewal', 'changes-requested', 'unreadable'],
        [1, 'initial', 'approved', null],
      ]);
      expect(snapshot!.others[2]!.decision!.expiryBoundaryAt).toEqual(B1);
      expect((await inUnit(() => reviews.snapshot(market, f.id)))!.others).toEqual([]);
    });

    describe('withdraw by edit in one unit with the file write (Mojtaba N2)', () => {
      const outboxWriter = () => {
        const catalogue = new EventCatalogue();
        catalogue.register('certification', CERTIFICATION_EVENTS);
        catalogue.seal();
        return new PrismaOutboxWriterFactory(
          modelMap,
          persistence.service,
          catalogue,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('certification');
      };
      const newDocument = (f: Awaited<ReturnType<typeof fixture>>, expectedVersion: number) => {
        const id = uuid7() as Id<'UploadedDocument'>;
        return {
          id,
          certificateId: f.id,
          expectedVersion,
          sellerId: f.seller as Id<'Seller'>,
          typeId: f.typeId as Id<'CertificationType'>,
          position: 2,
          mediaType: 'application/pdf' as const,
          byteSize: 500,
          pageCount: 1,
          objectKey: `certification/${f.seller}/${id}`,
          dataKeyEnvelope: ENVELOPE,
          cleanSha256: sha(id),
          indexHmac: randomHmac(),
          now: T2,
        };
      };
      const rows = async (f: Awaited<ReturnType<typeof fixture>>) => ({
        decisions: (
          await sql.query(
            `SELECT outcome, withdraw_cause FROM certification.seller_submission_decisions
              WHERE market_id = $1 AND submission_id = $2`,
            [market.marketId, f.submissionId],
          )
        ).rows,
        edited: (
          await sql.query<{ n: string }>(
            `SELECT count(*) AS n FROM certification.seller_certification_history
              WHERE market_id = $1 AND seller_certification_id = $2 AND reason_code = 'edited'`,
            [market.marketId, f.id],
          )
        ).rows.map((r) => Number(r.n))[0],
        events: (
          await sql.query(
            `SELECT type FROM certification.outbox WHERE market_id = $1 AND aggregate_id = $2`,
            [market.marketId, f.id],
          )
        ).rows.map((r: { type: string }) => r.type),
      });
      const editIn = (f: Awaited<ReturnType<typeof fixture>>) => ({
        deps: { certificates: sellerSide, outbox: outboxWriter(), ids },
        context: testCallContext(market, 'system'),
        owner: { sellerId: f.seller as Id<'Seller'>, accountId: account() },
      });

      it('commits the withdrawal, its history row, its event and the new file together', async () => {
        const f = await fixture();
        const { deps, context, owner } = editIn(f);
        const document = newDocument(f, 4);
        const result = await persistence.unitOfWork.run(market, async () => {
          const stored = await sellerSide.findOwn(market, owner.sellerId, f.id);
          const version = await withdrawForEdit(deps, context, owner, stored!, T2);
          await sellerSide.addDocument(market, { ...document, expectedVersion: version });
          return ok(version);
        });
        expect(result).toEqual({ ok: true, value: 4 });
        const stored = await inUnit(() => sellerSide.findOwn(market, owner.sellerId, f.id));
        expect(stored).toMatchObject({
          version: 5,
          status: 'draft',
          pendingSubmissionId: null,
          latestOutcome: 'withdrawn',
        });
        expect(
          (await inUnit(() => sellerSide.listDocuments(market, f.id))).map((d) => d.id),
        ).toEqual([f.documentId, document.id]);
        expect(await rows(f)).toEqual({
          decisions: [{ outcome: 'withdrawn', withdraw_cause: 'edited' }],
          edited: 1,
          events: ['certification.seller-certification-withdrawn.v1'],
        });
      });

      it('rolls the withdrawal, its history row and its event back when the file write fails', async () => {
        const f = await fixture();
        const { deps, context, owner } = editIn(f);
        const result = await persistence.unitOfWork.run(market, async () => {
          const stored = await sellerSide.findOwn(market, owner.sellerId, f.id);
          const version = await withdrawForEdit(deps, context, owner, stored!, T2);
          // A file that is not on the draft: the use case answers document.not-found.
          const outcome = await sellerSide.removeDocument(
            market,
            f.id,
            uuid7() as Id<'UploadedDocument'>,
            version,
            T2,
          );
          return outcome === 'missing' ? err({ code: 'document.not-found' } as const) : ok(outcome);
        });
        expect(result).toEqual({ ok: false, error: { code: 'document.not-found' } });
        // A quota refusal inside the unit rolls back the same way.
        const quota = await persistence.unitOfWork.run(market, async () => {
          const stored = await sellerSide.findOwn(market, owner.sellerId, f.id);
          await withdrawForEdit(deps, context, owner, stored!, T2);
          const reserved = await sellerSide.reserveQuota(market, owner.sellerId, 10, 1, T2);
          return reserved ? ok(true) : err({ code: 'draft-quota.exceeded' } as const);
        });
        expect(quota).toEqual({ ok: false, error: { code: 'draft-quota.exceeded' } });
        const stored = await inUnit(() => sellerSide.findOwn(market, owner.sellerId, f.id));
        expect(stored).toMatchObject({
          version: 3,
          status: 'in-review',
          pendingSubmissionId: f.submissionId,
          latestOutcome: null,
        });
        expect(await rows(f)).toEqual({ decisions: [], edited: 0, events: [] });
      });
    });

    it('lists the approved submission beside a pending renewal even past ten others', async () => {
      const { typeId, revisionId } = await type();
      const { issuerId } = await issuer(typeId);
      const f = await submitted(typeId, revisionId, issuerId);
      await inUnit(() =>
        decideAt({
          expectedVersion: 3,
          certificateId: f.id,
          submissionId: f.submissionId,
          outcome: 'approved',
          accountId: account(),
          decidedAt: T2,
          approvedZone: 'Australia/Brisbane',
          expiryBoundaryAt: B1,
          reasonCode: null,
          reasonTextCiphertext: null,
          fromStatus: 'in-review',
          toStatus: 'approved',
          historyId: uuid7() as Id<'CertificationHistory'>,
        }),
      );
      let version = 4;
      for (let no = 2; no <= 13; no += 1) {
        const write: SubmitWrite = {
          ...f.write,
          expectedVersion: version,
          submissionId: uuid7() as Id<'Submission'>,
          submissionNo: no,
          kind: 'renewal',
          submittedAt: T2,
          numberIndexHmac: randomHmac(),
          fromStatus: 'approved',
          toStatus: 'approved',
          historyId: uuid7() as Id<'CertificationHistory'>,
        };
        await inUnit(() => sellerSide.submit(market, write));
        version += 1;
        if (no === 13) break;
        await inUnit(() =>
          sellerSide.withdraw(market, {
            certificateId: f.id,
            expectedVersion: version,
            submissionId: write.submissionId,
            cause: 'cancelled',
            accountId: account(),
            decidedAt: T2,
            fromStatus: 'approved',
            toStatus: 'approved',
            historyId: uuid7() as Id<'CertificationHistory'>,
          }),
        );
        version += 1;
      }
      const snapshot = await inUnit(() => reviews.snapshot(market, f.id, { others: true }));
      expect(snapshot!.submission!.submissionNo).toBe(13);
      expect(snapshot!.others.map((o) => o.submissionNo)).toEqual([
        12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1,
      ]);
    });
  });

  describe('constraints, triggers and grants of the new tables', () => {
    it('keeps the three review tables insert-only: 42501 for the application, 23001 for the owner', async () => {
      const f = await fixture();
      const checkId = uuid7();
      await inUnit(() =>
        reviews.recordCheck(market, {
          id: checkId as Id<'ReviewCheck'>,
          submissionId: f.submissionId,
          code: 'holder-name',
          result: 'done',
          accountId: account(),
          now: T1,
        }),
      );
      for (const statement of [
        `UPDATE certification.submission_review_checks SET result = 'problem' WHERE id = $1`,
        `DELETE FROM certification.submission_review_checks WHERE id = $1`,
      ]) {
        expect(await sqlState(sql, statement, [checkId])).toBe('42501');
        expect(await sqlState(owner, statement, [checkId])).toBe('23001');
      }
      for (const table of [
        'submission_review_checks',
        'submission_scope_readings',
        'seller_issuer_confirmations',
      ]) {
        expect(await sqlState(sql, `TRUNCATE certification.${table}`)).toBe('42501');
        expect(await sqlState(owner, `TRUNCATE certification.${table}`)).toBe('23001');
      }
      await inUnit(() =>
        reviews.recordScope(market, {
          id: uuid7() as Id<'ScopeReading'>,
          submissionId: f.submissionId,
          locationCiphertext: ENVELOPE,
          scopeCiphertext: ENVELOPE,
          accountId: account(),
          now: T1,
        }),
      );
      await inUnit(() =>
        reviews.recordConfirmation(market, {
          certificateId: f.id,
          expectedVersion: 3,
          submissionId: f.submissionId,
          issuerId: f.issuerId as Id<'Issuer'>,
          channelId: f.channelId as Id<'IssuerContactChannel'>,
          confirmedOn: Temporal.PlainDate.from('2026-10-16'),
          referenceCiphertext: ENVELOPE,
          accountId: account(),
          now: T1,
        }),
      );
      const bySubmission = [
        `UPDATE certification.submission_scope_readings SET location_ciphertext = location_ciphertext WHERE submission_id = $1`,
        `DELETE FROM certification.seller_issuer_confirmations WHERE submission_id = $1`,
      ];
      for (const statement of bySubmission) {
        expect(await sqlState(sql, statement, [f.submissionId])).toBe('42501');
        expect(await sqlState(owner, statement, [f.submissionId])).toBe('23001');
      }
    });

    it('lets the application delete from the two indexes and nowhere else, and refuses TRUNCATE', async () => {
      const f = await fixture({ numberHmac: hmac(61), fileHmac: hmac(62) });
      expect(
        await sqlState(
          sql,
          `DELETE FROM certification.certificate_number_index WHERE seller_id = $1`,
          [f.seller],
        ),
      ).toBeNull();
      expect(
        await sqlState(
          sql,
          `UPDATE certification.document_index SET seller_id = seller_id WHERE seller_id = $1`,
          [f.seller],
        ),
      ).toBe('42501');
      expect(await sqlState(sql, `TRUNCATE certification.document_index`)).toBe('42501');
    });

    it('refuses a malformed envelope, a short HMAC, one tick and a wrong Market', async () => {
      const f = await fixture();
      const scope = (extra: Record<string, unknown>) => ({
        id: uuid7(),
        ...base(),
        submission_id: f.submissionId,
        location_ciphertext: ENVELOPE,
        scope_ciphertext: ENVELOPE,
        recorded_by_account_id: uuid7(),
        recorded_at: T1.toString(),
        ...extra,
      });
      const tryInsert = async (table: string, row: Record<string, unknown>) => {
        const columns = Object.keys(row);
        return constraintOf(
          `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      expect(
        await tryInsert('submission_scope_readings', scope({ location_ciphertext: 'plain text' })),
      ).toBe('submission_scope_readings_location_ciphertext_check');
      expect(
        await tryInsert(
          'submission_scope_readings',
          scope({ scope_ciphertext: `v1.${'A'.repeat(9000)}` }),
        ),
      ).toBe('submission_scope_readings_scope_ciphertext_check');
      expect(await tryInsert('submission_scope_readings', scope({ market_id: 'au' }))).toBe(
        'submission_scope_readings_market_id_check',
      );
      expect(
        await tryInsert('certificate_number_index', {
          ...base(),
          submission_id: uuid7(),
          seller_id: uuid7(),
          index_hmac: Buffer.alloc(31),
        }),
      ).toBe('certificate_number_index_index_hmac_check');
      expect(
        await tryInsert('document_index', {
          ...base(),
          document_id: uuid7(),
          seller_id: uuid7(),
          index_hmac: Buffer.alloc(33),
        }),
      ).toBe('document_index_index_hmac_check');
      expect(
        await tryInsert('seller_issuer_confirmations', {
          ...base(),
          submission_id: f.submissionId,
          issuer_id: f.issuerId,
          channel_id: f.channelId,
          confirmed_on: '2026-10-16',
          reference_ciphertext: ENVELOPE,
          confirms_number: true,
          confirms_holder: false,
          recorded_by_account_id: uuid7(),
          recorded_at: T1.toString(),
        }),
      ).toBe('seller_issuer_confirmations_both_ticks_check');
      // A check row must name a result of the closed list and a submission that exists.
      expect(
        await tryInsert('submission_review_checks', {
          id: uuid7(),
          ...base(),
          submission_id: f.submissionId,
          check_code: 'holder-name',
          result: 'maybe',
          recorded_by_account_id: uuid7(),
          recorded_at: T1.toString(),
        }),
      ).toBe('submission_review_checks_result_check');
      const dangling = await tryInsert('submission_review_checks', {
        id: uuid7(),
        ...base(),
        submission_id: uuid7(),
        check_code: 'holder-name',
        result: 'done',
        recorded_by_account_id: uuid7(),
        recorded_at: T1.toString(),
      });
      expect(dangling).toMatch(/fkey$/);
    });

    it('binds an index row to the seller of its submission and file (composite keys)', async () => {
      const f = await fixture({ numberHmac: hmac(71), fileHmac: hmac(72) });
      const otherSeller = uuid7();
      expect(
        await constraintOf(
          `INSERT INTO certification.certificate_number_index (market_id, tenant_id, submission_id, seller_id, index_hmac)
           VALUES ($1, $2, $3, $4, $5)`,
          [market.marketId, market.tenantId, uuid7(), otherSeller, Buffer.alloc(32, 3)],
        ),
      ).toMatch(/fkey$/);
      // The file's own index row goes (the application may delete it); the same file under another
      // seller is then refused by the key (market, file, owner).
      await sql.query(`DELETE FROM certification.document_index WHERE document_id = $1`, [
        f.documentId,
      ]);
      expect(
        await constraintOf(
          `INSERT INTO certification.document_index (market_id, tenant_id, document_id, seller_id, index_hmac)
           VALUES ($1, $2, $3, $4, $5)`,
          [market.marketId, market.tenantId, f.documentId, otherSeller, Buffer.alloc(32, 3)],
        ),
      ).toMatch(/fkey$/);
    });
  });
});
