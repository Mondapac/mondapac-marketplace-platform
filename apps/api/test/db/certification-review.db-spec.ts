import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { SubmitWrite } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import { PrismaCertificateReviewRepository } from '../../src/modules/certification/infrastructure/prisma-certificate-review.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
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
    return { typeId, revisionId };
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
        certificateId: f.id,
        expectedVersion,
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
      await expect(inUnit(() => reviews.decide(market, decision(2)))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      await inUnit(() => reviews.decide(market, decision(3)));

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
      await expect(inUnit(() => reviews.decide(market, decision(4)))).rejects.toThrow();
    });

    it('records a refusal with its reason and moves the record to changes-needed', async () => {
      const f = await fixture();
      await inUnit(() =>
        reviews.decide(market, {
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
