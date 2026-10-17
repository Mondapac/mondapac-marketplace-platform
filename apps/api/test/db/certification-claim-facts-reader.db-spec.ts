import { uuidV7, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import {
  CERTIFICATION_FACADE,
  type CertificationFacade,
  type CertificationTypeCode,
  type ClaimQuery,
} from '../../src/modules/certification';
import { PrismaClaimFactsReader } from '../../src/modules/certification/infrastructure/prisma-claim-facts.reader';
import { sellerCertificateValidAt } from '../../src/modules/certification/domain/validity';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { claimFactsOwnerTestDatabaseUrl, claimFactsTestDatabaseUrl } from './test-database';

// The claim facts reader (certification PR B) on PostgreSQL, for both Market fixtures, on its own
// copy of the run database: the DI-level cases read every type of a Market, so a type without a
// published revision (a fault by design) is repaired before each case ends. Hassan's acceptance
// cases: an approved pointer without an `approved` decision is no valid certificate; a type that
// requires an expiry and a decision without a boundary is not valid; a type whose published
// revision is NULL rejects the read, never dropped; answers follow the request, not the database.

const T0 = '2026-10-08T00:00:00Z';
const NOW = Temporal.Instant.from('2026-10-14T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

interface SeededType {
  readonly code: string;
  readonly typeId: string;
  readonly revisionId: string;
}

interface SeededCertificate {
  readonly certificateId: string;
  readonly submissionId: string | null;
  readonly issuerId: string | null;
}

interface TypeSpec {
  readonly code: string;
  readonly requiresExpiry?: boolean;
  readonly defaultBasis?: 'SELLER_REQUIRED' | 'NOT_APPLICABLE';
  readonly published?: boolean;
  readonly phrase?: string;
  readonly mode?: 'THIRD_PARTY_DOCUMENT' | 'SELF_DECLARATION';
}

interface CertificateSpec {
  readonly sellerId: string;
  readonly status?: string;
  /** No submission: a certificate with no approved pointer. */
  readonly approved?: {
    readonly expiryDate?: string | null;
    readonly decision?: 'approved' | 'withdrawn' | 'none';
    readonly boundary?: boolean;
    readonly issuerState?: string | null;
    /** A reviewer's full issuer confirmation of this submission (needs an issuer). */
    readonly confirmed?: boolean;
  };
}

async function seedTypeRow(
  owner: Client,
  target: MarketContext,
  spec: TypeSpec,
): Promise<SeededType> {
  const scope = (m: MarketContext) => [m.marketId, m.tenantId];
  const typeId = uuid7();
  const revisionId = uuid7();
  await owner.query('BEGIN');
  try {
    await owner.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, $6, 'active', NULL, 1, $5)`,
      [typeId, ...scope(target), spec.code, T0, spec.mode ?? 'THIRD_PARTY_DOCUMENT'],
    );
    await owner.query(
      `INSERT INTO certification.certification_type_revisions
         (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
          requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
          badge_icon_key, author_account_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $9, $10, true, $5, $6, false, 'halal', $7, $8)`,
      [
        revisionId,
        ...scope(target),
        typeId,
        spec.requiresExpiry ?? true,
        spec.defaultBasis ?? 'SELLER_REQUIRED',
        uuid7(),
        T0,
        spec.mode ?? 'THIRD_PARTY_DOCUMENT',
        (spec.mode ?? 'THIRD_PARTY_DOCUMENT') === 'THIRD_PARTY_DOCUMENT',
      ],
    );
    await owner.query(
      `INSERT INTO certification.type_revision_texts
         (market_id, tenant_id, type_revision_id, locale, name, customer_description)
       VALUES ($1, $2, $3, 'en', $4, 'Description')`,
      [...scope(target), revisionId, `Name ${spec.code}`],
    );
    await owner.query(
      `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
       VALUES ($1, $2, $3, 'en', $4)`,
      [...scope(target), revisionId, spec.phrase ?? `phrase${spec.code.replaceAll('-', '')}`],
    );
    if (spec.published !== false) await publishRow(owner, typeId, revisionId);
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
  return { code: spec.code, typeId, revisionId };
}

const publishRow = (owner: Client, typeId: string, revisionId: string) =>
  owner.query(
    `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
    [revisionId, typeId],
  );

describe.each(TEST_MARKETS)('certification claim facts reader, market %s (database)', (code) => {
  const market: MarketContext = marketOf(code);
  const other: MarketContext = marketOf(otherMarketOf(code));
  const scope = (target: MarketContext) => [target.marketId, target.tenantId];
  const tag = code.toLowerCase();
  let persistence: Persistence;
  let owner: Client;
  let reader: PrismaClaimFactsReader;
  let rawPort: PrismaRawReadPort;
  let driver: ReturnType<typeof recordDriverStatements>;

  beforeAll(async () => {
    driver = recordDriverStatements();
    persistence = createPersistence({
      pause: () => Promise.resolve(),
      databaseUrl: claimFactsTestDatabaseUrl(),
    });
    // The real list, bound for `certification` the way `PersistenceModule.rawReadFor` binds it.
    rawPort = new PrismaRawReadPort(persistence.root);
    reader = new PrismaClaimFactsReader(persistence.unitOfWork, rawPort.forModule('certification'));
    owner = new Client({ connectionString: claimFactsOwnerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    driver.restore();
    await owner.end();
    await persistence.close();
  });

  const seedType = (target: MarketContext, spec: TypeSpec) => seedTypeRow(owner, target, spec);
  const publish = (typeId: string, revisionId: string) => publishRow(owner, typeId, revisionId);

  async function seedCertificate(
    target: MarketContext,
    type: SeededType,
    spec: CertificateSpec,
  ): Promise<SeededCertificate> {
    const certificateId = uuid7();
    const [marketId, tenantId] = scope(target);
    await owner.query(
      `INSERT INTO certification.seller_certifications
         (id, market_id, tenant_id, seller_id, type_id, status, status_changed_at, last_changed_at, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1, $7)`,
      [
        certificateId,
        marketId,
        tenantId,
        spec.sellerId,
        type.typeId,
        spec.status ?? 'approved',
        T0,
      ],
    );
    if (spec.approved === undefined) return { certificateId, submissionId: null, issuerId: null };
    const { approved } = spec;
    let issuerId: string | null = null;
    if (approved.issuerState !== undefined && approved.issuerState !== null) {
      issuerId = uuid7();
      await owner.query(
        `INSERT INTO certification.issuers
           (id, market_id, tenant_id, type_id, display_name, display_name_key, state,
            expert_reference_ciphertext, state_changed_at, state_changed_by_kind, version, created_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, 'seed', 1, $8)`,
        [
          issuerId,
          marketId,
          tenantId,
          type.typeId,
          `Issuer ${issuerId}`,
          approved.issuerState,
          `v1.${'A'.repeat(40)}`,
          T0,
        ],
      );
    }
    const submissionId = uuid7();
    await owner.query(
      `INSERT INTO certification.seller_certification_submissions
         (id, market_id, tenant_id, seller_certification_id, seller_id, type_id, type_revision_id,
          submission_no, kind, issuer_id, expiry_date, content_schema_version, content_hash,
          submitted_zone, submitted_at, submitted_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'initial', $8, $9, 1, $10, 'Australia/Brisbane', $11, $12)`,
      [
        submissionId,
        marketId,
        tenantId,
        certificateId,
        spec.sellerId,
        type.typeId,
        type.revisionId,
        issuerId,
        approved.expiryDate === undefined ? '2027-06-30' : approved.expiryDate,
        `hmac-sha256:${'0'.repeat(64)}`,
        T0,
        uuid7(),
      ],
    );
    const decision = approved.decision ?? 'approved';
    if (decision === 'approved') {
      await owner.query(
        `INSERT INTO certification.seller_submission_decisions
           (market_id, tenant_id, submission_id, outcome, approved_zone, expiry_boundary_at,
            actor_kind, decided_at)
         VALUES ($1, $2, $3, 'approved', 'Australia/Brisbane', $4, 'system', $5)`,
        [
          marketId,
          tenantId,
          submissionId,
          approved.boundary === false ? null : '2027-06-30T14:00:00Z',
          T0,
        ],
      );
    } else if (decision === 'withdrawn') {
      await owner.query(
        `INSERT INTO certification.seller_submission_decisions
           (market_id, tenant_id, submission_id, outcome, withdraw_cause, actor_kind, decided_at)
         VALUES ($1, $2, $3, 'withdrawn', 'cancelled', 'system', $4)`,
        [marketId, tenantId, submissionId, T0],
      );
    }
    if (approved.confirmed === true && issuerId !== null) {
      const channelId = uuid7();
      await owner.query(
        `INSERT INTO certification.issuer_contact_channels
           (id, market_id, tenant_id, issuer_id, kind, value, created_at)
         VALUES ($1, $2, $3, $4, 'web-page', 'https://issuer.example/verify', $5)`,
        [channelId, marketId, tenantId, issuerId, T0],
      );
      await owner.query(
        `INSERT INTO certification.seller_issuer_confirmations
           (market_id, tenant_id, submission_id, issuer_id, channel_id, confirmed_on,
            reference_ciphertext, confirms_number, confirms_holder, recorded_by_account_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, '2026-10-08', $6, true, true, $7, $8)`,
        [
          marketId,
          tenantId,
          submissionId,
          issuerId,
          channelId,
          `v1.${'B'.repeat(40)}`,
          uuid7(),
          T0,
        ],
      );
    }
    await owner.query(
      `UPDATE certification.seller_certifications SET approved_submission_id = $1 WHERE id = $2`,
      [submissionId, certificateId],
    );
    return { certificateId, submissionId, issuerId };
  }

  const request = (typeCode: string, categories: string[], handling: string) =>
    ({
      typeCode: typeCode as CertificationTypeCode,
      categoryIds: categories as Id<'Category'>[],
      handling,
    }) as never;

  /** Every ordering of a list: the answer must follow the request whatever the order. */
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  describe('typesAndPolicies', () => {
    it('answers one entry per request, in request order, each with its key, policy null (type default)', async () => {
      // Codes where code-unit order and collation order differ (hyphen against a letter; Sajad F1).
      const a = await seedType(market, { code: `ab-${tag}` });
      const b = await seedType(market, { code: `a-c${tag}`, defaultBasis: 'NOT_APPLICABLE' });
      const requests = [
        request(a.code, ['0192b3c4-0000-7000-8000-000000000001'], 'SEALED_ORIGINAL'),
        request(b.code, ['0192b3c4-0000-7000-8000-000000000002'], 'FRESH'),
        // The same type again with other categories and handling (Hassan #142 Low-2).
        request(a.code, ['0192b3c4-0000-7000-8000-000000000003'], 'PREPARED'),
        request(`missing-${tag}`, [], 'REPACKED'),
      ];
      const expected = [
        {
          typeCode: a.code,
          type: { publishedRevisionId: a.revisionId, defaultBasis: 'SELLER_REQUIRED' },
          policy: null,
        },
        {
          typeCode: b.code,
          type: { publishedRevisionId: b.revisionId, defaultBasis: 'NOT_APPLICABLE' },
          policy: null,
        },
        {
          typeCode: a.code,
          type: { publishedRevisionId: a.revisionId, defaultBasis: 'SELLER_REQUIRED' },
          policy: null,
        },
        { typeCode: `missing-${tag}`, type: null, policy: null },
      ];
      for (const order of permutations([0, 1, 2, 3])) {
        const answers = await reader.typesAndPolicies(
          market,
          order.map((i) => requests[i]!),
        );
        expect(answers).toEqual(order.map((i) => expected[i]));
      }
    });

    it("never answers the other Market's types", async () => {
      const own = await seedType(market, { code: `own-${tag}` });
      const elsewhere = await seedType(other, { code: `own-${tag}` });
      const [mine] = await reader.typesAndPolicies(market, [request(own.code, [], 'FRESH')]);
      expect(mine!.type?.publishedRevisionId).toBe(own.revisionId);
      const [theirs] = await reader.typesAndPolicies(other, [request(own.code, [], 'FRESH')]);
      expect(theirs!.type?.publishedRevisionId).toBe(elsewhere.revisionId);
      expect(own.revisionId).not.toBe(elsewhere.revisionId);
    });

    it('rejects when a requested type has no published revision (a fault, never "type unknown")', async () => {
      const good = await seedType(market, { code: `good-${tag}` });
      const broken = await seedType(market, { code: `broken-${tag}`, published: false });
      try {
        await expect(
          reader.typesAndPolicies(market, [
            request(good.code, [], 'FRESH'),
            request(broken.code, [], 'FRESH'),
          ]),
        ).rejects.toThrow(/no readable published revision/);
        // A type nobody asked for does not fault another request.
        await expect(
          reader.typesAndPolicies(market, [request(good.code, [], 'FRESH')]),
        ).resolves.toHaveLength(1);
      } finally {
        await publish(broken.typeId, broken.revisionId);
      }
    });

    it('issues exactly one SQL statement and no BEGIN', async () => {
      const type = await seedType(market, { code: `one-${tag}` });
      await driver.during(async () => {
        await reader.typesAndPolicies(market, [request(type.code, [], 'FRESH')]);
      });
      expect(driver.statements).toHaveLength(1);
      expect(driver.statements.join(' ')).not.toMatch(/BEGIN|COMMIT|SET TRANSACTION/i);
    });

    it('answers an empty request with no statement', async () => {
      await driver.during(async () => {
        await expect(reader.typesAndPolicies(market, [])).resolves.toEqual([]);
      });
      expect(driver.statements).toHaveLength(0);
    });
  });

  describe('sellerCertificates', () => {
    it('answers a valid approved certificate with its approved submission, issuer and expiry', async () => {
      const type = await seedType(market, { code: `cert-${tag}` });
      const seller = uuid7();
      const seeded = await seedCertificate(market, type, {
        sellerId: seller,
        approved: { issuerState: 'active' },
      });
      const [answer] = await reader.sellerCertificates(market, [
        { sellerId: seller as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
      ]);
      expect(answer).toMatchObject({ sellerId: seller, typeCode: type.code });
      const view = answer!.certificate!;
      expect(view).toMatchObject({
        certificateId: seeded.certificateId,
        status: 'approved',
        approved: {
          submissionId: seeded.submissionId,
          typeRevisionId: type.revisionId,
          requiresExpiry: true,
          zoneAtApproval: 'Australia/Brisbane',
          issuerId: seeded.issuerId,
          issuerState: 'active',
          verificationMode: 'THIRD_PARTY_DOCUMENT',
          issuerDisplayName: `Issuer ${seeded.issuerId}`,
          verifiedWithIssuer: false,
        },
      });
      expect(view.approved!.expiryDate!.toString()).toBe('2027-06-30');
      const zones = {
        zone: 'Australia/Brisbane',
        addressZone: 'Australia/Brisbane',
      } as never;
      expect(sellerCertificateValidAt(view, zones, NOW)).toMatchObject({ valid: true });
    });

    it('reads the badge facts: verified with issuer only for the confirmed submission, mode of the type (AC 23)', async () => {
      const documented = await seedType(market, { code: `badge-${tag}` });
      const declared = await seedType(market, {
        code: `self-${tag}`,
        mode: 'SELF_DECLARATION',
        requiresExpiry: false,
      });
      const confirmedSeller = uuid7();
      const plainSeller = uuid7();
      const declaringSeller = uuid7();
      await seedCertificate(market, documented, {
        sellerId: confirmedSeller,
        approved: { issuerState: 'active', confirmed: true },
      });
      await seedCertificate(market, documented, {
        sellerId: plainSeller,
        approved: { issuerState: 'active' },
      });
      await seedCertificate(market, declared, {
        sellerId: declaringSeller,
        approved: { expiryDate: null },
      });
      const answers = await reader.sellerCertificates(market, [
        {
          sellerId: confirmedSeller as Id<'Seller'>,
          typeCode: documented.code as CertificationTypeCode,
        },
        {
          sellerId: plainSeller as Id<'Seller'>,
          typeCode: documented.code as CertificationTypeCode,
        },
        {
          sellerId: declaringSeller as Id<'Seller'>,
          typeCode: declared.code as CertificationTypeCode,
        },
      ]);
      expect(answers.map((a) => a.certificate?.approved?.verifiedWithIssuer)).toEqual([
        true,
        false,
        false,
      ]);
      expect(answers[2]!.certificate!.approved).toMatchObject({
        verificationMode: 'SELF_DECLARATION',
        issuerId: null,
        issuerDisplayName: null,
      });
      // The other Market never sees this Market's confirmation.
      const [elsewhere] = await reader.sellerCertificates(other, [
        {
          sellerId: confirmedSeller as Id<'Seller'>,
          typeCode: documented.code as CertificationTypeCode,
        },
      ]);
      expect(elsewhere!.certificate).toBeNull();
    });

    it('answers aligned with the request whatever the order, keyed, with duplicates and misses', async () => {
      const t1 = await seedType(market, { code: `s-t1${tag}` });
      const t2 = await seedType(market, { code: `s-t-2${tag}` });
      const s1 = uuid7();
      const s2 = uuid7();
      const c1 = await seedCertificate(market, t1, { sellerId: s1, approved: {} });
      const c2 = await seedCertificate(market, t2, {
        sellerId: s1,
        status: 'in-review',
        approved: {},
      });
      const c3 = await seedCertificate(market, t1, { sellerId: s2 });
      const pairs = [
        { sellerId: s1, typeCode: t1.code },
        { sellerId: s1, typeCode: t2.code },
        { sellerId: s2, typeCode: t1.code },
        { sellerId: s2, typeCode: t2.code },
        { sellerId: s1, typeCode: t1.code },
      ].map((p) => p as { sellerId: Id<'Seller'>; typeCode: CertificationTypeCode });
      const expectedId = [c1, c2, c3, null, c1].map((c) => c?.certificateId ?? null);
      for (const order of permutations([0, 1, 2, 3, 4])) {
        const answers = await reader.sellerCertificates(
          market,
          order.map((i) => pairs[i]!),
        );
        expect(answers.map((a) => ({ s: a.sellerId, t: a.typeCode }))).toEqual(
          order.map((i) => ({ s: pairs[i]!.sellerId, t: pairs[i]!.typeCode })),
        );
        expect(answers.map((a) => a.certificate?.certificateId ?? null)).toEqual(
          order.map((i) => expectedId[i]),
        );
      }
      // An in-review certificate still carries its approved submission: validity is the boundary.
      const [inReview] = await reader.sellerCertificates(market, [pairs[1]!]);
      expect(inReview!.certificate).toMatchObject({ status: 'in-review' });
      expect(inReview!.certificate!.approved).not.toBeNull();
      // A certificate with no approved pointer answers its status and no approved submission.
      const [bare] = await reader.sellerCertificates(market, [pairs[2]!]);
      expect(bare!.certificate).toMatchObject({ certificateId: c3.certificateId, approved: null });
    });

    it('answers null for a declined or revoked certificate (terminal, not an open one)', async () => {
      const type = await seedType(market, { code: `term-${tag}` });
      const declined = uuid7();
      const revoked = uuid7();
      await seedCertificate(market, type, { sellerId: declined, status: 'declined' });
      await seedCertificate(market, type, { sellerId: revoked, status: 'revoked', approved: {} });
      const answers = await reader.sellerCertificates(market, [
        { sellerId: declined as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
        { sellerId: revoked as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
      ]);
      expect(answers.map((a) => a.certificate)).toEqual([null, null]);
    });

    it('treats an approved pointer without an approved decision as no valid certificate (Hassan)', async () => {
      const type = await seedType(market, { code: `nodec-${tag}` });
      const noRow = uuid7();
      const withdrawn = uuid7();
      await seedCertificate(market, type, { sellerId: noRow, approved: { decision: 'none' } });
      await seedCertificate(market, type, {
        sellerId: withdrawn,
        approved: { decision: 'withdrawn' },
      });
      const answers = await reader.sellerCertificates(market, [
        { sellerId: noRow as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
        { sellerId: withdrawn as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
      ]);
      for (const answer of answers) {
        expect(answer.certificate).toMatchObject({ status: 'approved', approved: null });
        expect(
          sellerCertificateValidAt(
            answer.certificate!,
            { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' } as never,
            NOW,
          ),
        ).toEqual({ valid: false, reason: 'no-approved-submission' });
      }
    });

    it('treats a type that requires an expiry with no decision boundary as not valid (Hassan)', async () => {
      const requires = await seedType(market, { code: `req-exp-${tag}`, requiresExpiry: true });
      const optional = await seedType(market, { code: `opt-exp-${tag}`, requiresExpiry: false });
      const seller = uuid7();
      await seedCertificate(market, requires, { sellerId: seller, approved: { boundary: false } });
      await seedCertificate(market, optional, {
        sellerId: seller,
        approved: { boundary: false, expiryDate: null },
      });
      const [needs, free] = await reader.sellerCertificates(market, [
        { sellerId: seller as Id<'Seller'>, typeCode: requires.code as CertificationTypeCode },
        { sellerId: seller as Id<'Seller'>, typeCode: optional.code as CertificationTypeCode },
      ]);
      const zones = { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' } as never;
      expect(needs!.certificate!.approved).toMatchObject({
        requiresExpiry: true,
        expiryDate: null,
      });
      expect(sellerCertificateValidAt(needs!.certificate!, zones, NOW)).toEqual({
        valid: false,
        reason: 'expiry-missing',
      });
      expect(sellerCertificateValidAt(free!.certificate!, zones, NOW)).toMatchObject({
        valid: true,
      });
    });

    it('carries the issuer state, and a derecognised issuer is not valid', async () => {
      const type = await seedType(market, { code: `issuer-${tag}` });
      const seller = uuid7();
      await seedCertificate(market, type, {
        sellerId: seller,
        approved: { issuerState: 'derecognised' },
      });
      const [answer] = await reader.sellerCertificates(market, [
        { sellerId: seller as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
      ]);
      expect(answer!.certificate!.approved).toMatchObject({ issuerState: 'derecognised' });
      expect(
        sellerCertificateValidAt(
          answer!.certificate!,
          { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' } as never,
          NOW,
        ),
      ).toEqual({ valid: false, reason: 'issuer-derecognised' });
    });

    it("never answers the other Market's certificates, for the same seller and type code", async () => {
      const mineType = await seedType(market, { code: `iso-${tag}` });
      const theirType = await seedType(other, { code: `iso-${tag}` });
      const seller = uuid7();
      const mine = await seedCertificate(market, mineType, { sellerId: seller });
      const theirs = await seedCertificate(other, theirType, { sellerId: seller });
      const pair = {
        sellerId: seller as Id<'Seller'>,
        typeCode: `iso-${tag}` as CertificationTypeCode,
      };
      const [inMarket] = await reader.sellerCertificates(market, [pair]);
      const [inOther] = await reader.sellerCertificates(other, [pair]);
      expect(inMarket!.certificate!.certificateId).toBe(mine.certificateId);
      expect(inOther!.certificate!.certificateId).toBe(theirs.certificateId);
    });

    it('issues exactly one SQL statement and no BEGIN', async () => {
      const type = await seedType(market, { code: `stmt-${tag}` });
      const seller = uuid7();
      await seedCertificate(market, type, { sellerId: seller, approved: {} });
      await driver.during(async () => {
        await reader.sellerCertificates(market, [
          { sellerId: seller as Id<'Seller'>, typeCode: type.code as CertificationTypeCode },
        ]);
      });
      expect(driver.statements).toHaveLength(1);
      expect(driver.statements.join(' ')).not.toMatch(/BEGIN|COMMIT|SET TRANSACTION/i);
    });
  });

  describe('the module-bound port with the real list', () => {
    const call = (port: ReturnType<PrismaRawReadPort['forModule']>) =>
      persistence.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await port.rawRead(market, 'certification.type-and-policy', {
            typeCodes: [`x-${tag}`],
          }),
        }),
        { readOnly: true },
      );

    it('answers certification, refuses another module with wrong-module before any database call', async () => {
      const result = await call(rawPort.forModule('certification'));
      expect(result.ok && result.value).toEqual([]);
      await expect(call(rawPort.forModule('catalog'))).rejects.toMatchObject({
        reason: 'wrong-module',
      });
      await driver.during(async () => {
        await call(rawPort.forModule('catalog')).catch(() => undefined);
      });
      expect(driver.statements).toHaveLength(0);
    });
  });
});

// The real application graph (DI), on the same database: `matchClaimTerms`, `certificationTypes`
// and `evaluateClaims` through the facade, with the claim facts reader the module binds.
describe.each(TEST_MARKETS)(
  'certification facade through the real module graph, market %s (database)',
  (code) => {
    const market = marketOf(code);
    const tag = `di-${code.toLowerCase()}`;
    let app: NestExpressApplication;
    let facade: CertificationFacade;
    let owner: Client;
    const typeCodes = { required: `${tag}-req`, notApplicable: `${tag}-na` };

    beforeAll(async () => {
      owner = new Client({ connectionString: claimFactsOwnerTestDatabaseUrl() });
      await owner.connect();
      ({ app } = await createTestApp({ env: { DATABASE_URL: claimFactsTestDatabaseUrl() } }));
      facade = app.get<CertificationFacade>(CERTIFICATION_FACADE, { strict: false });
      for (const [type, basis, phrase] of [
        [typeCodes.required, 'SELLER_REQUIRED', `${code.toLowerCase()}diqorvane`],
        [typeCodes.notApplicable, 'NOT_APPLICABLE', `${code.toLowerCase()}dizedpure`],
      ] as const) {
        await seedTypeRow(owner, market, { code: type, defaultBasis: basis, phrase });
      }
    });
    afterAll(async () => {
      await app.close();
      await owner.end();
    });

    const context = (actor: 'anonymous' | 'system') => testCallContext(market, actor);
    const id = <T extends string>(n: number): Id<T> =>
      `0192b3c4-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<T>;
    const query = (typeCode: string): ClaimQuery => ({
      sellerId: id<'Seller'>(1),
      productId: id<'Product'>(2),
      productRevisionId: id<'ProductRevision'>(3),
      variantId: null,
      typeCode: typeCode as CertificationTypeCode,
      handling: 'SEALED_ORIGINAL',
      attestationRecorded: true,
      platformCategoryPaths: [[id<'Category'>(4)]],
    });

    it.each(['anonymous', 'system'] as const)(
      'certificationTypes lists the seeded types in code order for a %s caller',
      async (actor) => {
        const result = await facade.certificationTypes(context(actor), {});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const codes = result.value.map((t) => t.code as string);
        expect(codes).toEqual([...codes].sort());
        expect(codes).toEqual(
          expect.arrayContaining([typeCodes.required, typeCodes.notApplicable]),
        );
      },
    );

    it.each(['anonymous', 'system'] as const)(
      'matchClaimTerms finds a seeded term and passes clean text for a %s caller',
      async (actor) => {
        const result = await facade.matchClaimTerms(context(actor), [
          { locale: 'en', text: `fully ${code.toLowerCase()}diqorvane goods` },
          { locale: 'en', text: 'plain ordinary goods' },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value[0]!.map((m) => m.typeCode)).toEqual([typeCodes.required]);
        expect(result.value[1]).toEqual([]);
      },
    );

    it('evaluateClaims answers from the database: type-unknown, policy-not-applicable, no valid certificate', async () => {
      const result = await facade.evaluateClaims(context('anonymous'), [
        query(`${tag}-nope`),
        query(typeCodes.notApplicable),
        query(typeCodes.required),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((d) => d.reason)).toEqual([
        'type-unknown',
        'policy-not-applicable',
        'no-valid-seller-certificate',
      ]);
      expect(result.value.some((d) => d.allowed)).toBe(false);
    });
  },
);
