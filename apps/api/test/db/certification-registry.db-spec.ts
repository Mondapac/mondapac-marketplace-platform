import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SubmitWrite } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import type { TypeRevisionContent } from '../../src/modules/certification/domain/type-revision';
import { PrismaCertificateReviewRepository } from '../../src/modules/certification/infrastructure/prisma-certificate-review.repository';
import { PrismaCertificationRegistryRepository } from '../../src/modules/certification/infrastructure/prisma-certification-registry.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { SubjectKeyRegistryCipher } from '../../src/modules/certification/infrastructure/subject-key-registry-cipher';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from '../support/test-config';
import {
  createPersistence,
  gate,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The type and issuer registry of certification slice 12 on PostgreSQL, for both Market
// fixtures: the registry repository over the tables of migration 2 (types, revisions, issuers,
// relaxation proposals, the platform subject), the cipher on the real subject-key service, the
// approved-certificate count of the derecognition form, and the share lock of an approval against
// a concurrent issuer state change (docs/design/data/certification.md 3.7, 3.20, 3.22).

const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const T2 = T0.add({ minutes: 10 });
const ENVELOPE = `v1.${'A'.repeat(48)}`;
const HASH = `hmac-sha256:${'b'.repeat(64)}`;
const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const idGenerator: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(TEST_MARKETS)('certification registry in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locales = configs.get(testMarketId(code))!.supportedLocales;
  let persistence: Persistence;
  let sql: Client;
  let registry: PrismaCertificationRegistryRepository;
  let reviews: PrismaCertificateReviewRepository;
  let sellerSide: PrismaSellerCertificateRepository;
  let cipher: SubjectKeyRegistryCipher;
  let keys: NodeSubjectKeyService;

  const inUnit = <T>(work: () => Promise<T>, m: MarketContext = market): Promise<T> =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unexpected refusal');
        return result.value;
      });
  const read = <T>(work: () => Promise<T>, m: MarketContext = market): Promise<T> =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()), { readOnly: true })
      .then((result) => {
        if (!result.ok) throw new Error('unexpected refusal');
        return result.value;
      });

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    registry = new PrismaCertificationRegistryRepository(persistence.service);
    reviews = new PrismaCertificateReviewRepository(persistence.service);
    sellerSide = new PrismaSellerCertificateRepository(persistence.service);
    const clock = new FixedClock(T0);
    keys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(persistence.service, persistence.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    cipher = new SubjectKeyRegistryCipher(
      keys,
      persistence.unitOfWork,
      registry,
      idGenerator,
      clock,
    );
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  const contentOf = (overrides: Partial<TypeRevisionContent> = {}): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: true,
    defaultBasis: 'SELLER_REQUIRED',
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'seal',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        { name: 'Qorvane', customerDescription: 'Holds a certificate.', claimTerms: ['qorvane'] },
      ]),
    ),
    ...overrides,
  });

  /**
   * A type with its first revision published. Its code starts with `a`, so it is among the first
   * of the list whatever other files add to the shared database.
   */
  async function type(): Promise<{
    typeId: Id<'CertificationType'>;
    revisionId: Id<'CertificationTypeRevision'>;
  }> {
    const typeId = uuid7() as Id<'CertificationType'>;
    const revisionId = uuid7() as Id<'CertificationTypeRevision'>;
    await sql.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
      [typeId, market.marketId, market.tenantId, `a${typeId.slice(-12)}`, T0.toString()],
    );
    await inUnit(() =>
      registry.addRevision(market, {
        id: revisionId,
        typeId,
        content: contentOf(),
        authorAccountId: uuid7() as Id<'Account'>,
        changeReasonCiphertext: null,
        createdAt: T0,
      }),
    );
    await sql.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, typeId],
    );
    return { typeId, revisionId };
  }

  async function issuer(typeId: Id<'CertificationType'>, name = 'Example Certifiers') {
    const id = uuid7() as Id<'Issuer'>;
    const refused = await inUnit(() =>
      registry.addIssuer(market, {
        id,
        typeId,
        displayName: name,
        displayNameKey: name.toLowerCase(),
        accreditationNumber: null,
        accountId: uuid7() as Id<'Account'>,
        createdAt: T0,
      }),
    );
    expect(refused).toBeNull();
    return id;
  }

  /** A certificate of `seller` naming `issuerId`, submitted and waiting for review. */
  async function submitted(
    typeId: Id<'CertificationType'>,
    revisionId: Id<'CertificationTypeRevision'>,
    issuerId: Id<'Issuer'>,
    seller: Id<'Seller'>,
  ) {
    const id = uuid7() as Id<'SellerCertification'>;
    await inUnit(() => sellerSide.add(market, { id, sellerId: seller, typeId, now: T0 }));
    const submissionId = uuid7() as Id<'Submission'>;
    const write: SubmitWrite = {
      certificateId: id,
      expectedVersion: 1,
      sellerId: seller,
      typeId,
      typeRevisionId: revisionId,
      submissionId,
      submissionNo: 1,
      kind: 'initial',
      issuerId,
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
      documentIds: [],
      fromStatus: 'draft',
      toStatus: 'in-review',
      numberIndexHmac: crypto.getRandomValues(new Uint8Array(32)),
      historyId: uuid7() as Id<'CertificationHistory'>,
    };
    await inUnit(() => sellerSide.submit(market, write));
    return { id, submissionId };
  }

  /** An approved certificate of `seller` naming `issuerId`, as the seller side and review write. */
  async function approved(
    typeId: Id<'CertificationType'>,
    revisionId: Id<'CertificationTypeRevision'>,
    issuerId: Id<'Issuer'>,
    seller: Id<'Seller'>,
  ) {
    const { id, submissionId } = await submitted(typeId, revisionId, issuerId, seller);
    await inUnit(async () => {
      await reviews.lockForDecision(market, id, 2, T2);
      await reviews.decide(market, {
        certificateId: id,
        submissionId,
        outcome: 'approved',
        accountId: uuid7() as Id<'Account'>,
        decidedAt: T2,
        approvedZone: 'Australia/Brisbane',
        expiryBoundaryAt: Temporal.Instant.from('2028-01-01T14:00:00Z'),
        reasonCode: null,
        reasonTextCiphertext: null,
        fromStatus: 'in-review',
        toStatus: 'approved',
        historyId: uuid7() as Id<'CertificationHistory'>,
      });
    });
    return id;
  }

  it('saves, publishes and reads revisions with their texts and terms', async () => {
    const { typeId, revisionId } = await type();
    const first = await read(() => registry.revision(market, revisionId));
    expect(first).toMatchObject({ revisionNo: 1, content: contentOf() });

    const next = uuid7() as Id<'CertificationTypeRevision'>;
    const content = contentOf({ badgeIconKey: 'shield' });
    const revisionNo = await inUnit(async () => {
      const no = await registry.addRevision(market, {
        id: next,
        typeId,
        content,
        authorAccountId: uuid7() as Id<'Account'>,
        changeReasonCiphertext: ENVELOPE,
        createdAt: T1,
      });
      await registry.publishRevision(market, typeId, next, 1);
      return no;
    });
    expect(revisionNo).toBe(2);
    expect(await read(() => registry.revision(market, next))).toMatchObject({
      revisionNo: 2,
      content,
      changeReasonCiphertext: ENVELOPE,
    });
    expect(await read(() => registry.type(market, typeId))).toMatchObject({
      publishedRevisionId: next,
      version: 2,
    });
    const rows = await read(() => registry.listTypes(market));
    expect(rows.find((r) => r.type.id === typeId)).toMatchObject({
      publishedRevisionNo: 2,
      names: Object.fromEntries(locales.map((l) => [l, 'Qorvane'])),
      pendingSubjects: [],
    });
    // A moved version is stale; the other Market sees nothing.
    await expect(
      inUnit(() => registry.setTypeStatus(market, typeId, 'inactive', 1)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    await inUnit(() => registry.setTypeStatus(market, typeId, 'inactive', 2));
    expect(await read(() => registry.type(other, typeId), other)).toBeNull();
  });

  it('keeps one pending proposal per subject and refuses the proposer as decider', async () => {
    const { typeId } = await type();
    const proposer = uuid7() as Id<'Account'>;
    const proposal = (id: Id<'RelaxationProposal'>) => ({
      id,
      subject: 'type-reactivation' as const,
      subjectId: typeId,
      basedOnRevisionId: null,
      proposedRevisionId: null,
      proposedExpertReferenceCiphertext: null,
      proposerAccountId: proposer,
      changeReasonCiphertext: null,
      proposedAt: T0,
    });
    const first = uuid7() as Id<'RelaxationProposal'>;
    expect(await inUnit(() => registry.addProposal(market, proposal(first)))).toBeNull();
    expect(
      await inUnit(() =>
        registry.addProposal(market, proposal(uuid7() as Id<'RelaxationProposal'>)),
      ),
    ).toBe('review.proposal-pending');
    expect(
      await read(() => registry.pendingProposal(market, 'type-reactivation', typeId)),
    ).toMatchObject({ id: first, state: 'pending', version: 1 });

    // The CHECK refuses the proposer as the second admin, whatever the use case does.
    await expect(
      inUnit(() =>
        registry.closeProposal(market, {
          id: first,
          expectedVersion: 1,
          state: 'approved',
          decidedByAccountId: proposer,
          decidedAt: T1,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inUnit(() =>
        registry.closeProposal(market, {
          id: first,
          expectedVersion: 2,
          state: 'approved',
          decidedByAccountId: uuid7() as Id<'Account'>,
          decidedAt: T1,
        }),
      ),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    const second = uuid7() as Id<'Account'>;
    await inUnit(() =>
      registry.closeProposal(market, {
        id: first,
        expectedVersion: 1,
        state: 'approved',
        decidedByAccountId: second,
        decidedAt: T1,
      }),
    );
    expect(await read(() => registry.proposal(market, first))).toMatchObject({
      state: 'approved',
      decidedByAccountId: second,
      version: 2,
    });
    // Decided, the row is frozen; a new proposal of the subject may follow.
    await expect(
      sql.query(
        `UPDATE certification.relaxation_proposals SET state = 'pending', decided_by_account_id = NULL, decided_at = NULL WHERE id = $1`,
        [first],
      ),
    ).rejects.toThrow();
    expect(
      await inUnit(() =>
        registry.addProposal(market, proposal(uuid7() as Id<'RelaxationProposal'>)),
      ),
    ).toBeNull();
    expect(await read(() => registry.proposal(other, first), other)).toBeNull();
  });

  it('adds issuers with unique names and numbers, changes state under the version and pages', async () => {
    const { typeId } = await type();
    const first = await issuer(typeId, 'Alpha Certifiers');
    const add = (name: string, accreditationNumber: string | null) =>
      inUnit(() =>
        registry.addIssuer(market, {
          id: uuid7() as Id<'Issuer'>,
          typeId,
          displayName: name,
          displayNameKey: name.toLowerCase(),
          accreditationNumber,
          accountId: uuid7() as Id<'Account'>,
          createdAt: T0,
        }),
      );
    expect(await add('ALPHA CERTIFIERS', null)).toBe('issuer.name-taken');
    expect(await add('Beta Certifiers', 'ACC-7')).toBeNull();
    expect(await add('Gamma Certifiers', 'ACC-7')).toBe('issuer.accreditation-taken');

    await expect(
      inUnit(() =>
        registry.setIssuerState(market, {
          id: first,
          expectedVersion: 2,
          state: 'active',
          expertReferenceCiphertext: ENVELOPE,
          accountId: uuid7() as Id<'Account'>,
          changedAt: T1,
        }),
      ),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    const admin = uuid7() as Id<'Account'>;
    await inUnit(() =>
      registry.setIssuerState(market, {
        id: first,
        expectedVersion: 1,
        state: 'active',
        expertReferenceCiphertext: ENVELOPE,
        accountId: admin,
        changedAt: T1,
      }),
    );
    expect(await read(() => registry.issuer(market, first))).toMatchObject({
      state: 'active',
      expertReferenceCiphertext: ENVELOPE,
      stateChangedByKind: 'admin',
      stateChangedByAccountId: admin,
      version: 2,
    });
    const page = await read(() =>
      registry.listIssuers(market, { typeId, state: null, afterId: null, limit: 1 }),
    );
    expect(page).toHaveLength(1);
    const rest = await read(() =>
      registry.listIssuers(market, { typeId, state: null, afterId: page[0]!.id, limit: 10 }),
    );
    expect(rest).toHaveLength(1);
    expect(
      await read(() =>
        registry.listIssuers(market, { typeId, state: 'active', afterId: null, limit: 10 }),
      ),
    ).toEqual([expect.objectContaining({ id: first })]);
    expect(await read(() => registry.issuer(other, first), other)).toBeNull();
  });

  it('counts approved certificates per issuer and lists their sellers by page', async () => {
    const { typeId, revisionId } = await type();
    const issuerId = await issuer(typeId);
    await sql.query(
      `UPDATE certification.issuers SET state = 'active', expert_reference_ciphertext = $2 WHERE id = $1`,
      [issuerId, ENVELOPE],
    );
    const sellers = [uuid7(), uuid7(), uuid7()].sort() as Id<'Seller'>[];
    for (const seller of sellers) await approved(typeId, revisionId, issuerId, seller);
    expect(await read(() => registry.approvedCertificateCount(market, issuerId))).toBe(3);
    expect(await read(() => registry.affectedSellers(market, issuerId, null, 2))).toEqual(
      sellers.slice(0, 2),
    );
    expect(await read(() => registry.affectedSellers(market, issuerId, sellers[1]!, 2))).toEqual([
      sellers[2],
    ]);
    expect(await read(() => registry.approvedCertificateCount(other, issuerId), other)).toBe(0);
  }, 30_000);

  it('counts only approved certificates whose approved submission names the issuer (Mojtaba 3d)', async () => {
    const { typeId, revisionId } = await type();
    const [issuerId, otherIssuer] = [
      await issuer(typeId, 'Counted Certifiers'),
      await issuer(typeId, 'Other Certifiers'),
    ];
    await sql.query(
      `UPDATE certification.issuers SET state = 'active', expert_reference_ciphertext = $2 WHERE id = ANY($1)`,
      [[issuerId, otherIssuer], ENVELOPE],
    );
    const seller = () => uuid7() as Id<'Seller'>;
    const counted = seller();
    await approved(typeId, revisionId, issuerId, counted);
    const revoked = await approved(typeId, revisionId, issuerId, seller());
    const expired = await approved(typeId, revisionId, issuerId, seller());
    await sql.query(
      `UPDATE certification.seller_certifications SET status = 'revoked' WHERE id = $1`,
      [revoked],
    );
    await sql.query(
      `UPDATE certification.seller_certifications SET status = 'expired' WHERE id = $1`,
      [expired],
    );
    await submitted(typeId, revisionId, issuerId, seller());
    await approved(typeId, revisionId, otherIssuer, seller());

    expect(await read(() => registry.approvedCertificateCount(market, issuerId))).toBe(1);
    expect(await read(() => registry.affectedSellers(market, issuerId, null, 10))).toEqual([
      counted,
    ]);
    expect(await read(() => registry.approvedCertificateCount(market, otherIssuer))).toBe(1);
  }, 30_000);

  it('makes a type status change wait behind the share lock of an approval (Hassan L3)', async () => {
    const { typeId } = await type();
    const held = gate();
    let shared: unknown = null;
    const approval = inUnit(async () => {
      shared = await reviews.shareRegistryRows(market, typeId, null);
      await held.opened;
    });
    await delay(200);
    let changed = false;
    const change = inUnit(async () => {
      await registry.setTypeStatus(market, typeId, 'inactive', 1);
      changed = true;
    });
    await delay(300);
    expect(shared).toEqual({ typeStatus: 'active', issuer: null });
    expect(changed).toBe(false);
    held.open();
    await Promise.all([approval, change]);
    expect(changed).toBe(true);
    expect(await read(() => registry.type(market, typeId))).toMatchObject({
      status: 'inactive',
      version: 2,
    });
  }, 30_000);

  it('seals expert references under one platform subject and reasons under their own keys', async () => {
    const approval = { confirmedBy: 'Expert One', reference: 'MEMO-2026-001' };
    const [a, b] = await Promise.all([
      cipher.sealExpertApproval(market, 'issuer', approval),
      cipher.sealExpertApproval(market, 'proposal', approval),
    ]);
    const subjects = await sql.query(
      `SELECT subject_id FROM certification.platform_subjects WHERE market_id = $1`,
      [market.marketId],
    );
    expect(subjects.rows).toHaveLength(1);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain('MEMO');
    expect(await cipher.openExpertApproval(market, 'issuer', a)).toEqual(approval);
    expect(await cipher.openExpertApproval(market, 'proposal', b)).toEqual(approval);
    // Each label binds its column: a reference moved to the other column does not open.
    await expect(cipher.openExpertApproval(market, 'proposal', a)).rejects.toThrow();

    const holder = uuid7() as Id;
    const sealed = await inUnit(() => cipher.sealChangeReason(market, holder, 'Because'));
    expect(await cipher.openChangeReason(market, holder, sealed)).toEqual({
      state: 'given',
      text: 'Because',
    });
    await inUnit(() => keys.destroyKey(market, holder));
    expect(await cipher.openChangeReason(market, holder, sealed)).toEqual({ state: 'erased' });
  });

  it('makes an issuer state change wait behind the share lock of an approval', async () => {
    const { typeId } = await type();
    const issuerId = await issuer(typeId);
    const held = gate();
    let shared: unknown = null;
    const approval = inUnit(async () => {
      shared = await reviews.shareRegistryRows(market, typeId, issuerId);
      await held.opened;
    });
    await delay(200);
    let changed = false;
    const change = inUnit(async () => {
      await registry.setIssuerState(market, {
        id: issuerId,
        expectedVersion: 1,
        state: 'active',
        expertReferenceCiphertext: ENVELOPE,
        accountId: uuid7() as Id<'Account'>,
        changedAt: T1,
      });
      changed = true;
    });
    await delay(300);
    expect(shared).toEqual({ typeStatus: 'active', issuer: { state: 'proposed', typeId } });
    expect(changed).toBe(false);
    held.open();
    await Promise.all([approval, change]);
    expect(changed).toBe(true);
  }, 30_000);
});
