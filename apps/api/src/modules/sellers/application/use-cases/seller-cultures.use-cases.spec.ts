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
import type { SellerCertificateDirectory } from '../ports/seller-certificate-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
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

  sellerIdsWithoutCultures(market: MarketContext, limit: number) {
    return Promise.resolve(
      [...this.sellers]
        .filter((k) => k.startsWith(`${market.marketId}|`))
        .map((k) => k.split('|')[1] as Id<'Seller'>)
        .filter(
          (id) => ![...this.rows.keys()].some((k) => k.startsWith(`${market.marketId}|${id}|`)),
        )
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
  const unitOfWork: UnitOfWork = { run: (_m, work) => work(), runOnce: noRunOnce };

  const cultures = new Map<Id<'Culture'>, CultureInfo>();
  const directory = { down: false, asks: 0 };
  const cultureDirectory: CultureDirectory = {
    byIds: (_c, wanted) => {
      directory.asks += 1;
      if (directory.down) return Promise.resolve(err({ code: 'culture-directory.unavailable' }));
      return Promise.resolve(
        ok(new Map(wanted.filter((id) => cultures.has(id)).map((id) => [id, cultures.get(id)!]))),
      );
    },
    active: () => {
      if (directory.down) return Promise.resolve(err({ code: 'culture-directory.unavailable' }));
      return Promise.resolve(ok([...cultures.values()].filter((c) => c.status === 'active')));
    },
  };
  const certificates = { held: new Set<string>(), down: false };
  const certificateDirectory: SellerCertificateDirectory = {
    validTypeCodes: () =>
      certificates.down
        ? Promise.resolve(err({ code: 'seller-certificate-directory.unavailable' }))
        : Promise.resolve(ok(new Set(certificates.held) as ReadonlySet<string>)),
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
  const addSeller = (): Id<'Seller'> => {
    const id = ids.next<'Seller'>();
    rows.sellers.add(`${market.marketId}|${id}`);
    return id;
  };
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
    seed: new SeedSellerCultures(gate, { unitOfWork, sellerCultures: rows, applySignup }),
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

  describe('seed', () => {
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

      expect(await t.seed.execute(t.system, {})).toEqual(ok({ attached: 2, remaining: false }));
      const statuses = (sellerId: Id<'Seller'>) =>
        [...t.rows.rows.values()]
          .filter((s) => s.sellerId === sellerId)
          .map((s) => [s.cultureCode, s.status].join(':'))
          .sort();
      expect(statuses(first)).toEqual(['certified:requested', 'plain:approved']);
      expect(statuses(second)).toEqual(['certified:requested', 'plain:approved']);
      expect(statuses(chosen)).toEqual(['plain:rejected']);
      expect(await t.seed.execute(t.system, {})).toEqual(ok({ attached: 0, remaining: false }));
    });
  });
});
