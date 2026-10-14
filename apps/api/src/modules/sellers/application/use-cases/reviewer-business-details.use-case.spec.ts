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
  FakeSealer,
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
import { ReviewerBusinessDetailsRead } from './reviewer-business-details.use-case';

// `reviewerBusinessDetails` (sellers design 7.1, 9; board 13 item 3) on both Market fixtures, in
// memory: the names and addresses of the approved revision, the audit row without content, and the
// refusals that must return nothing. PostgreSQL is covered by the review-read e2e and persistence
// specs, which share the same repository and sealer.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const denyAll: AuthorisationCheck = {
  check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
};

const CONTENT: BusinessFileContent = {
  schemaVersion: 1,
  storeName: 'Al Noor Grocer',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
  address: { line1: '1 George St', suburb: 'Brisbane' },
  registeredAddress: { line1: '9 Queen St', suburb: 'Brisbane' },
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

describe.each(['AU', 'ZZ'] as const)('reviewerBusinessDetails in Market %s', (code) => {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const market: MarketContext = testMarketContext(code, 'default');
  const index = identifierIndexKeyOf(new Uint8Array(32).fill(7));
  let revisions: InMemoryRevisions;
  let sealer: FakeSealer;
  let audit: RecordingAudit;
  let warn: jest.SpyInstance;
  let sellerId: Id<'Seller'>;

  const useCase = (authorisation: AuthorisationCheck = admitAll) =>
    new ReviewerBusinessDetailsRead(createUseCaseGate(markets, authorisation), {
      unitOfWork: new TransactionalUnitOfWork([revisions]),
      revisions,
      sealer,
      audit,
    });
  const reviewer = (): CallContext =>
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
    revisionNo: number,
    status: BusinessFileRevision['status'],
    patch: Partial<BusinessFileRevision> = {},
  ): Promise<BusinessFileRevision> {
    const sealed = await sealer.seal(market, sellerId, CONTENT);
    if (!sealed.ok) throw new Error('seal failed');
    const revision = {
      ...newPendingRevision({
        id: ids.next<'BusinessFileRevision'>(),
        sellerId,
        kind: 'onboarding',
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
      status,
      ...patch,
    };
    await revisions.add(market, revision, sealed.value);
    return revision;
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    revisions = new InMemoryRevisions();
    sealer = new FakeSealer();
    audit = new RecordingAudit();
    sellerId = ids.next<'Seller'>();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the names and both addresses of the approved revision and audits the read', async () => {
    const approved = await addRevision(1, 'approved');

    const result = await useCase().execute(reviewer(), { sellerId });

    expect(result).toEqual({
      ok: true,
      value: {
        sellerId,
        revisionId: approved.id,
        businessName: 'Al Noor Pty Ltd',
        storeName: 'Al Noor Grocer',
        operatingAddress: { line1: '1 George St', suburb: 'Brisbane' },
        registeredAddress: { line1: '9 Queen St', suburb: 'Brisbane' },
      },
    });
    // Phone, email and identifier stay behind: only the names and the addresses leave.
    expect(JSON.stringify(result)).not.toContain('3000 0000');
    expect(JSON.stringify(result)).not.toContain('shop@example.com');
    expect(JSON.stringify(result)).not.toContain('51824753556');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'sellers.business-details.viewed',
      targetId: sellerId,
      after: { readKind: 'reviewer-details', revisionId: approved.id },
    });
    expect(JSON.stringify(audit.rows)).not.toContain('Al Noor');
  });

  it('reads the approved revision, not a newer pending one', async () => {
    const approved = await addRevision(1, 'approved');
    await addRevision(2, 'pending');

    const result = await useCase().execute(reviewer(), { sellerId });

    expect(result.ok && result.value.revisionId).toBe(approved.id);
  });

  it('answers seller.details-not-found, with no audit row, when no revision is approved', async () => {
    await addRevision(1, 'pending');

    const result = await useCase().execute(reviewer(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'seller.details-not-found' } });
    expect(audit.rows).toHaveLength(0);
  });

  it('answers the same for an unknown seller', async () => {
    const result = await useCase().execute(reviewer(), { sellerId: ids.next<'Seller'>() });

    expect(result).toEqual({ ok: false, error: { code: 'seller.details-not-found' } });
  });

  it('refuses a malformed id before any read', async () => {
    const result = await useCase().execute(reviewer(), { sellerId: 'not-an-id' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] },
    });
    expect(audit.rows).toHaveLength(0);
  });

  it('is denied without the permission and reads nothing', async () => {
    await addRevision(1, 'approved');

    const result = await useCase(denyAll).execute(reviewer(), { sellerId });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('access.denied');
    expect(audit.rows).toHaveLength(0);
  });

  it('returns nothing when the audit row is refused', async () => {
    await addRevision(1, 'approved');
    audit.refuse = true;

    const result = await useCase().execute(reviewer(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('returns nothing, logs a fixed reason and writes no row when the content hash does not match', async () => {
    await addRevision(1, 'approved', { contentHash: 'tampered' as never });

    const result = await useCase().execute(reviewer(), { sellerId });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    expect(audit.rows).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'content-hash-mismatch', marketId: market.marketId }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Al Noor');
  });

  it('does not read a seller of the other Market', async () => {
    const otherCode = code === 'AU' ? 'ZZ' : 'AU';
    const other: MarketContext = testMarketContext(otherCode, 'default');
    await addRevision(1, 'approved');

    const result = await useCase().execute(
      testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      ),
      { sellerId },
    );

    expect(result).toEqual({ ok: false, error: { code: 'seller.details-not-found' } });
  });
});
