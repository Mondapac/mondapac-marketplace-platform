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
import { CarrierPickupRead } from './carrier-pickup.use-case';

// `carrierPickup` (SHP-02/03) on both Market fixtures, in memory: the store name, phone and
// operating address of the approved revision for the real-time carrier, the audit row with the
// seller order and without content, and the refusals that must return nothing. It shares the
// repository and the sealer with `reviewerBusinessDetails`.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

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

describe.each(['AU', 'ZZ'] as const)('carrierPickup in Market %s', (code) => {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const market: MarketContext = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');
  const index = identifierIndexKeyOf(new Uint8Array(32).fill(7));
  let revisions: InMemoryRevisions;
  let sealer: FakeSealer;
  let audit: RecordingAudit;
  let warn: jest.SpyInstance;
  let sellerId: Id<'Seller'>;
  let sellerOrderId: Id<'SellerOrder'>;

  const useCase = (authorisation: AuthorisationCheck = admitAll) =>
    new CarrierPickupRead(createUseCaseGate(markets, authorisation), {
      unitOfWork: new TransactionalUnitOfWork([revisions]),
      revisions,
      sealer,
      audit,
    });

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
    sellerOrderId = ids.next<'SellerOrder'>();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the store name, phone and operating address, and audits the read per seller order', async () => {
    const approved = await addRevision(1, 'approved');

    const result = await useCase().execute(system, { sellerId, sellerOrderId });

    expect(result).toEqual({
      ok: true,
      value: {
        sellerId,
        storeName: 'Al Noor Grocer',
        phone: '+61 7 3000 0000',
        operatingAddress: { line1: '1 George St', suburb: 'Brisbane' },
      },
    });
    // The legal name, email, registered address and identifier stay behind.
    for (const kept of ['Al Noor Pty Ltd', 'shop@example.com', '9 Queen St', '51824753556']) {
      expect(JSON.stringify(result)).not.toContain(kept);
    }
    expect(audit.rows).toEqual([
      expect.objectContaining({
        action: 'sellers.pickup-details.read-for-carrier',
        targetId: sellerId,
        after: { revisionId: approved.id, sellerOrderId },
      }),
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('Al Noor');
  });

  it('answers seller.details-not-found, with no audit row, without an approved revision', async () => {
    await addRevision(1, 'pending');

    expect(await useCase().execute(system, { sellerId, sellerOrderId })).toEqual({
      ok: false,
      error: { code: 'seller.details-not-found' },
    });
    expect(audit.rows).toHaveLength(0);
  });

  it('refuses malformed ids before any read', async () => {
    expect(await useCase().execute(system, { sellerId: 'x', sellerOrderId: 7 })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'sellerId', code: 'format' },
          { path: 'sellerOrderId', code: 'format' },
        ],
      },
    });
  });

  it('serves the system actor only', async () => {
    await addRevision(1, 'approved');
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

    const result = await useCase().execute(admin, { sellerId, sellerOrderId });

    expect(!result.ok && result.error.code).toBe('access.denied');
    expect(audit.rows).toHaveLength(0);
  });

  it('returns nothing when the audit row is refused or the content hash does not match', async () => {
    await addRevision(1, 'approved');
    audit.refuse = true;
    expect(await useCase().execute(system, { sellerId, sellerOrderId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });

    sellerId = ids.next<'Seller'>();
    audit.refuse = false;
    await addRevision(1, 'approved', { contentHash: 'tampered' as never });
    expect(await useCase().execute(system, { sellerId, sellerOrderId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    expect(audit.rows).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'content-hash-mismatch', marketId: market.marketId }),
    );
  });
});
