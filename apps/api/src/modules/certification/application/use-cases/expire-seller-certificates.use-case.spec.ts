import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryOutbox, zonesOf } from '../../../../../test/support/certification-fakes';
import { RecordingAudit } from '../../../../../test/support/certification-review-fakes';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { TimeZoneId } from '../../domain/claim-types';
import { expiryBoundary } from '../../domain/validity';
import { MarketConfigExpiryPolicy } from '../../infrastructure/market-config-expiry-policy';
import type { SellerZonesSource } from '../ports/claim-facts.ports';
import type {
  ExpireWrite,
  ExpiryCandidate,
  ExpiryCursor,
  ExpiryNotice,
  ExpiryPage,
  SellerCertificateExpiryRepository,
  WarningWrite,
} from '../ports/expiry.repository';
import { EXPIRY_BATCH_SIZE, ExpireSellerCertificates } from './expire-seller-certificates.use-case';

// `certification.expiry-and-warnings` without a database (certification design 3.1, 8.6; AC 8,
// AC 9), on both Market fixtures: expiry in the seller's local time with one event and one audit
// row each, warnings once per threshold on the seller's local day, nothing for a type without
// expiry, nothing in the other Market, nothing new on a re-run, a lost race writes nothing, and
// paging past one batch. PostgreSQL behaviour: test/db/certification-expiry.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const ZONE = { AU: 'Australia/Brisbane', ZZ: 'Pacific/Auckland' } as const;
const EXPIRY = Temporal.PlainDate.from('2027-03-31');

interface Row {
  market: string;
  candidate: ExpiryCandidate;
  history: string[];
}

/** The expiry store in memory: per Market, the root, its approved submission and its markers. */
class MemoryExpiries implements SellerCertificateExpiryRepository {
  readonly rows: Row[] = [];
  readonly markers = new Set<string>();
  /** Runs once before the next lock: a concurrent writer moving the version in between. */
  beforeLock: (() => void) | null = null;

  add(market: MarketContext, candidate: ExpiryCandidate): void {
    this.rows.push({ market: market.marketId, candidate: { ...candidate }, history: [] });
  }

  #row(market: MarketContext, id: string): Row | undefined {
    return this.rows.find((r) => r.market === market.marketId && r.candidate.certificateId === id);
  }

  #warned(market: MarketContext, c: ExpiryCandidate): ExpiryCandidate {
    const warned = [30, 14, 1, 7, 2].filter((d) =>
      this.markers.has(`${market.marketId}|${c.submissionId}|${d}`),
    );
    return { ...c, warnedThresholds: warned };
  }

  /** Rows the statement returns but that are not candidates (no approved decision row). */
  readonly inconsistent = new Set<string>();
  /** Records whose write throws a fault that is not a lost race. */
  readonly failing = new Set<string>();

  candidates(
    market: MarketContext,
    horizon: Temporal.Instant,
    after: ExpiryCursor | null,
    limit: number,
  ): Promise<ExpiryPage> {
    const sel = (c: ExpiryCandidate) => c.storedBoundary!;
    const rows = this.rows
      .filter((r) => r.market === market.marketId && r.candidate.status === 'approved')
      .map((r) => r.candidate)
      .filter((c) => Temporal.Instant.compare(sel(c), horizon) < 0)
      .filter((c) => {
        if (after === null) return true;
        const cmp = Temporal.Instant.compare(sel(c), after.boundary);
        return cmp > 0 || (cmp === 0 && c.certificateId > after.certificateId);
      })
      .sort((a, b) => {
        const cmp = Temporal.Instant.compare(sel(a), sel(b));
        return cmp !== 0 ? cmp : a.certificateId < b.certificateId ? -1 : 1;
      })
      .slice(0, limit);
    const kept = rows
      .filter((c) => !this.inconsistent.has(c.certificateId))
      .map((c) => this.#warned(market, c));
    const last = rows.at(-1);
    return Promise.resolve({
      candidates: kept,
      rawCount: rows.length,
      last: last === undefined ? null : { boundary: sel(last), certificateId: last.certificateId },
      inconsistent: rows.length - kept.length,
    });
  }

  candidate(market: MarketContext, id: Id<'SellerCertification'>) {
    const row = this.#row(market, id);
    return Promise.resolve(row === undefined ? null : this.#warned(market, row.candidate));
  }

  lockVersion(market: MarketContext, id: Id<'SellerCertification'>, expected: number) {
    if (this.beforeLock !== null) {
      const hook = this.beforeLock;
      this.beforeLock = null;
      hook();
    }
    const row = this.#row(market, id);
    if (row === undefined || row.candidate.version !== expected) {
      throw new StaleAggregateError('seller-certification', id);
    }
    row.candidate = { ...row.candidate, version: expected + 1 };
    return Promise.resolve();
  }

  expire(market: MarketContext, write: ExpireWrite) {
    if (this.failing.has(write.certificateId)) throw new Error('disk on fire');
    const row = this.#row(market, write.certificateId)!;
    if (row.candidate.status !== 'approved') throw new Error('not approved');
    row.candidate = { ...row.candidate, status: 'expired' };
    row.history.push('approved->expired');
    return Promise.resolve();
  }

  recordWarning(market: MarketContext, write: WarningWrite) {
    const key = `${market.marketId}|${write.submissionId}|${write.thresholdDays}`;
    if (this.markers.has(key)) throw new Error('duplicate marker');
    this.markers.add(key);
    return Promise.resolve();
  }

  notice(): Promise<ExpiryNotice | null> {
    return Promise.resolve(null);
  }
}

/** A unit that rolls back on `err` and on a throw: the memory state is copied and restored. */
function unitOver(store: MemoryExpiries, outbox: MemoryOutbox, audit: RecordingAudit) {
  return {
    run: async <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
    ): Promise<Result<T, E>> => {
      const rows = store.rows.map((r) => ({
        ...r,
        candidate: { ...r.candidate },
        history: [...r.history],
      }));
      const markers = new Set(store.markers);
      const events = outbox.events.length;
      const entries = audit.entries.length;
      const restore = () => {
        store.rows.splice(0, store.rows.length, ...rows);
        store.markers.clear();
        for (const m of markers) store.markers.add(m);
        outbox.events.splice(events);
        audit.entries.splice(entries);
      };
      try {
        const result = await work();
        if (!result.ok) restore();
        return result;
      } catch (error) {
        restore();
        throw error;
      }
    },
    runOnce: noRunOnce,
  };
}

describe.each(['AU', 'ZZ'] as const)('expiry and warnings job, Market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const zone = ZONE[code] as TimeZoneId;
  const boundary = expiryBoundary(EXPIRY, zone);

  function rig(
    start: Temporal.Instant,
    zones?: SellerZonesSource,
    policies = new MarketConfigExpiryPolicy(markets),
  ) {
    const clock = new FixedClock(start);
    const ids = new SequenceIdGenerator(clock);
    const store = new MemoryExpiries();
    const outbox = new MemoryOutbox();
    const audit = new RecordingAudit();
    const answers: Record<string, { zone: string | null; addressZone: string | null }> = {};
    const add = (
      m: MarketContext = market,
      over: Partial<ExpiryCandidate> = {},
    ): ExpiryCandidate => {
      const sellerId = ids.next<'Seller'>();
      answers[sellerId] = { zone, addressZone: zone };
      const c: ExpiryCandidate = {
        certificateId: ids.next<'SellerCertification'>(),
        version: 4,
        sellerId,
        typeId: ids.next<'CertificationType'>(),
        submissionId: ids.next<'Submission'>(),
        typeRevisionId: ids.next<'CertificationTypeRevision'>(),
        status: 'approved',
        requiresExpiry: true,
        expiryDate: EXPIRY,
        zoneAtApproval: zone,
        storedBoundary: boundary,
        warnedThresholds: [],
        ...over,
      };
      store.add(m, c);
      return c;
    };
    const useCase = new ExpireSellerCertificates(gate, {
      unitOfWork: unitOver(store, outbox, audit),
      expiries: store,
      zones: zones ?? zonesOf(answers),
      policies,
      audit,
      outbox,
      clock,
      ids,
    });
    const run = async (m: MarketContext = market) => {
      const result = await useCase.execute(testCallContext(m, 'system'), {});
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
    return { clock, store, outbox, audit, add, run, useCase };
  }

  const types = (events: readonly PendingEvent[]) => events.map((e) => e.type);

  it('expires at the boundary in the seller local time: one event, one system audit row, a history row', async () => {
    const r = rig(boundary.subtract({ seconds: 1 }));
    const c = r.add();
    // A second before the boundary only the 1-day warning is due (30 and 14 were sent).
    r.store.markers.add(`${code}|${c.submissionId}|30`);
    r.store.markers.add(`${code}|${c.submissionId}|14`);
    r.store.markers.add(`${code}|${c.submissionId}|1`);
    expect((await r.run()).expired).toBe(0);

    r.clock.set(boundary);
    const out = await r.run();
    expect(out).toMatchObject({ expired: 1, warned: 0, contended: 0 });
    expect(r.store.rows[0]!.candidate.status).toBe('expired');
    expect(r.store.rows[0]!.history).toEqual(['approved->expired']);
    expect(types(r.outbox.events)).toEqual(['certification.seller-certification-expired.v1']);
    const event = r.outbox.events[0]!;
    expect(event.aggregateId).toBe(c.certificateId);
    expect(event.aggregateVersion).toBe(5);
    expect(event.payload).toEqual({
      sellerCertificationId: c.certificateId,
      sellerId: c.sellerId,
      submissionId: c.submissionId,
      typeId: c.typeId,
    });
    expect(r.audit.entries).toHaveLength(1);
    expect(r.audit.entries[0]).toMatchObject({
      action: 'certification.seller-certification.expired',
      targetId: c.certificateId,
    });
    expect(r.audit.entries[0]!.context.actor.kind).toBe('system');
  });

  it('creates nothing on a re-run', async () => {
    const r = rig(boundary.add({ minutes: 20 }));
    r.add();
    await r.run();
    const out = await r.run();
    expect(out).toMatchObject({ examined: 0, expired: 0, warned: 0 });
    expect(r.outbox.events).toHaveLength(1);
    expect(r.audit.entries).toHaveLength(1);
  });

  it('leaves the other Market alone', async () => {
    const r = rig(boundary.add({ hours: 24 }));
    const mine = r.add(market);
    const theirs = r.add(other);
    await r.run(market);
    const status = (id: string) =>
      r.store.rows.find((row) => row.candidate.certificateId === id)!.candidate.status;
    expect(status(mine.certificateId)).toBe('expired');
    expect(status(theirs.certificateId)).toBe('approved');
  });

  it('warns 30, 14 and 1 days ahead, each once, on the seller local day', async () => {
    const localStart = (day: string) =>
      Temporal.PlainDate.from(day).toZonedDateTime(zone).toInstant();
    const r = rig(localStart('2027-03-02').subtract({ seconds: 1 }));
    const c = r.add();
    expect((await r.run()).warned).toBe(0);
    const sent: number[] = [];
    for (const day of ['2027-03-02', '2027-03-18', '2027-03-31']) {
      r.clock.set(localStart(day));
      expect((await r.run()).warned).toBe(1);
      expect((await r.run()).warned).toBe(0);
      sent.push(r.outbox.events.at(-1)!.payload.thresholdDays as number);
    }
    expect(sent).toEqual([30, 14, 1]);
    expect(new Set(types(r.outbox.events))).toEqual(
      new Set(['certification.seller-certification-expiry-warning-due.v1']),
    );
    expect(r.outbox.events.map((e) => e.aggregateVersion)).toEqual([5, 6, 7]);
    expect(r.outbox.events[0]!.payload).toEqual({
      sellerCertificationId: c.certificateId,
      sellerId: c.sellerId,
      submissionId: c.submissionId,
      thresholdDays: 30,
    });
    // Warnings are not audited (design 11); the status stays approved.
    expect(r.audit.entries).toHaveLength(0);
    expect(r.store.rows[0]!.candidate.status).toBe('approved');
  });

  it('warns nobody for a type without expiry', async () => {
    const r = rig(boundary.add({ hours: 9600 }));
    r.add(market, { requiresExpiry: false });
    const out = await r.run();
    expect(out).toMatchObject({ expired: 0, warned: 0 });
    expect(r.outbox.events).toHaveLength(0);
  });

  it('writes nothing when another writer moved the version first (concurrent worker or review)', async () => {
    const r = rig(boundary.add({ minutes: 1 }));
    const c = r.add();
    r.store.beforeLock = () => {
      r.store.rows[0]!.candidate = { ...r.store.rows[0]!.candidate, version: c.version + 1 };
    };
    const out = await r.run();
    expect(out).toMatchObject({ expired: 0, contended: 1 });
    expect(r.store.rows[0]!.candidate.status).toBe('approved');
    expect(r.outbox.events).toHaveLength(0);
    expect(r.audit.entries).toHaveLength(0);
    // The next run picks it up.
    expect((await r.run()).expired).toBe(1);
  });

  it('two overlapping runs expire and warn each record once', async () => {
    const r = rig(boundary.add({ minutes: 1 }));
    r.add();
    const warnLater = r.add(market, {
      expiryDate: EXPIRY.add({ days: 10 }),
      storedBoundary: expiryBoundary(EXPIRY.add({ days: 10 }), zone),
    });
    const [a, b] = await Promise.all([r.run(), r.run()]);
    expect(a.expired + b.expired).toBe(1);
    expect(a.warned + b.warned).toBe(1);
    expect(types(r.outbox.events).sort()).toEqual([
      'certification.seller-certification-expired.v1',
      'certification.seller-certification-expiry-warning-due.v1',
    ]);
    expect(r.store.markers.has(`${code}|${warnLater.submissionId}|14`)).toBe(true);
  });

  it('moves the status no earlier than the claim when the zone read fails, and reports it', async () => {
    const failing: SellerZonesSource = { zonesOf: () => Promise.reject(new Error('down')) };
    const r = rig(boundary.subtract({ minutes: 1 }), failing);
    // The seller now chose a zone that would end earlier; without the read only the stored
    // boundary counts, so nothing expires a minute before it.
    r.add();
    let out = await r.run();
    expect(out).toMatchObject({ expired: 0, zoneReadsFailed: 1 });
    r.clock.set(boundary);
    out = await r.run();
    expect(out).toMatchObject({ expired: 1, zoneReadsFailed: 1 });
  });

  it('expires by an earlier current zone than the one at approval', async () => {
    // The seller now chose a zone east of the one at approval: its boundary is earlier, so the
    // status follows the claim (earliest of three), not the stored instant.
    const east = (code === 'AU' ? 'Pacific/Auckland' : 'Pacific/Kiritimati') as TimeZoneId;
    const sellerId = 'seller-east' as Id<'Seller'>;
    const r = rig(
      expiryBoundary(EXPIRY, east),
      zonesOf({ [sellerId]: { zone: east, addressZone: zone } }),
    );
    r.add(market, { sellerId });
    expect(Temporal.Instant.compare(expiryBoundary(EXPIRY, east), boundary)).toBeLessThan(0);
    expect((await r.run()).expired).toBe(1);
  });

  it('pages on raw rows: a full page with one inconsistent row still reads the next page', async () => {
    const r = rig(boundary.add({ hours: 24 }));
    const all = Array.from({ length: EXPIRY_BATCH_SIZE + 3 }, () => r.add());
    // One row of the first page is dropped as inconsistent (Mojtaba C1, Hassan L1).
    r.store.inconsistent.add(all[10]!.certificateId);
    const out = await r.run();
    expect(out).toMatchObject({
      examined: EXPIRY_BATCH_SIZE + 3,
      inconsistent: 1,
      expired: EXPIRY_BATCH_SIZE + 2,
    });
    const statusOf = (id: string) =>
      r.store.rows.find((row) => row.candidate.certificateId === id)!.candidate.status;
    // The rows of the second page were reached.
    for (const c of all.slice(EXPIRY_BATCH_SIZE)) expect(statusOf(c.certificateId)).toBe('expired');
    expect(statusOf(all[10]!.certificateId)).toBe('approved');
  });

  it('counts a record that fails for another reason, rolls it back and goes on', async () => {
    const r = rig(boundary.add({ minutes: 1 }));
    const bad = r.add();
    const good = r.add();
    r.store.failing.add(bad.certificateId);
    const out = await r.run();
    expect(out).toMatchObject({ expired: 1, failed: 1 });
    const statusOf = (id: string) =>
      r.store.rows.find((row) => row.candidate.certificateId === id)!.candidate.status;
    expect(statusOf(bad.certificateId)).toBe('approved');
    expect(statusOf(good.certificateId)).toBe('expired');
    expect(r.audit.entries).toHaveLength(1);
    expect(r.outbox.events).toHaveLength(1);
  });

  it('pages past one batch', async () => {
    const r = rig(boundary.add({ hours: 24 }));
    for (let i = 0; i < EXPIRY_BATCH_SIZE + 5; i += 1) r.add();
    const out = await r.run();
    expect(out).toMatchObject({ examined: EXPIRY_BATCH_SIZE + 5, expired: EXPIRY_BATCH_SIZE + 5 });
    expect(r.outbox.events).toHaveLength(EXPIRY_BATCH_SIZE + 5);
  });

  it('refuses any caller but the system actor', async () => {
    const r = rig(boundary);
    const result = await r.useCase.execute(testCallContext(market, 'anonymous'), {});
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
