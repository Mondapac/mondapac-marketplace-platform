import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FixedRegisterLookupPolicy,
  InMemoryRegisterChecks,
} from '../../../../../test/support/sellers-register-fakes';
import {
  FakeAccess,
  FakeSealer,
  InMemoryFiles,
  InMemoryRevisions,
  TransactionalUnitOfWork,
} from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  newPendingRevision,
  type BusinessFileContent,
  type BusinessFileRevision,
} from '../../domain/business-file-revision';
import { identifierIndexKeyOf } from '../../domain/business-identifier';
import { registerCheckAfter } from '../../domain/register-check';
import { SellerFile } from '../../domain/seller-file';
import type { RegisterLookupSettings } from '../ports/register-lookup-policy';
import { ReviewRead } from './review-read.use-case';

// The review page of slice 7a-read (sellers design 6.2, 8.3, 9; AC 1), on both Market fixtures, in
// memory: the content in clear, the audit row, the hash check, the register state, and the refusals
// that must leave no row. PostgreSQL is covered by the e2e suite and the persistence specs.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () =>
    Promise.resolve({
      allowed: false,
      denial: { code: 'access.denied' },
    }),
};

const SETTINGS: Record<string, RegisterLookupSettings> = {
  AU: {
    kind: 'configured',
    adapter: 'fake',
    maxResultAgeDays: 30,
    perAccountLimit: 5,
    perOriginLimit: 30,
    marketDailyBudget: 1000,
    legalSuffixes: [],
  },
  ZZ: {
    kind: 'configured',
    adapter: 'fake',
    maxResultAgeDays: 3,
    perAccountLimit: 2,
    perOriginLimit: 30,
    marketDailyBudget: 1000,
    legalSuffixes: [],
  },
};

const CONTENT: BusinessFileContent = {
  schemaVersion: 1,
  storeName: 'Al Noor Grocer',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
  address: { line1: '1 George St', suburb: 'Brisbane' },
  registeredAddress: null,
  identifier: { scheme: 'abn', value: '51824753556' },
  registeredForIndirectTax: true,
};

class RecordingAudit implements AuditWriter {
  readonly rows: AuditEntry[] = [];
  refuse = false;
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (this.refuse) return Promise.reject(new Error('audit refused'));
    this.rows.push(entry);
    return Promise.resolve();
  }
}

describe.each(['AU', 'ZZ'] as const)('review.read in Market %s', (code) => {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const market: MarketContext = testMarketContext(code, 'default');
  let files: InMemoryFiles;
  let revisions: InMemoryRevisions;
  let sealer: FakeSealer;
  let checks: InMemoryRegisterChecks;
  let access: FakeAccess;
  let audit: RecordingAudit;
  let policy: FixedRegisterLookupPolicy;
  let warn: jest.SpyInstance;
  let sellerId: Id<'Seller'>;
  const index = identifierIndexKeyOf(new Uint8Array(32).fill(7));

  const useCase = (authorisation: AuthorisationCheck = admitAll) =>
    new ReviewRead(createUseCaseGate(markets, authorisation), {
      unitOfWork: new TransactionalUnitOfWork([files, revisions, checks]),
      files,
      revisions,
      sealer,
      registerChecks: checks,
      registerPolicy: policy,
      accessReader: access,
      identifierSchemes: { schemeOf: () => null },
      audit,
      clock,
    });
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  async function addRevision(
    kind: 'onboarding' | 'identity-change',
    revisionNo: number,
    content = CONTENT,
    patch: Partial<BusinessFileRevision> = {},
  ): Promise<BusinessFileRevision> {
    const sealed = await sealer.seal(market, sellerId, content);
    if (!sealed.ok) throw new Error('seal failed');
    const revision = {
      ...newPendingRevision({
        id: ids.next<'BusinessFileRevision'>(),
        sellerId,
        kind,
        revisionNo,
        authorKind: 'seller',
        authorAccountId: ids.next<'Account'>(),
        snapshot: {
          operatingTimezone: 'Australia/Brisbane',
          serviceAreaCode: 'area-1',
          addressTimezone: 'Australia/Brisbane',
          identifierIndex: index,
        },
        contentHash: sealed.value.contentHash,
        register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
        now: START,
      }),
      ...patch,
    };
    await revisions.add(market, revision, sealed.value);
    return revision;
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    files = new InMemoryFiles();
    revisions = new InMemoryRevisions();
    sealer = new FakeSealer();
    checks = new InMemoryRegisterChecks();
    access = new FakeAccess();
    audit = new RecordingAudit();
    policy = new FixedRegisterLookupPolicy({ [code]: SETTINGS[code]! });
    sellerId = ids.next<'Seller'>();
    files.add(
      SellerFile.create({
        sellerId,
        marketId: market.marketId,
        origin: 'self',
        approvalRequiredAtRegistration: true,
        now: START,
      }),
    );
    access.set(sellerId, 'pending');
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the pending revision in clear and writes one audit row that holds no content', async () => {
    const revision = await addRevision('onboarding', 1);

    const result = await useCase().execute(admin(), { sellerId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.access).toBe('pending');
    expect(result.value.previous).toBeNull();
    expect(result.value.current).toMatchObject({
      id: revision.id,
      kind: 'onboarding',
      status: 'pending',
      content: {
        storeName: 'Al Noor Grocer',
        businessName: 'Al Noor Pty Ltd',
        phone: '+61 7 3000 0000',
        contactEmail: 'shop@example.com',
        address: CONTENT.address,
        identifier: { scheme: 'abn', value: '51824753556', display: '51824753556' },
      },
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'sellers.business-details.viewed',
      targetId: sellerId,
      after: { readKind: 'review', revisionId: revision.id, previousRevisionId: null },
    });
    const logged = JSON.stringify(audit.rows);
    for (const secret of ['Al Noor', '3000 0000', 'example.com', '51824753556', 'George']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('shows the approved revision beside a pending identity change, and nothing older', async () => {
    const first = await addRevision('onboarding', 1, CONTENT, {
      status: 'approved',
      decidedAt: START,
    });
    const second = await addRevision('identity-change', 2, { ...CONTENT, storeName: 'Al Noor 2' });
    access.set(sellerId, 'approved');

    const result = await useCase().execute(admin(), { sellerId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current.id).toBe(second.id);
    expect(result.value.current.content.storeName).toBe('Al Noor 2');
    expect(result.value.previous?.id).toBe(first.id);
    expect(audit.rows[0]).toMatchObject({
      after: { revisionId: second.id, previousRevisionId: first.id },
    });
  });

  it('reads the latest revision when none is pending', async () => {
    const rejected = await addRevision('onboarding', 1, CONTENT, { status: 'rejected' });
    access.set(sellerId, 'rejected');

    const result = await useCase().execute(admin(), { sellerId });

    expect(result.ok && result.value.current.id).toBe(rejected.id);
  });

  it('answers file.not-found alike for an unknown id, a malformed id and a seller of another Market', async () => {
    await addRevision('onboarding', 1);
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const foreign = ids.next<'Seller'>();
    const answers: string[] = [];
    for (const target of [ids.next<'Seller'>(), 'not-an-id', 42 as never, foreign]) {
      const context =
        target === foreign
          ? testCallContext(
              otherMarket,
              testAuthenticatedActor(otherMarket, {
                population: 'admin',
                accountId: ids.next<'Account'>(),
                sessionId: ids.next<'Session'>(),
                sellerId: null,
              }),
            )
          : admin();
      const result = await useCase().execute(context, { sellerId: target });
      answers.push(JSON.stringify(result));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(audit.rows).toEqual([]);
  });

  it('answers review.no-revision for a seller that has submitted nothing, with no audit row', async () => {
    const result = await useCase().execute(admin(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'review.no-revision' } });
    expect(audit.rows).toEqual([]);
  });

  it('refuses a content that no longer matches its recorded hash, and writes no audit row', async () => {
    await addRevision('onboarding', 1, CONTENT, {
      contentHash: `hmac-sha256:${'0'.repeat(64)}` as never,
    });

    const result = await useCase().execute(admin(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    expect(audit.rows).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'sellers.review-read-refused',
        reason: 'content-hash-mismatch',
        marketId: code,
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Al Noor');
  });

  it('returns nothing when the audit row is refused (design 9)', async () => {
    await addRevision('onboarding', 1);
    audit.refuse = true;

    const result = await useCase().execute(admin(), { sellerId });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Al Noor');
  });

  it('answers sellers.unavailable when identity cannot answer', async () => {
    await addRevision('onboarding', 1);
    access.failing = true;

    const result = await useCase().execute(admin(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    expect(audit.rows).toEqual([]);
  });

  it('is refused by the gate without the key, with no read and no row', async () => {
    await addRevision('onboarding', 1);

    const result = await useCase(denyAll).execute(admin(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(audit.rows).toEqual([]);
  });

  describe('the register state beside the content', () => {
    it('blocks approval when nothing was checked (manual check needed, AC 32)', async () => {
      await addRevision('onboarding', 1);

      const result = await useCase().execute(admin(), { sellerId });

      expect(result.ok && result.value.register).toMatchObject({
        lookup: 'configured',
        state: 'not-performed',
        blocksApproval: true,
      });
    });

    it('does not block on a fresh active result for the revision identifier', async () => {
      await addRevision('onboarding', 1);
      checks.rows.set(
        `${market.marketId}|${sellerId}|${Buffer.from(index).toString('hex')}`,
        registerCheckAfter(
          null,
          'active',
          [],
          START.add({ minutes: 1 }),
          { kind: 'reviewer', accountId: ids.next<'Account'>() },
          1,
        ),
      );

      const result = await useCase().execute(admin(), { sellerId });

      expect(result.ok && result.value.register).toMatchObject({
        state: 'active',
        blocksApproval: false,
      });
    });

    it('reports a Market with no register as lookup none and blocking', async () => {
      await addRevision('onboarding', 1);
      policy.set(code, { kind: 'none' });

      const result = await useCase().execute(admin(), { sellerId });

      expect(result.ok && result.value.register).toMatchObject({
        lookup: 'none',
        state: 'not-performed',
        blocksApproval: true,
      });
    });
  });
});
