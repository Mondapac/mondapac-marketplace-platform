import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
} from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerCultureState } from '../../domain/seller-culture';
import type { CultureDirectory, CultureInfo } from '../ports/culture-directory';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerCertificateDirectory } from '../ports/seller-certificate-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import { CultureApprovedMembers } from './culture-approved-members.use-case';
import { CultureDemoteApprovals, DEMOTE_BATCH } from './culture-demote-approvals.use-case';
import { CultureDemoteApprovalsSystem } from './culture-demote-approvals-system.use-case';
import { RecheckCultureCertificates } from './recheck-culture-certificates.use-case';
import {
  ISSUER_SELLERS_PAGE,
  RecheckCulturesOfIssuer,
} from './recheck-cultures-of-issuer.use-case';
import { SellerApprovedCultures } from './seller-approved-cultures.use-case';
import { SellerApprovedCulturesSystem } from './seller-approved-cultures-system.use-case';
import { ApplySignupCultures } from './apply-signup-cultures.use-case';
import { SeedSellerCultures } from './seed-seller-cultures.use-case';
import { SellerCultureDecide } from './seller-culture-decide.use-case';
import { SellerCulturesAdminList } from './seller-cultures-admin-list.use-case';
import { SellerCulturesOwn } from './seller-cultures-own.use-case';
import { SellerCulturesRequest } from './seller-cultures-request.use-case';

// A seller's culture memberships (multi-culture package 2; ADR-0047 decision 3, ADR-0048) in
// memory, on both Market fixtures. The table, its CHECKs, grants and the concurrency cases are
// covered by test/db/seller-cultures.db-spec.ts.

const START = Temporal.Instant.from('2026-11-12T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const key = (market: MarketContext, sellerId: string, cultureId: string): string =>
  `${market.marketId}|${sellerId}|${cultureId}`;

class Rows implements SellerCultureRepository {
  readonly rows = new Map<string, SellerCultureState>();
  readonly sellers = new Set<string>();
  /** Makes the next `transition` lose, as if another unit won the race. */
  loseNextTransition = false;
  /** Makes the next N demotions (transitions out of `approved`) throw, as a database fault would. */
  failDemotions = 0;

  forSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      [...this.rows]
        .filter(([k]) => k.startsWith(`${market.marketId}|${sellerId}|`))
        .map(([, v]) => v),
    );
  }

  among(market: MarketContext, sellerId: Id<'Seller'>, cultureIds: readonly Id<'Culture'>[]) {
    const found = new Map<Id<'Culture'>, SellerCultureState>();
    for (const id of cultureIds) {
      const row = this.rows.get(key(market, sellerId, id));
      if (row !== undefined) found.set(id, row);
    }
    return Promise.resolve(found as ReadonlyMap<Id<'Culture'>, SellerCultureState>);
  }

  hasApproved(market: MarketContext, cultureId: Id<'Culture'>) {
    return Promise.resolve(
      [...this.rows].some(
        ([k, v]) =>
          k.startsWith(`${market.marketId}|`) &&
          v.cultureId === cultureId &&
          v.status === 'approved',
      ),
    );
  }

  approvedIn(market: MarketContext, cultureId: Id<'Culture'>, limit: number) {
    return Promise.resolve(
      [...this.rows]
        .filter(
          ([k, v]) =>
            k.startsWith(`${market.marketId}|`) &&
            v.cultureId === cultureId &&
            v.status === 'approved',
        )
        .map(([, v]) => v)
        .slice(0, limit),
    );
  }

  approvedForSellers(m: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const answer = new Map<Id<'Seller'>, Id<'Culture'>[]>();
    for (const [k, v] of this.rows) {
      if (!k.startsWith(`${m.marketId}|`) || v.status !== 'approved') continue;
      if (!sellerIds.includes(v.sellerId)) continue;
      answer.set(v.sellerId, [...(answer.get(v.sellerId) ?? []), v.cultureId]);
    }
    return Promise.resolve(answer as ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>);
  }
  sellerIdsWithoutCultures(market: MarketContext, limit: number, after?: Id<'Seller'>) {
    return Promise.resolve(
      [...this.sellers]
        .filter((k) => k.startsWith(`${market.marketId}|`))
        .map((k) => k.split('|')[1] as Id<'Seller'>)
        .filter(
          (id) => ![...this.rows.keys()].some((k) => k.startsWith(`${market.marketId}|${id}|`)),
        )
        .sort()
        .filter((id) => after === undefined || id > after)
        .slice(0, limit),
    );
  }

  insert(market: MarketContext, state: SellerCultureState) {
    const k = key(market, state.sellerId, state.cultureId);
    if (this.rows.has(k)) return Promise.resolve(false);
    this.rows.set(k, state);
    return Promise.resolve(true);
  }

  transition(
    market: MarketContext,
    state: SellerCultureState,
    expected: { version: number; status: string },
  ) {
    const k = key(market, state.sellerId, state.cultureId);
    const current = this.rows.get(k);
    if (expected.status === 'approved' && this.failDemotions > 0) {
      this.failDemotions -= 1;
      throw new Error('database fault');
    }
    if (this.loseNextTransition) {
      this.loseNextTransition = false;
      return Promise.resolve(false);
    }
    if (current?.version !== expected.version || current.status !== expected.status) {
      return Promise.resolve(false);
    }
    this.rows.set(k, state);
    return Promise.resolve(true);
  }
}

function setUp(code: string) {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const rows = new Rows();
  const audits: AuditEntry[] = [];
  const events: PendingEvent[] = [];
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox: OutboxWriter = {
    append: (_c, appended) => {
      events.push(...appended);
      return Promise.resolve();
    },
  };
  const permitted = { value: true };
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        permitted.value ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const gate = createUseCaseGate(markets, authorisation);
  // Each unit opened, read-only or not (package 3a: one unit per demotion batch).
  const units: string[] = [];
  const unitOfWork: UnitOfWork = {
    run: (_m, work, options) => {
      units.push(options?.readOnly === true ? 'read' : 'write');
      return work();
    },
    runOnce: noRunOnce,
  };

  const cultures = new Map<Id<'Culture'>, CultureInfo>();
  const directory = { down: false, asks: 0, afterRead: null as null | (() => void) };
  const cultureDirectory: CultureDirectory = {
    byIds: (_c, wanted) => {
      directory.asks += 1;
      if (directory.down) return Promise.resolve(err({ code: 'culture-directory.unavailable' }));
      const answer = ok(
        new Map(wanted.filter((id) => cultures.has(id)).map((id) => [id, cultures.get(id)!])),
      );
      // A change made by an admin right after this read (the stale read of security review M1).
      const hook = directory.afterRead;
      directory.afterRead = null;
      hook?.();
      return Promise.resolve(answer);
    },
    active: () => {
      if (directory.down) return Promise.resolve(err({ code: 'culture-directory.unavailable' }));
      const answer = ok([...cultures.values()].filter((c) => c.status === 'active'));
      const hook = directory.afterRead;
      directory.afterRead = null;
      hook?.();
      return Promise.resolve(answer);
    },
  };
  const certificates = {
    held: new Set<string>(),
    down: false,
    /** Per issuer, the sellers holding an approved certificate naming it. */
    issuers: new Map<string, Id<'Seller'>[]>(),
    pages: [] as { issuerId: string; after: Id<'Seller'> | null; limit: number }[],
  };
  const certificateDirectory: SellerCertificateDirectory = {
    validTypeCodes: (_c, _s, typeCodes) =>
      certificates.down
        ? Promise.resolve(err({ code: 'seller-certificate-directory.unavailable' }))
        : Promise.resolve(
            ok(
              new Set(
                [...certificates.held].filter((t) => typeCodes.includes(t)),
              ) as ReadonlySet<string>,
            ),
          ),
    sellersOfIssuer: (_c, issuerId, after, limit) => {
      certificates.pages.push({ issuerId, after, limit });
      if (certificates.down) {
        return Promise.resolve(err({ code: 'seller-certificate-directory.unavailable' }));
      }
      const all = [...(certificates.issuers.get(issuerId) ?? [])].sort();
      return Promise.resolve(
        ok(
          all.filter((s) => after === null || s > after).slice(0, limit) as readonly Id<'Seller'>[],
        ),
      );
    },
  };
  const files = {
    existingIds: (m: MarketContext, sellerIds: readonly Id<'Seller'>[]) =>
      Promise.resolve(new Set(sellerIds.filter((id) => rows.sellers.has(`${m.marketId}|${id}`)))),
  } as unknown as SellerFileRepository;

  const addCulture = (codeOf: string, extra: Partial<CultureInfo> = {}): CultureInfo => {
    const id = ids.next<'Culture'>();
    const info: CultureInfo = {
      id,
      code: codeOf,
      status: 'active',
      requiredCertificationType: null,
      names: { en: codeOf },
      ...extra,
    };
    cultures.set(id, info);
    return info;
  };
  const addSeller = (
    state: 'pending' | 'approved' | 'rejected' | 'suspended' | null = 'approved',
  ): Id<'Seller'> => {
    const id = ids.next<'Seller'>();
    if (state !== null) access.set(id, state);
    rows.sellers.add(`${market.marketId}|${id}`);
    return id;
  };
  const access = new Map<Id<'Seller'>, 'pending' | 'approved' | 'rejected' | 'suspended'>();
  const accessReader = {
    accessOfMany: (_c: CallContext, ids: readonly Id<'Seller'>[]) =>
      Promise.resolve(
        new Map(ids.filter((id) => access.has(id)).map((id) => [id, access.get(id)!])),
      ),
  } as unknown as SellerAccessReader;
  const base = { unitOfWork, files, sellerCultures: rows, cultureDirectory, outbox, clock };
  const applySignup = new ApplySignupCultures(gate, { ...base, audit });
  return {
    market,
    ids,
    rows,
    audits,
    events,
    cultures,
    directory,
    certificates,
    permitted,
    addCulture,
    addSeller,
    system: testCallContext(market, 'system'),
    anonymous: testCallContext(market, 'anonymous'),
    own: new SellerCulturesOwn(gate, { unitOfWork, sellerCultures: rows, cultureDirectory }),
    request: new SellerCulturesRequest(gate, base),
    adminList: new SellerCulturesAdminList(gate, {
      unitOfWork,
      files,
      sellerCultures: rows,
      cultureDirectory,
      certificateDirectory,
    }),
    decide: new SellerCultureDecide(gate, { ...base, certificateDirectory }),
    applySignup,
    seed: new SeedSellerCultures(gate, {
      unitOfWork,
      sellerCultures: rows,
      accessReader,
      applySignup,
    }),
    access,
    approvedMembers: new CultureApprovedMembers(gate, { unitOfWork, sellerCultures: rows }),
    demoteApprovals: new CultureDemoteApprovals(gate, {
      unitOfWork,
      sellerCultures: rows,
      outbox,
      clock,
    }),
    demoteApprovalsSystem: new CultureDemoteApprovalsSystem(gate, {
      unitOfWork,
      sellerCultures: rows,
      outbox,
      clock,
    }),
    recheck: new RecheckCultureCertificates(gate, {
      unitOfWork,
      sellerCultures: rows,
      cultureDirectory,
      certificateDirectory,
      outbox,
      clock,
    }),
    recheckIssuer: new RecheckCulturesOfIssuer(gate, {
      unitOfWork,
      sellerCultures: rows,
      cultureDirectory,
      certificateDirectory,
      outbox,
      clock,
    }),
    approvedCultures: new SellerApprovedCultures(gate, { unitOfWork, sellerCultures: rows }),
    approvedCulturesSystem: new SellerApprovedCulturesSystem(gate, {
      unitOfWork,
      sellerCultures: rows,
    }),
    units,
    admin: (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      ),
    seller: (sellerId: Id<'Seller'>): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      ),
  };
}
type Setup = ReturnType<typeof setUp>;

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const statusEvents = (t: Setup) =>
  t.events.map((e) => ({
    type: e.type,
    version: e.aggregateVersion,
    status: (e.payload as { status: string }).status,
  }));

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'kosher'],
])('seller cultures in %s', (code, certType) => {
  /** A seller with a file, a plain culture and a culture that needs a certificate. */
  function withSeller() {
    const t = setUp(code);
    const sellerId = t.addSeller();
    const plain = t.addCulture('plain');
    const certified = t.addCulture('certified', { requiredCertificationType: certType });
    return { t, sellerId, plain, certified };
  }

  describe('request', () => {
    it('requests several cultures at once, writes one event each, and checks no certificate yet', async () => {
      const { t, sellerId, plain, certified } = withSeller();
      const result = await t.request.execute(t.seller(sellerId), {
        body: { cultureIds: [plain.id, certified.id] },
      });
      expect(
        result.ok && result.value.cultures.map((c) => [c.cultureCode, c.status, c.outcome]),
      ).toEqual([
        ['plain', 'requested', 'requested'],
        ['certified', 'requested', 'requested'],
      ]);
      expect(result.ok && result.value.cultures[1]).toMatchObject({
        requiredCertificationType: certType,
        needsCertificate: true,
      });
      expect(result.ok && result.value.cultures[0]!.needsCertificate).toBe(false);
      expect(statusEvents(t)).toEqual([
        { type: 'sellers.seller-culture-status-changed.v1', version: 1, status: 'requested' },
        { type: 'sellers.seller-culture-status-changed.v1', version: 1, status: 'requested' },
      ]);
    });

    it('refuses a culture that is not Active, whole, with its path', async () => {
      const { t, sellerId, plain } = withSeller();
      const draft = t.addCulture('draft', { status: 'draft' });
      const result = await t.request.execute(t.seller(sellerId), {
        body: { cultureIds: [plain.id, draft.id, t.ids.next<'Culture'>()] },
      });
      expect(result).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'cultureIds.1', code: 'not-active' },
            { path: 'cultureIds.2', code: 'not-active' },
          ],
        }),
      );
      expect(t.rows.rows.size).toBe(0);
      expect(t.events).toHaveLength(0);
    });

    it('fails closed when the culture directory is down, and refuses a malformed body', async () => {
      const { t, sellerId, plain } = withSeller();
      t.directory.down = true;
      expect(
        await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } }),
      ).toEqual(err({ code: 'sellers.unavailable' }));
      t.directory.down = false;
      expect(
        await t.request.execute(t.seller(sellerId), { body: { cultureIds: [] } }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('leaves a waiting or approved membership alone, and opens a rejected one again', async () => {
      const { t, sellerId, plain } = withSeller();
      const context = t.seller(sellerId);
      await t.request.execute(context, { body: { cultureIds: [plain.id] } });
      const repeat = await t.request.execute(context, { body: { cultureIds: [plain.id] } });
      expect(repeat.ok && repeat.value.cultures[0]!.outcome).toBe('unchanged');
      expect(t.events).toHaveLength(1);

      await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: plain.id,
        body: { decision: 'reject', reason: 'Not a match' },
      });
      const again = await t.request.execute(context, { body: { cultureIds: [plain.id] } });
      expect(again.ok && again.value.cultures[0]).toMatchObject({
        status: 'requested',
        outcome: 'requested-again',
        reason: null,
        version: 3,
      });
      expect(statusEvents(t).map((e) => [e.version, e.status])).toEqual([
        [1, 'requested'],
        [2, 'rejected'],
        [3, 'requested'],
      ]);
    });

    it('answers the stored state when another request wins the race, with no second event', async () => {
      const { t, sellerId, plain } = withSeller();
      const context = t.seller(sellerId);
      const realInsert = t.rows.insert.bind(t.rows);
      t.rows.insert = async (market, state) => {
        // The other request commits its row first.
        await realInsert(market, { ...state, requestedAt: START });
        return false;
      };
      const result = await t.request.execute(context, { body: { cultureIds: [plain.id] } });
      expect(result.ok && result.value.cultures[0]).toMatchObject({
        status: 'requested',
        outcome: 'unchanged',
      });
      expect(t.events).toHaveLength(0);
    });

    it('is the acting seller only: no seller, an admin, or a seller without a file is refused', async () => {
      const { t, plain } = withSeller();
      expect(await t.request.execute(t.admin(), { body: { cultureIds: [plain.id] } })).toEqual(
        err({ code: 'access.denied' }),
      );
      const stranger = t.ids.next<'Seller'>();
      expect(
        await t.request.execute(t.seller(stranger), { body: { cultureIds: [plain.id] } }),
      ).toEqual(err({ code: 'file.not-found' }));
    });
  });

  describe('own list', () => {
    it("lists only the acting seller's cultures, with names and the reason", async () => {
      const { t, sellerId, plain } = withSeller();
      const other = t.addSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } });
      await t.request.execute(t.seller(other), { body: { cultureIds: [plain.id] } });
      await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: plain.id,
        body: { decision: 'reject', reason: 'Wrong standard' },
      });
      const mine = await t.own.execute(t.seller(sellerId), {});
      expect(mine.ok && mine.value.cultures).toMatchObject([
        {
          cultureCode: 'plain',
          status: 'rejected',
          reason: 'Wrong standard',
          names: { en: 'plain' },
        },
      ]);
      const theirs = await t.own.execute(t.seller(other), {});
      expect(theirs.ok && theirs.value.cultures).toMatchObject([
        { status: 'requested', reason: null },
      ]);
      expect(await t.own.execute(t.admin(), {})).toEqual(err({ code: 'access.denied' }));
      t.directory.down = true;
      expect(await t.own.execute(t.seller(sellerId), {})).toEqual(
        err({ code: 'sellers.unavailable' }),
      );
    });
  });

  describe('decide', () => {
    it('approves a culture with no certificate rule, and writes the event', async () => {
      const { t, sellerId, plain } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } });
      const admin = t.admin();
      const done = await t.decide.execute(admin, {
        sellerId,
        cultureId: plain.id,
        body: { decision: 'approve' },
      });
      expect(done.ok && done.value.culture).toMatchObject({
        status: 'approved',
        version: 2,
        decidedAt: START.toString(),
      });
      expect(statusEvents(t).at(-1)).toEqual({
        type: 'sellers.seller-culture-status-changed.v1',
        version: 2,
        status: 'approved',
      });
      const stored = [...t.rows.rows.values()][0]!;
      expect(stored.decidedBy).toBe(
        admin.actor.kind === 'authenticated' ? admin.actor.accountId : '',
      );
    });

    it('needs the seller’s valid certificate to approve a certified culture, and fails closed', async () => {
      const { t, sellerId, certified } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [certified.id] } });
      const approve = { sellerId, cultureId: certified.id, body: { decision: 'approve' } };

      expect(await t.decide.execute(t.admin(), approve)).toEqual(
        err({ code: 'culture.certificate-required', requiredCertificationType: certType }),
      );
      t.certificates.held.add('some-other-type');
      expect(await t.decide.execute(t.admin(), approve)).toMatchObject({
        error: { code: 'culture.certificate-required' },
      });
      t.certificates.down = true;
      t.certificates.held.add(certType);
      expect(await t.decide.execute(t.admin(), approve)).toEqual(
        err({ code: 'culture.certificate-unavailable' }),
      );
      expect([...t.rows.rows.values()][0]!.status).toBe('requested');

      t.certificates.down = false;
      const done = await t.decide.execute(t.admin(), approve);
      expect(done.ok && done.value.culture.status).toBe('approved');
    });

    it('lets a reviewer reject a certified culture without a certificate, but only with a reason', async () => {
      const { t, sellerId, certified } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [certified.id] } });
      const bare = await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: certified.id,
        body: { decision: 'reject' },
      });
      expect(bare).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reason', code: 'required' }] }),
      );
      const done = await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: certified.id,
        body: { decision: 'reject', reason: 'Sells outside the standard' },
      });
      expect(done.ok && done.value.culture).toMatchObject({
        status: 'rejected',
        reason: 'Sells outside the standard',
      });
    });

    it('decides once: a second decision, and a decision that loses the race, are not-requested', async () => {
      const { t, sellerId, plain } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } });
      const approve = { sellerId, cultureId: plain.id, body: { decision: 'approve' } };

      t.rows.loseNextTransition = true;
      expect(await t.decide.execute(t.admin(), approve)).toEqual(
        err({ code: 'culture.not-requested' }),
      );
      expect(t.events).toHaveLength(1);

      expect((await t.decide.execute(t.admin(), approve)).ok).toBe(true);
      expect(await t.decide.execute(t.admin(), approve)).toEqual(
        err({ code: 'culture.not-requested' }),
      );
      expect(t.events).toHaveLength(2);
    });

    it('refuses an approval for a culture that is no longer Active', async () => {
      const { t, sellerId, plain } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } });
      t.cultures.set(plain.id, { ...plain, status: 'inactive' });
      expect(
        await t.decide.execute(t.admin(), {
          sellerId,
          cultureId: plain.id,
          body: { decision: 'approve' },
        }),
      ).toEqual(err({ code: 'culture.not-active' }));
    });

    it('answers not found for an unknown seller, an unknown membership and a seller without the key', async () => {
      const { t, sellerId, plain } = withSeller();
      const body = { decision: 'approve' };
      expect(
        await t.decide.execute(t.admin(), {
          sellerId: t.ids.next<'Seller'>(),
          cultureId: plain.id,
          body,
        }),
      ).toEqual(err({ code: 'file.not-found' }));
      expect(await t.decide.execute(t.admin(), { sellerId, cultureId: plain.id, body })).toEqual(
        err({ code: 'culture.membership-not-found' }),
      );
      t.permitted.value = false;
      expect(await t.decide.execute(t.admin(), { sellerId, cultureId: plain.id, body })).toEqual(
        err({ code: 'access.denied' }),
      );
      // A seller session never decides, even if the gate would let it through.
      t.permitted.value = true;
      expect(
        await t.decide.execute(t.seller(sellerId), { sellerId, cultureId: plain.id, body }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('admin list', () => {
    it('shows the certificate state of a waiting certified request, so the screen can say what is needed', async () => {
      const { t, sellerId, plain, certified } = withSeller();
      await t.request.execute(t.seller(sellerId), {
        body: { cultureIds: [plain.id, certified.id] },
      });

      const missing = await t.adminList.execute(t.admin(), { sellerId });
      const rowsOf = (
        cultures: readonly {
          cultureCode: string;
          certificate?: string;
          needsCertificate: boolean;
        }[],
      ) =>
        cultures
          .map((c) => [c.cultureCode, c.certificate, c.needsCertificate])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(missing.ok && rowsOf(missing.value.cultures)).toEqual([
        ['certified', 'missing', true],
        ['plain', 'not-required', false],
      ]);

      t.certificates.held.add(certType);
      const held = await t.adminList.execute(t.admin(), { sellerId });
      expect(
        held.ok && held.value.cultures.find((c) => c.cultureCode === 'certified'),
      ).toMatchObject({
        certificate: 'held',
        needsCertificate: false,
      });

      t.certificates.down = true;
      const unknown = await t.adminList.execute(t.admin(), { sellerId });
      expect(
        unknown.ok && unknown.value.cultures.find((c) => c.cultureCode === 'certified'),
      ).toMatchObject({
        certificate: 'unavailable',
      });
      expect(await t.adminList.execute(t.admin(), { sellerId: t.ids.next<'Seller'>() })).toEqual(
        err({ code: 'file.not-found' }),
      );
      expect(await t.adminList.execute(t.seller(sellerId), { sellerId })).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  describe('signup', () => {
    it('with no selection is universal: approved where no certificate is required, requested where one is', async () => {
      const { t, sellerId, plain, certified } = withSeller();
      t.addCulture('inactive', { status: 'inactive' });
      const done = await t.applySignup.execute(t.system, { sellerId });
      expect(done).toEqual(ok({ approved: 1, requested: 1, unchanged: 0 }));
      const states = [...t.rows.rows.values()];
      expect(states.find((s) => s.cultureId === plain.id)).toMatchObject({
        status: 'approved',
        requestedBy: null,
        decidedBy: null,
        version: 1,
      });
      expect(states.find((s) => s.cultureId === certified.id)).toMatchObject({
        status: 'requested',
      });
      expect(states).toHaveLength(2);
      expect(t.audits).toHaveLength(1);
      expect(t.audits[0]).toMatchObject({
        action: 'sellers.cultures.attached-at-signup',
        targetId: sellerId,
        after: { approvedCultureIds: [plain.id], requestedCultureIds: [certified.id] },
      });
      expect(
        statusEvents(t)
          .map((e) => e.status)
          .sort(),
      ).toEqual(['approved', 'requested']);
    });

    it('never approves a certified culture, however it is selected', async () => {
      const { t, sellerId } = withSeller();
      t.certificates.held.add(certType);
      await t.applySignup.execute(t.system, { sellerId, cultures: ['certified'] });
      expect([...t.rows.rows.values()].map((s) => s.status)).toEqual(['requested']);
    });

    it('takes an explicit list, and refuses an empty, unknown or inactive one with a clear code', async () => {
      const { t, sellerId } = withSeller();
      t.addCulture('inactive', { status: 'inactive' });
      expect(await t.applySignup.execute(t.system, { sellerId, cultures: [] })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'cultures', code: 'empty' }] }),
      );
      expect(
        await t.applySignup.execute(t.system, {
          sellerId,
          cultures: ['plain', 'nope', 'inactive'],
        }),
      ).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'cultures.1', code: 'unknown-or-inactive' },
            { path: 'cultures.2', code: 'unknown-or-inactive' },
          ],
        }),
      );
      expect(t.rows.rows.size).toBe(0);
      expect(await t.applySignup.execute(t.system, { sellerId, cultures: ['plain'] })).toEqual(
        ok({ approved: 1, requested: 0, unchanged: 0 }),
      );
    });

    it('is safe to repeat, retries when the file or directory is missing, and attaches nothing with no Active culture', async () => {
      const { t, sellerId } = withSeller();
      await t.applySignup.execute(t.system, { sellerId });
      expect(await t.applySignup.execute(t.system, { sellerId })).toEqual(
        ok({ approved: 0, requested: 0, unchanged: 2 }),
      );
      expect(t.events).toHaveLength(2);
      expect(await t.applySignup.execute(t.system, { sellerId: t.ids.next<'Seller'>() })).toEqual(
        err({ code: 'file.not-found' }),
      );
      t.directory.down = true;
      expect(await t.applySignup.execute(t.system, { sellerId })).toEqual(
        err({ code: 'sellers.unavailable' }),
      );

      const empty = setUp(code);
      const lonely = empty.addSeller();
      expect(await empty.applySignup.execute(empty.system, { sellerId: lonely })).toEqual(
        ok({ approved: 0, requested: 0, unchanged: 0 }),
      );
    });

    it('is system only', async () => {
      const { t, sellerId } = withSeller();
      expect(await t.applySignup.execute(t.seller(sellerId), { sellerId })).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await t.applySignup.execute(t.admin(), { sellerId })).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  describe('stale reads (security review M1)', () => {
    /** The culture becomes certified right after the first read of it. */
    const certifyAfterFirstRead = (t: Setup, culture: CultureInfo) => {
      t.directory.afterRead = () =>
        void t.cultures.set(culture.id, { ...culture, requiredCertificationType: certType });
    };

    it('takes a signup approval back when the culture became certified after it was read', async () => {
      const { t, sellerId, plain } = withSeller();
      certifyAfterFirstRead(t, plain);
      const done = await t.applySignup.execute(t.system, { sellerId });
      // Both cultures now need a certificate: nothing stays approved, and the event trail shows it.
      expect(done).toEqual(ok({ approved: 0, requested: 2, unchanged: 0 }));
      const states = [...t.rows.rows.values()];
      expect(states.map((s) => s.status)).toEqual(['requested', 'requested']);
      const demoted = states.find((s) => s.cultureId === plain.id)!;
      expect(demoted).toMatchObject({ version: 2, decidedBy: null, decidedAt: null, reason: null });
      expect(statusEvents(t).filter((e) => e.version === 2)).toEqual([
        { type: 'sellers.seller-culture-status-changed.v1', version: 2, status: 'requested' },
      ]);
    });

    it('takes a signup approval back when the culture went inactive, or cannot be read again', async () => {
      const first = withSeller();
      first.t.directory.afterRead = () =>
        void first.t.cultures.set(first.plain.id, { ...first.plain, status: 'inactive' });
      await first.t.applySignup.execute(first.t.system, { sellerId: first.sellerId });
      expect([...first.t.rows.rows.values()].map((s) => s.status)).toEqual([
        'requested',
        'requested',
      ]);

      const second = withSeller();
      // The directory answers the first read (active list) and then goes down for the guard.
      second.t.directory.afterRead = () => void (second.t.directory.down = true);
      expect(
        await second.t.applySignup.execute(second.t.system, { sellerId: second.sellerId }),
      ).toEqual(err({ code: 'sellers.unavailable' }));
      expect([...second.t.rows.rows.values()].map((s) => s.status)).toEqual([
        'requested',
        'requested',
      ]);
    });

    it('takes a reviewer approval back when the required type changed after the certificate was checked', async () => {
      const { t, sellerId, certified } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [certified.id] } });
      t.certificates.held.add(certType);
      // The decision read sees `certType`; the culture then moves to another type.
      t.directory.afterRead = () =>
        void t.cultures.set(certified.id, {
          ...certified,
          requiredCertificationType: 'other-type',
        });
      const done = await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: certified.id,
        body: { decision: 'approve' },
      });
      expect(done).toEqual(err({ code: 'culture.changed' }));
      expect([...t.rows.rows.values()][0]).toMatchObject({ status: 'requested', version: 3 });
    });

    it('retries a failed take-back once, and answers unavailable when it fails twice', async () => {
      const once = withSeller();
      once.t.directory.afterRead = () =>
        void once.t.cultures.set(once.plain.id, { ...once.plain, status: 'inactive' });
      once.t.rows.failDemotions = 1;
      expect(
        await once.t.applySignup.execute(once.t.system, { sellerId: once.sellerId }),
      ).toMatchObject({ ok: true });
      expect([...once.t.rows.rows.values()].map((s) => s.status)).toEqual([
        'requested',
        'requested',
      ]);

      const twice = withSeller();
      twice.t.directory.afterRead = () =>
        void twice.t.cultures.set(twice.plain.id, { ...twice.plain, status: 'inactive' });
      twice.t.rows.failDemotions = 2;
      expect(
        await twice.t.applySignup.execute(twice.t.system, { sellerId: twice.sellerId }),
      ).toEqual(err({ code: 'sellers.unavailable' }));

      const decided = withSeller();
      await decided.t.request.execute(decided.t.seller(decided.sellerId), {
        body: { cultureIds: [decided.certified.id] },
      });
      decided.t.certificates.held.add(certType);
      decided.t.directory.afterRead = () =>
        void decided.t.cultures.set(decided.certified.id, {
          ...decided.certified,
          requiredCertificationType: 'other-type',
        });
      decided.t.rows.failDemotions = 2;
      expect(
        await decided.t.decide.execute(decided.t.admin(), {
          sellerId: decided.sellerId,
          cultureId: decided.certified.id,
          body: { decision: 'approve' },
        }),
      ).toEqual(err({ code: 'sellers.unavailable' }));
    });

    it('takes every approval of a culture back for catalog, one event each', async () => {
      const { t, sellerId, plain } = withSeller();
      await t.applySignup.execute(t.system, { sellerId });
      expect([...t.rows.rows.values()].filter((s) => s.cultureId === plain.id)[0]?.status).toBe(
        'approved',
      );
      const before = t.events.length;

      expect(await t.demoteApprovals.execute(t.anonymous, { cultureId: plain.id })).toEqual(
        ok({ demoted: 1, remaining: false }),
      );
      expect(await t.approvedMembers.execute(t.anonymous, { cultureId: plain.id })).toEqual(
        ok(false),
      );
      expect(t.events.length).toBe(before + 1);
      expect(await t.demoteApprovals.execute(t.anonymous, { cultureId: plain.id })).toEqual(
        ok({ demoted: 0, remaining: false }),
      );
      expect(await t.demoteApprovals.execute(t.anonymous, { cultureId: 'nope' })).toMatchObject({
        ok: false,
      });
    });

    it('answers whether anyone is approved in a culture, for catalog', async () => {
      const { t, sellerId, plain } = withSeller();
      await t.request.execute(t.seller(sellerId), { body: { cultureIds: [plain.id] } });
      expect(await t.approvedMembers.execute(t.anonymous, { cultureId: plain.id })).toEqual(
        ok(false),
      );
      await t.decide.execute(t.admin(), {
        sellerId,
        cultureId: plain.id,
        body: { decision: 'approve' },
      });
      expect(await t.approvedMembers.execute(t.anonymous, { cultureId: plain.id })).toEqual(
        ok(true),
      );
      expect(await t.approvedMembers.execute(t.anonymous, { cultureId: 'nope' })).toMatchObject({
        ok: false,
      });
    });
  });

  describe('package 3a: visibility reads, certificate re-check (M2), batches and N1', () => {
    /** A seller approved in the plain and the certified culture, with a valid certificate. */
    async function approvedInBoth() {
      const w = withSeller();
      const { t, sellerId, certified } = w;
      await t.applySignup.execute(t.system, { sellerId });
      t.certificates.held.add(certType);
      expect(
        await t.decide.execute(t.admin(), {
          sellerId,
          cultureId: certified.id,
          body: { decision: 'approve' },
        }),
      ).toMatchObject({ ok: true });
      return w;
    }
    const statusOf = (t: Setup, sellerId: Id<'Seller'>, cultureId: Id<'Culture'>) =>
      [...t.rows.rows.values()].find((s) => s.sellerId === sellerId && s.cultureId === cultureId)
        ?.status;

    it('answers the approved cultures per seller, the same for a request actor and the system', async () => {
      const { t, sellerId, plain, certified } = await approvedInBoth();
      const other = t.addSeller();
      const expected = new Map([[sellerId, [plain.id, certified.id].sort()]]);
      const sorted = (r: Awaited<ReturnType<typeof t.approvedCultures.execute>>) =>
        r.ok ? new Map([...r.value].map(([k, v]) => [k, [...v].sort()])) : r;

      expect(
        sorted(await t.approvedCultures.execute(t.anonymous, { sellerIds: [sellerId, other] })),
      ).toEqual(expected);
      expect(
        sorted(await t.approvedCulturesSystem.execute(t.system, { sellerIds: [sellerId] })),
      ).toEqual(expected);
      // The anonymous rule never admits the system actor, and the system rule no request actor.
      expect(await t.approvedCultures.execute(t.system, { sellerIds: [sellerId] })).toMatchObject({
        ok: false,
      });
      expect(
        await t.approvedCulturesSystem.execute(t.anonymous, { sellerIds: [sellerId] }),
      ).toMatchObject({ ok: false });
      expect(await t.approvedCultures.execute(t.anonymous, { sellerIds: ['nope'] })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] }),
      );
      const many = Array.from({ length: 101 }, () => t.ids.next<'Seller'>());
      expect(await t.approvedCultures.execute(t.anonymous, { sellerIds: many })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] }),
      );
    });

    it('re-check: a certificate no longer valid takes the certified approval back to requested, one event', async () => {
      const { t, sellerId, plain, certified } = await approvedInBoth();
      t.certificates.held.clear();
      const before = t.events.length;

      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(ok({ demoted: 1 }));
      expect(statusOf(t, sellerId, certified.id)).toBe('requested');
      // The uncertified culture is never touched by a certificate.
      expect(statusOf(t, sellerId, plain.id)).toBe('approved');
      expect(statusEvents(t).slice(before)).toEqual([
        { type: 'sellers.seller-culture-status-changed.v1', version: 3, status: 'requested' },
      ]);
      // A repeated delivery converges.
      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(ok({ demoted: 0 }));
      expect(t.events.length).toBe(before + 1);
    });

    it('re-check: a certificate of another type is no certificate of the culture type', async () => {
      const { t, sellerId, certified } = await approvedInBoth();
      t.certificates.held.clear();
      t.certificates.held.add(certType === 'halal' ? 'kosher' : 'halal');
      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(ok({ demoted: 1 }));
      expect(statusOf(t, sellerId, certified.id)).toBe('requested');
    });

    it('re-check: a still valid certificate (a renewal) keeps the approval', async () => {
      const { t, sellerId, certified } = await approvedInBoth();
      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(ok({ demoted: 0 }));
      expect(statusOf(t, sellerId, certified.id)).toBe('approved');
    });

    it('re-check: fails closed for a retry when the certificate or culture cannot be read', async () => {
      const { t, sellerId, certified } = await approvedInBoth();
      t.certificates.down = true;
      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(
        err({ code: 'sellers.unavailable' }),
      );
      t.certificates.down = false;
      t.directory.down = true;
      expect(await t.recheck.execute(t.system, { sellerId })).toEqual(
        err({ code: 'sellers.unavailable' }),
      );
      expect(statusOf(t, sellerId, certified.id)).toBe('approved');
      // System only.
      t.directory.down = false;
      expect(await t.recheck.execute(t.anonymous, { sellerId })).toMatchObject({ ok: false });
    });

    it('re-check of a derecognised issuer (M3): every seller of its certificates, page by page', async () => {
      const { t, sellerId, plain, certified } = await approvedInBoth();
      const issuer = t.ids.next<'Issuer'>();
      // More sellers than one page, so the cursor is used; only the first has a membership.
      const others = Array.from({ length: ISSUER_SELLERS_PAGE }, () => t.ids.next<'Seller'>());
      t.certificates.issuers.set(issuer, [sellerId, ...others]);
      t.certificates.held.clear();

      expect(await t.recheckIssuer.execute(t.system, { issuerId: issuer })).toEqual(
        ok({ demoted: 1 }),
      );
      expect(statusOf(t, sellerId, certified.id)).toBe('requested');
      expect(statusOf(t, sellerId, plain.id)).toBe('approved');
      expect(t.certificates.pages.map((p) => p.after === null)).toEqual([true, false]);
      // Idempotent on a repeated delivery.
      expect(await t.recheckIssuer.execute(t.system, { issuerId: issuer })).toEqual(
        ok({ demoted: 0 }),
      );
    });

    it('re-check of an issuer: a failed page is unavailable (retry); system only; a bad id refused', async () => {
      const { t, sellerId, certified } = await approvedInBoth();
      const issuer = t.ids.next<'Issuer'>();
      t.certificates.issuers.set(issuer, [sellerId]);
      t.certificates.down = true;
      expect(await t.recheckIssuer.execute(t.system, { issuerId: issuer })).toEqual(
        err({ code: 'sellers.unavailable' }),
      );
      expect(statusOf(t, sellerId, certified.id)).toBe('approved');
      t.certificates.down = false;
      expect(await t.recheckIssuer.execute(t.anonymous, { issuerId: issuer })).toMatchObject({
        ok: false,
      });
      expect(await t.recheckIssuer.execute(t.system, { issuerId: 'x' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'issuerId', code: 'format' }] }),
      );
    });

    it('demotion runs one unit per batch of 200 and reports approvals left past the cap', async () => {
      const t = setUp(code);
      const plain = t.addCulture('plain');
      for (let n = 0; n < DEMOTE_BATCH + 1; n += 1) {
        await t.applySignup.execute(t.system, { sellerId: t.addSeller() });
      }
      t.units.length = 0;

      expect(await t.demoteApprovalsSystem.execute(t.system, { cultureId: plain.id })).toEqual(
        ok({ demoted: DEMOTE_BATCH + 1, remaining: false }),
      );
      // Two write units with rows and a third that found none.
      expect(t.units).toEqual(['write', 'write', 'write']);
      expect(await t.demoteApprovals.execute(t.system, { cultureId: plain.id })).toMatchObject({
        ok: false,
      });
    });

    it('a batch that failed leaves the earlier batches demoted (each committed on its own)', async () => {
      const t = setUp(code);
      const plain = t.addCulture('plain');
      for (let n = 0; n < DEMOTE_BATCH + 1; n += 1) {
        await t.applySignup.execute(t.system, { sellerId: t.addSeller() });
      }
      // The first demotion of the second batch throws, as a database fault would.
      let seen = 0;
      const transition = t.rows.transition.bind(t.rows);
      t.rows.transition = (m, state, expected) => {
        if (expected.status === 'approved' && ++seen === DEMOTE_BATCH + 1) {
          return Promise.reject(new Error('database fault'));
        }
        return transition(m, state, expected);
      };

      expect(await t.demoteApprovalsSystem.execute(t.system, { cultureId: plain.id })).toEqual(
        err({ code: 'sellers.unavailable' }),
      );
      const approved = [...t.rows.rows.values()].filter(
        (s) => s.cultureId === plain.id && s.status === 'approved',
      );
      expect(approved).toHaveLength(1);
    });
  });

  describe('seed', () => {
    it('attaches only sellers whose access is pending or approved', async () => {
      const t = setUp(code);
      t.addCulture('plain');
      const ok1 = t.addSeller('pending');
      const ok2 = t.addSeller('approved');
      const rejected = t.addSeller('rejected');
      const suspended = t.addSeller('suspended');
      const unknown = t.addSeller(null);

      expect(await t.seed.execute(t.system, {})).toEqual(
        ok({ attached: 2, skipped: 3, failed: 0, remaining: false }),
      );
      const attached = new Set([...t.rows.rows.values()].map((s) => s.sellerId));
      expect(attached).toEqual(new Set([ok1, ok2]));
      for (const id of [rejected, suspended, unknown]) expect(attached.has(id)).toBe(false);
    });

    it('passes over a seller whose attach fails, and still reaches the ones after it', async () => {
      const t = setUp(code);
      t.addCulture('plain');
      const broken = t.addSeller('approved');
      const later = t.addSeller('approved');
      // The first seller has no file for the use case (a fault in its own attach).
      t.rows.sellers.delete(`${t.market.marketId}|${broken}`);
      t.rows.sellers.add(`${t.market.marketId}|${broken}`);
      const real = t.rows.insert.bind(t.rows);
      t.rows.insert = (market, state) =>
        state.sellerId === broken ? Promise.reject(new Error('boom')) : real(market, state);

      expect(await t.seed.execute(t.system, {})).toEqual(
        ok({ attached: 1, skipped: 0, failed: 1, remaining: false }),
      );
      expect([...t.rows.rows.values()].map((s) => s.sellerId)).toEqual([later]);
    });

    it('reads in batches with a cursor, up to the cap per run', async () => {
      const t = setUp(code);
      t.addCulture('plain');
      for (let n = 0; n < 5; n += 1) t.addSeller('approved');
      const seen: (string | undefined)[] = [];
      const real = t.rows.sellerIdsWithoutCultures.bind(t.rows);
      t.rows.sellerIdsWithoutCultures = (market, limit, after) => {
        seen.push(after);
        return real(market, 2, after);
      };
      const done = await t.seed.execute(t.system, {});
      expect(done.ok && done.value.attached).toBe(5);
      // Three batches of 2, 2 and 1, each after the last seller of the one before.
      expect(seen[0]).toBeUndefined();
      expect(seen.slice(1).every((cursor) => cursor !== undefined)).toBe(true);
    });

    it('gives every seller with no culture the universal treatment, and never touches the others', async () => {
      const { t, sellerId: first } = withSeller();
      const second = t.addSeller();
      const chosen = t.addSeller();
      // One seller already has a (rejected) membership: it is skipped and stays as it is.
      const plain = [...t.cultures.values()][0]!;
      await t.request.execute(t.seller(chosen), { body: { cultureIds: [plain.id] } });
      await t.decide.execute(t.admin(), {
        sellerId: chosen,
        cultureId: plain.id,
        body: { decision: 'reject', reason: 'No' },
      });

      expect(await t.seed.execute(t.system, {})).toEqual(
        ok({ attached: 2, skipped: 0, failed: 0, remaining: false }),
      );
      const statuses = (sellerId: Id<'Seller'>) =>
        [...t.rows.rows.values()]
          .filter((s) => s.sellerId === sellerId)
          .map((s) => [s.cultureCode, s.status].join(':'))
          .sort();
      expect(statuses(first)).toEqual(['certified:requested', 'plain:approved']);
      expect(statuses(second)).toEqual(['certified:requested', 'plain:approved']);
      expect(statuses(chosen)).toEqual(['plain:rejected']);
      expect(await t.seed.execute(t.system, {})).toEqual(
        ok({ attached: 0, skipped: 0, failed: 0, remaining: false }),
      );
    });
  });
});
