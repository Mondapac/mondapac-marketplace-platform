import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ProviderDispute } from '../../src/modules/commission-payouts/application/ports/dispute-source';
import {
  DISPUTE_SOURCE,
  ORDER_PAYMENT_LOOKUP,
} from '../../src/modules/commission-payouts/application/ports/dispute-source';
import { DecideDispute } from '../../src/modules/commission-payouts/application/use-cases/decide-dispute.use-case';
import { ListDisputes } from '../../src/modules/commission-payouts/application/use-cases/list-disputes.use-case';
import { ViewDispute } from '../../src/modules/commission-payouts/application/use-cases/view-dispute.use-case';
import type { DisputeCase } from '../../src/modules/commission-payouts/domain/dispute';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import type {
  LateBoundDisputeSource,
  LateBoundOrderPaymentLookup,
} from '../../src/modules/commission-payouts/infrastructure/late-bound-dispute-ports';
import { PrismaDisputeRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-dispute.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { DisputeChanged } from '../../src/modules/payments';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { eventContext } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { disputesOwnerTestDatabaseUrl, disputesTestDatabaseUrl } from './test-database';

// Package 8b on PostgreSQL, in both Market fixtures: the dispute case snapshot and the decision
// tables (CHECKs, guard triggers, grants, indexes), the repository, and payments' dispute events
// reaching the commission-payouts consumer through the relay, the dispatcher and the module inbox,
// with the admin decision and the seller read on top. The provider side (payments' dispute and the
// order's PaymentIntent) is a fake bound to the late-bound ports. Runs on its own copy of the run
// database (global-setup.ts): the relay and the dispatcher claim every due row of a Market.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';

describe.each(TEST_MARKETS)('dispute effects in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let app: NestExpressApplication;
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];
  let disputes: PrismaDisputeRepository;
  let ledger: PrismaLedgerRepository;
  let holds: PrismaPayoutHoldRepository;
  let admin: CallContext;
  const providerDisputes = new Map<string, ProviderDispute>();
  const intents = new Map<string, string>();

  const catalogue = new EventCatalogue();
  catalogue.register('payments', [DisputeChanged]);
  catalogue.seal();

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  beforeAll(async () => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    sql = new Client({ connectionString: disputesTestDatabaseUrl() });
    owner = new Client({ connectionString: disputesOwnerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    db = createPersistence({ databaseUrl: disputesTestDatabaseUrl() });
    disputes = new PrismaDisputeRepository(db.service);
    ledger = new PrismaLedgerRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
    ({ app } = await createTestApp({ env: { DATABASE_URL: disputesTestDatabaseUrl() } }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    // payments and ordering are replaced by the test: the dispute and the order's PaymentIntent.
    app.get<LateBoundDisputeSource>(DISPUTE_SOURCE, { strict: false }).bind({
      read: (_context, disputeId) => Promise.resolve(providerDisputes.get(disputeId) ?? null),
    });
    app.get<LateBoundOrderPaymentLookup>(ORDER_PAYMENT_LOOKUP, { strict: false }).bind({
      paymentIntentOf: (_context, orderId) =>
        Promise.resolve(
          intents.has(orderId)
            ? { known: true as const, paymentIntentId: intents.get(orderId)! }
            : { known: false as const },
        ),
    });

    // An admin holding the two dispute keys through a custom role (no default role has the
    // protected `dispute.attribute` key), and a seller session per call.
    const roleId = ids.next<'Role'>();
    const accountId = ids.next<'Account'>();
    await owner.query(
      `INSERT INTO identity.roles (id, market_id, tenant_id, scope, kind, name, name_normalized,
         version, created_at)
       VALUES ($1, $2, $3, 'platform', 'custom', 'Dispute desk', 'dispute desk', 1, now())`,
      [roleId, code, market.tenantId],
    );
    for (const key of ['commission-payouts.dispute.view', 'commission-payouts.dispute.attribute']) {
      await owner.query(
        `INSERT INTO identity.role_permissions (market_id, tenant_id, role_id, permission_key)
         VALUES ($1, $2, $3, $4)`,
        [code, market.tenantId, roleId, key],
      );
    }
    const email = `disputes.${accountId}@example.test`;
    await owner.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email, email_normalized,
         display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, $3, 'admin', $4, $4, 'Desk', 'active', now(), now(), 1, now())`,
      [accountId, code, market.tenantId, email],
    );
    await owner.query(
      `INSERT INTO identity.password_credentials (market_id, tenant_id, account_id, password_hash,
         changed_at)
       VALUES ($1, $2, $3, $4, now())`,
      [code, market.tenantId, accountId, PASSWORD_HASH],
    );
    await owner.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
         assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, $3, $4, $5, NULL, now(), 1)`,
      [ids.next(), code, market.tenantId, accountId, roleId],
    );
    admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      `db-8b-${ids.next()}`,
    );
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await sql.end();
    await owner.end();
    logs.forEach((spy) => spy.mockRestore());
  });

  const caseOf = (overrides: Partial<DisputeCase> = {}): DisputeCase => ({
    disputeId: ids.next<'Dispute'>(),
    orderId: ids.next<'Order'>(),
    providerDisputeId: 'dp_db1',
    amount: money(2000n, currency),
    status: 'needs_response',
    inquiry: false,
    closed: false,
    outcome: null,
    reason: 'fraudulent',
    evidenceDueBy: T0.add({ hours: 24 * 7 }),
    fundsWithdrawn: false,
    fundsWithdrawnAt: null,
    fundsReinstated: false,
    fundsReinstatedAt: null,
    openedAt: T0,
    closedAt: null,
    bucket: 'needs-response',
    lastSyncedVersion: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

  describe('the tables', () => {
    it('lists the indexes of the brief and the payments order index', async () => {
      const names = async (schema: string, table: string) =>
        (
          await sql.query<{ indexname: string }>(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
            [schema, table],
          )
        ).rows.map((row) => row.indexname);
      expect(await names('commission_payouts', 'dispute_cases')).toEqual(
        expect.arrayContaining(['dispute_cases_bucket_idx']),
      );
      expect(await names('commission_payouts', 'dispute_cases')).not.toContain(
        'dispute_cases_closed_due_idx',
      );
      expect(await names('commission_payouts', 'ledger_entries')).toContain(
        'ledger_entries_market_id_order_id_idx',
      );
      expect(await names('commission_payouts', 'dispute_decisions')).toEqual(
        expect.arrayContaining(['dispute_decisions_first_key', 'dispute_decisions_reversal_key']),
      );
      expect(await names('payments', 'disputes')).toContain('disputes_market_id_order_id_idx');
      const def = (
        await sql.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'ledger_entries_market_id_order_id_idx'`,
        )
      ).rows[0]!.indexdef;
      expect(def).toContain('(market_id, order_id)');
    });

    it('refuses a case with a bad shape, in the database alone', async () => {
      const insert = (overrides: Partial<Record<string, unknown>>) => {
        const base: Record<string, unknown> = {
          market_id: market.marketId,
          dispute_id: ids.next(),
          tenant_id: market.tenantId,
          order_id: ids.next(),
          provider_dispute_id: 'dp_x1',
          amount_minor: 100,
          currency,
          status: 'needs_response',
          inquiry: false,
          closed: false,
          outcome: null,
          reason: 'fraudulent',
          funds_withdrawn: false,
          funds_withdrawn_at: null,
          funds_reinstated: false,
          funds_reinstated_at: null,
          opened_at: new Date('2026-10-14T10:00:00Z'),
          closed_at: null,
          bucket: 'needs-response',
          last_synced_version: 1,
          created_at: new Date('2026-10-14T10:00:00Z'),
          updated_at: new Date('2026-10-14T10:00:00Z'),
          ...overrides,
        };
        const columns = Object.keys(base);
        return codeOf(
          sql.query(
            `INSERT INTO commission_payouts.dispute_cases (${columns.join(', ')})
             VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
            columns.map((c) => base[c]),
          ),
        );
      };
      expect(await insert({})).toBe('allowed');
      expect(await insert({ amount_minor: 0 })).toBe(CHECK);
      expect(await insert({ status: 'maybe' })).toBe(CHECK);
      expect(await insert({ provider_dispute_id: 'x' })).toBe(CHECK);
      expect(await insert({ outcome: 'won', closed: false })).toBe(CHECK);
      expect(await insert({ outcome: 'draw', closed: true, closed_at: new Date() })).toBe(CHECK);
      expect(await insert({ closed: true, closed_at: null })).toBe(CHECK);
      expect(await insert({ funds_withdrawn: true, funds_withdrawn_at: null })).toBe(CHECK);
      expect(
        await insert({
          funds_reinstated: true,
          funds_reinstated_at: new Date(),
          funds_withdrawn: false,
        }),
      ).toBe(CHECK);
      expect(await insert({ bucket: 'other' })).toBe(CHECK);
      expect(await insert({ last_synced_version: 0 })).toBe(CHECK);
      expect(await insert({ currency: 'aud' })).toBe(CHECK);
      expect(await insert({ market_id: 'au' })).toBe(CHECK);
      expect(await insert({ updated_at: new Date('2026-10-13T10:00:00Z') })).toBe(CHECK);
    });

    it('moves a case snapshot one way, for the application role and the owner', async () => {
      const c = caseOf({
        fundsWithdrawn: true,
        fundsWithdrawnAt: T0,
        lastSyncedVersion: 3,
      });
      expect(await value(market, () => disputes.insert(market, c))).toBe(true);
      const update = (client: Client, set: string) =>
        codeOf(
          client.query(
            `UPDATE commission_payouts.dispute_cases SET ${set} WHERE market_id = $1 AND dispute_id = $2`,
            [market.marketId, c.disputeId],
          ),
        );
      // The application role may refresh the state columns only.
      expect(await update(sql, `amount_minor = 1`)).toBe(NO_PRIVILEGE);
      expect(await update(sql, `opened_at = now()`)).toBe(NO_PRIVILEGE);
      // The guard refuses what the grant would allow: a flag falling back, an older read.
      expect(await update(sql, `funds_withdrawn = false, funds_withdrawn_at = NULL`)).toBe(
        RESTRICT,
      );
      expect(await update(sql, `last_synced_version = 2`)).toBe(RESTRICT);
      expect(await update(sql, `funds_withdrawn_at = now()`)).toBe(RESTRICT);
      // The owner meets the same guard on the identity columns.
      expect(await update(owner, `amount_minor = 1`)).toBe(RESTRICT);
      expect(await update(owner, `order_id = '${ids.next()}'`)).toBe(RESTRICT);
      expect(await update(owner, `provider_dispute_id = 'dp_other'`)).toBe(RESTRICT);
      // A closed outcome stays.
      expect(
        await update(
          sql,
          `closed = true, closed_at = now(), outcome = 'lost', status = 'lost', last_synced_version = 4`,
        ),
      ).toBe('allowed');
      expect(await update(sql, `outcome = 'won'`)).toBe(RESTRICT);
      expect(await update(sql, `closed = false`)).toBe(RESTRICT);
      // Never deleted, whoever asks.
      expect(
        await codeOf(
          sql.query(`DELETE FROM commission_payouts.dispute_cases WHERE dispute_id = $1`, [
            c.disputeId,
          ]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(
          owner.query(`DELETE FROM commission_payouts.dispute_cases WHERE dispute_id = $1`, [
            c.disputeId,
          ]),
        ),
      ).toBe(RESTRICT);
      expect(await codeOf(owner.query(`TRUNCATE commission_payouts.dispute_cases`))).toBe(RESTRICT);
    });

    it('keeps a decision insert-only, with one first decision and one reversal per seller order', async () => {
      const disputeId = ids.next<'Dispute'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      const decision = (overrides: Partial<Record<string, unknown>> = {}) => {
        const row: Record<string, unknown> = {
          id: ids.next(),
          market_id: market.marketId,
          tenant_id: market.tenantId,
          dispute_id: disputeId,
          seller_order_id: sellerOrderId,
          seller_id: ids.next(),
          bearer: 'seller',
          amount_minor: 500,
          currency,
          reason_code: 'other',
          decided_by: ids.next(),
          decided_at: new Date('2026-10-14T10:00:00Z'),
          supersedes: null,
          ...overrides,
        };
        const columns = Object.keys(row);
        return {
          id: row.id as string,
          run: codeOf(
            sql.query(
              `INSERT INTO commission_payouts.dispute_decisions (${columns.join(', ')})
               VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
              columns.map((c) => row[c]),
            ),
          ),
        };
      };
      const first = decision();
      expect(await first.run).toBe('allowed');
      expect(await decision().run).toBe(UNIQUE);
      // Another seller order of the same dispute is another decision.
      expect(await decision({ seller_order_id: ids.next() }).run).toBe('allowed');
      // The platform reverses a seller decision, once.
      expect(
        await decision({
          bearer: 'platform',
          amount_minor: null,
          currency: null,
          supersedes: first.id,
        }).run,
      ).toBe('allowed');
      expect(
        await decision({
          bearer: 'platform',
          amount_minor: null,
          currency: null,
          supersedes: first.id,
        }).run,
      ).toBe(UNIQUE);
      // A reversal names a decision of its own seller order and dispute, and a seller decision.
      const elsewhere = decision({ seller_order_id: ids.next() });
      expect(await elsewhere.run).toBe('allowed');
      const reversal = (supersedes: string) => ({
        bearer: 'platform',
        amount_minor: null,
        currency: null,
        supersedes,
      });
      expect(await decision(reversal(elsewhere.id)).run).toBe('23503');
      const platformBears = decision({
        seller_order_id: ids.next(),
        bearer: 'platform',
        amount_minor: null,
        currency: null,
      });
      expect(await platformBears.run).toBe('allowed');
      expect(
        await decision({
          ...reversal(platformBears.id),
        }).run,
      ).toBe(CHECK);
      expect(await decision(reversal(ids.next())).run).toBe(CHECK);
      // Shape: a seller repays a positive amount, the platform names none, only the platform reverses.
      expect(await decision({ seller_order_id: ids.next(), amount_minor: 0 }).run).toBe(CHECK);
      expect(await decision({ seller_order_id: ids.next(), amount_minor: null }).run).toBe(CHECK);
      expect(await decision({ seller_order_id: ids.next(), bearer: 'platform' }).run).toBe(CHECK);
      expect(await decision({ seller_order_id: ids.next(), bearer: 'both' }).run).toBe(CHECK);
      expect(await decision({ seller_order_id: ids.next(), reason_code: 'because' }).run).toBe(
        CHECK,
      );
      expect(await decision({ seller_order_id: ids.next(), supersedes: ids.next() }).run).toBe(
        CHECK,
      );
      for (const client of [sql, owner]) {
        const expected = client === sql ? NO_PRIVILEGE : RESTRICT;
        expect(
          await codeOf(
            client.query(
              `UPDATE commission_payouts.dispute_decisions SET reason_code = 'other' WHERE id = $1`,
              [first.id],
            ),
          ),
        ).toBe(expected);
        expect(
          await codeOf(
            client.query(`DELETE FROM commission_payouts.dispute_decisions WHERE id = $1`, [
              first.id,
            ]),
          ),
        ).toBe(expected);
      }
      expect(await codeOf(owner.query(`TRUNCATE commission_payouts.dispute_decisions`))).toBe(
        RESTRICT,
      );
    });
  });

  describe('the repository', () => {
    it('inserts once, refreshes only with a version not below the stored one, and stays in its Market', async () => {
      const c = caseOf({ lastSyncedVersion: 2 });
      expect(await value(market, () => disputes.insert(market, c))).toBe(true);
      expect(await value(market, () => disputes.insert(market, c))).toBe(false);
      expect(await value(other, () => disputes.find(other, c.disputeId))).toBeNull();
      expect(await value(market, () => disputes.find(market, c.disputeId))).toMatchObject({
        orderId: c.orderId,
        amount: money(2000n, currency),
        bucket: 'needs-response',
        evidenceDueBy: c.evidenceDueBy,
      });
      const older = { ...c, status: 'under_review' as const, lastSyncedVersion: 1 };
      expect(await value(market, () => disputes.refresh(market, older))).toBe(false);
      const newer = {
        ...c,
        status: 'lost' as const,
        closed: true,
        outcome: 'lost' as const,
        fundsWithdrawn: true,
        fundsWithdrawnAt: T0.add({ hours: 1 }),
        closedAt: T0.add({ hours: 2 }),
        bucket: 'decision-needed' as const,
        lastSyncedVersion: 3,
        updatedAt: T0.add({ hours: 2 }),
      };
      expect(await value(other, () => disputes.refresh(other, newer))).toBe(false);
      expect(await value(market, () => disputes.refresh(market, newer))).toBe(true);
      expect(await value(market, () => disputes.find(market, c.disputeId))).toMatchObject({
        status: 'lost',
        closed: true,
        outcome: 'lost',
        fundsWithdrawnAt: T0.add({ hours: 1 }),
        closedAt: T0.add({ hours: 2 }),
        lastSyncedVersion: 3,
      });
    });

    it('lists newest first by bucket with a cursor, and counts per bucket, per Market', async () => {
      const mine = [0, 1, 2].map((n) =>
        caseOf({
          bucket: 'under-review',
          status: 'under_review',
          openedAt: T0.add({ hours: 24 * (400 + n) }),
          createdAt: T0.add({ hours: 24 * (400 + n) }),
          updatedAt: T0.add({ hours: 24 * (400 + n) }),
        }),
      );
      for (const c of mine) await value(market, () => disputes.insert(market, c));
      const foreign = caseOf({
        bucket: 'under-review',
        status: 'under_review',
        openedAt: T0.add({ hours: 24 * 300 }),
        createdAt: T0.add({ hours: 24 * 300 }),
        updatedAt: T0.add({ hours: 24 * 300 }),
      });
      await value(other, () => disputes.insert(other, foreign));
      const page1 = await value(market, () =>
        disputes.list(market, { bucket: 'under-review', limit: 2, after: null }),
      );
      expect(page1.map((c) => c.disputeId)).toEqual([mine[2]!.disputeId, mine[1]!.disputeId]);
      const page2 = await value(market, () =>
        disputes.list(market, {
          bucket: 'under-review',
          limit: 2,
          after: { openedAt: page1[1]!.openedAt, disputeId: page1[1]!.disputeId },
        }),
      );
      expect(page2[0]!.disputeId).toBe(mine[0]!.disputeId);
      expect(page2.map((c) => c.disputeId)).not.toContain(foreign.disputeId);
      const counts = await value(market, () => disputes.counts(market));
      expect(counts.get('under-review')).toBeGreaterThanOrEqual(3);
      const found = await value(market, () =>
        disputes.findMany(market, [mine[0]!.disputeId, foreign.disputeId]),
      );
      expect(found.map((c) => c.disputeId)).toEqual([mine[0]!.disputeId]);
    });
  });

  describe('payments events through the consumer', () => {
    const writer = () =>
      new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('payments');
    let version = 0;
    /** One `payments.dispute-changed.v1`, then the relay and the dispatcher until quiet. */
    async function changed(disputeId: Id<'Dispute'>, orderId: Id<'Order'>, target = market) {
      version += 1;
      await db.unitOfWork.run(target, async () => {
        await writer().append(eventContext(target), [
          DisputeChanged.record({
            aggregateId: disputeId,
            aggregateVersion: version,
            occurredAt: T0,
            payload: { disputeId, orderId },
          }),
        ]);
        return ok(undefined);
      });
      await settle();
    }
    let providerVersion = 0;
    function publish(
      disputeId: Id<'Dispute'>,
      orderId: Id<'Order'>,
      state: Partial<ProviderDispute>,
      pinned?: number,
    ) {
      providerVersion += 1;
      providerDisputes.set(disputeId, {
        disputeId,
        orderId,
        providerDisputeId: 'dp_db2',
        paymentIntentRef: intents.get(orderId) ?? 'pi_unknown',
        amount: money(2000n, currency),
        status: 'needs_response',
        reason: 'fraudulent',
        inquiry: false,
        closed: false,
        evidenceDueBy: T0.add({ hours: 24 * 7 }),
        fundsWithdrawn: false,
        fundsWithdrawnAt: null,
        fundsReinstated: false,
        fundsReinstatedAt: null,
        outcome: null,
        openedAt: T0,
        version: pinned ?? providerVersion,
        ...state,
      });
    }
    const lostState = (extra: Partial<ProviderDispute> = {}): Partial<ProviderDispute> => ({
      status: 'lost',
      closed: true,
      outcome: 'lost',
      fundsWithdrawn: true,
      fundsWithdrawnAt: T0,
      ...extra,
    });
    /** A paid seller order in the ledger: sale 1000 and commission 150 (cap 850). */
    async function paid(
      sellerId: Id<'Seller'>,
      orderId: Id<'Order'>,
      target = market,
    ): Promise<Id<'SellerOrder'>> {
      const sellerOrderId = ids.next<'SellerOrder'>();
      const row = (kind: 'sale' | 'commission', amount: bigint): LedgerEntry => ({
        id: ids.next<'LedgerEntry'>(),
        sellerId,
        orderId,
        sellerOrderId,
        orderLineId: ids.next<'OrderLine'>(),
        kind,
        amount: money(amount, currency),
        rateBps: kind === 'commission' ? 1500 : null,
        baseAmount: kind === 'commission' ? 1000n : null,
        sourceId: null,
        occurredAt: T0,
        recordedAt: T0,
      });
      await value(target, () =>
        ledger.append(target, [row('sale', 1000n), row('commission', 150n)]),
      );
      return sellerOrderId;
    }
    const holdsOf = async (disputeId: string, target = market) =>
      (
        await sql.query<{
          seller_order_id: string;
          released_at: Date | null;
          released_by: string | null;
        }>(
          `SELECT seller_order_id, released_at, released_by FROM commission_payouts.payout_holds
            WHERE market_id = $1 AND reason = 'dispute' AND source_ref = $2
            ORDER BY seller_order_id`,
          [target.marketId, disputeId],
        )
      ).rows;
    const caseRow = async (disputeId: string, target = market) =>
      (
        await sql.query<{ bucket: string; closed: boolean; last_synced_version: number }>(
          `SELECT bucket, closed, last_synced_version FROM commission_payouts.dispute_cases
            WHERE market_id = $1 AND dispute_id = $2`,
          [target.marketId, disputeId],
        )
      ).rows[0];
    const outboxOf = async (sellerOrderId: string) =>
      (
        await sql.query<{ payload: Record<string, string>; aggregate_version: number }>(
          `SELECT payload, aggregate_version FROM commission_payouts.outbox
            WHERE market_id = $1 AND type = 'commission-payouts.seller-order-disputed.v1'
              AND aggregate_id = $2`,
          [market.marketId, sellerOrderId],
        )
      ).rows;
    const noticesOf = async (sellerId: string) =>
      (
        await sql.query<{ kind: string; params: Record<string, string> }>(
          `SELECT kind, params FROM notifications.in_app_notices
            WHERE market_id = $1 AND seller_id = $2 AND kind = 'seller.order-disputed'`,
          [market.marketId, sellerId],
        )
      ).rows;
    /** What the seller's own read stands on: its dispute holds and the decisions about it. */
    const ownOf = async (sellerId: Id<'Seller'>) =>
      value(market, async () => ({
        holds: (
          await holds.listForSeller(market, sellerId, { activeOnly: false, limit: 50 })
        ).filter((h) => h.reason === 'dispute'),
        decisions: await disputes.decisionsForSeller(market, sellerId),
      }));
    const decide = (
      disputeId: Id<'Dispute'>,
      sellerOrderId: Id<'SellerOrder'>,
      bearer: 'platform' | 'seller',
      amountMinor?: string,
    ) =>
      app.get(DecideDispute, { strict: false }).execute(admin, {
        disputeId,
        sellerOrderId,
        bearer,
        amountMinor,
        reasonCode: 'no-delivery-proof',
      });

    it('inquiry, chargeback, won: holds while open, tells the seller once, releases by the system', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_a1');
      const sellerOrderId = await paid(sellerId, orderId);

      publish(disputeId, orderId, { status: 'warning_needs_response', inquiry: true });
      await changed(disputeId, orderId);
      expect(await holdsOf(disputeId)).toMatchObject([
        { seller_order_id: sellerOrderId, released_at: null },
      ]);
      expect(await caseRow(disputeId)).toMatchObject({ bucket: 'needs-response', closed: false });
      expect(await outboxOf(sellerOrderId)).toMatchObject([
        { payload: { sellerId, orderId, disputeId, sellerOrderId }, aggregate_version: 1 },
      ]);
      expect(await noticesOf(sellerId)).toMatchObject([
        { kind: 'seller.order-disputed', params: { sellerOrderId, orderId } },
      ]);
      expect(JSON.stringify(await noticesOf(sellerId))).not.toMatch(/fraud|dp_|2000/);

      // The inquiry escalates: the same hold, no second notice.
      publish(disputeId, orderId, { fundsWithdrawn: true, fundsWithdrawnAt: T0 });
      await changed(disputeId, orderId);
      expect(await holdsOf(disputeId)).toHaveLength(1);
      expect(await outboxOf(sellerOrderId)).toHaveLength(1);
      expect(await noticesOf(sellerId)).toHaveLength(1);

      // The seller's own read has the open hold and no decision.
      const own = await ownOf(sellerId);
      expect(own.holds).toMatchObject([{ sellerOrderId, sourceRef: disputeId, releasedAt: null }]);
      expect(own.decisions).toEqual([]);

      publish(disputeId, orderId, {
        status: 'won',
        closed: true,
        outcome: 'won',
        fundsWithdrawn: true,
        fundsWithdrawnAt: T0,
        fundsReinstated: true,
        fundsReinstatedAt: T0,
      });
      await changed(disputeId, orderId);
      const released = await holdsOf(disputeId);
      expect(released[0]!.released_at).not.toBeNull();
      expect(released[0]!.released_by).toBeNull();
      expect(await caseRow(disputeId)).toMatchObject({ bucket: 'won', closed: true });
      // The seller ledger was never touched.
      const rows = await sql.query(
        `SELECT kind FROM commission_payouts.ledger_entries WHERE market_id = $1 AND seller_order_id = $2 ORDER BY kind`,
        [market.marketId, sellerOrderId],
      );
      expect(rows.rows.map((r: { kind: string }) => r.kind)).toEqual(['commission', 'sale']);
    });

    it('lost: keeps the hold until each seller order has a decision; a seller repay writes one dispute-debit', async () => {
      const sellerA = ids.next<'Seller'>();
      const sellerB = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_b1');
      const soA = await paid(sellerA, orderId);
      const soB = await paid(sellerB, orderId);

      publish(disputeId, orderId, {});
      await changed(disputeId, orderId);
      expect(await holdsOf(disputeId)).toHaveLength(2);
      publish(disputeId, orderId, lostState());
      await changed(disputeId, orderId);
      expect((await holdsOf(disputeId)).every((r) => r.released_at === null)).toBe(true);
      expect(await caseRow(disputeId)).toMatchObject({ bucket: 'decision-needed', closed: true });

      const detail = await app.get(ViewDispute, { strict: false }).execute(admin, { disputeId });
      expect(detail).toMatchObject({ ok: true });
      const cap = detail.ok
        ? detail.value.sellerOrders.map((s) => [s.recoverableCap.amountMinor, s.decision])
        : [];
      expect(cap).toEqual([
        [850n, 'allowed'],
        [850n, 'allowed'],
      ]);

      // Above the cap, the database sees nothing.
      expect(await decide(disputeId, soA, 'seller', '851')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.amount-out-of-range' },
      });
      expect(await decide(disputeId, soA, 'seller', '400')).toMatchObject({
        ok: true,
        value: { bearer: 'seller', holdsReleased: false, bucket: 'decision-needed' },
      });
      expect(await decide(disputeId, soA, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
      const debit = await sql.query<{ amount_minor: string; source_id: string }>(
        `SELECT amount::text AS amount_minor, source_id FROM commission_payouts.ledger_entries
          WHERE market_id = $1 AND seller_order_id = $2 AND kind = 'dispute-debit'`,
        [market.marketId, soA],
      );
      expect(debit.rows).toEqual([{ amount_minor: '400', source_id: disputeId }]);

      expect(await decide(disputeId, soB, 'platform')).toMatchObject({
        ok: true,
        value: { holdsReleased: true, bucket: 'closed' },
      });
      const after = await holdsOf(disputeId);
      expect(after.every((r) => r.released_at !== null)).toBe(true);
      expect(
        (
          await sql.query(
            `SELECT 1 FROM commission_payouts.ledger_entries WHERE market_id = $1 AND seller_order_id = $2 AND kind = 'dispute-debit'`,
            [market.marketId, soB],
          )
        ).rowCount,
      ).toBe(0);

      // The seller repaid has a released hold and the one decision, and the other seller none.
      const own = await ownOf(sellerA);
      expect(own.holds).toMatchObject([{ sellerOrderId: soA }]);
      expect(own.holds[0]!.releasedAt).not.toBeNull();
      expect(own.decisions).toMatchObject([
        { bearer: 'seller', amount: { amount: 400n, currency } },
      ]);
      expect((await ownOf(sellerB)).decisions).toMatchObject([
        { bearer: 'platform', amount: null },
      ]);
      // The seller's cap now counts the debit.
      const detail2 = await app.get(ViewDispute, { strict: false }).execute(admin, { disputeId });
      const capOf = (sellerOrderId: string) =>
        detail2.ok
          ? detail2.value.sellerOrders.find((s) => s.sellerOrderId === sellerOrderId)
              ?.recoverableCap.amountMinor
          : undefined;
      expect([capOf(soA), capOf(soB)]).toEqual([450n, 850n]);
    });

    describe('decisions at the same time', () => {
      const debitsOf = async (sellerOrderId: string) =>
        (
          await sql.query<{ amount_minor: string }>(
            `SELECT amount::text AS amount_minor FROM commission_payouts.ledger_entries
              WHERE market_id = $1 AND seller_order_id = $2 AND kind = 'dispute-debit'
              ORDER BY amount`,
            [market.marketId, sellerOrderId],
          )
        ).rows.map((r) => r.amount_minor);

      it('two sibling seller orders decided at once: the holds are released and the bucket is closed', async () => {
        const orderId = ids.next<'Order'>();
        const disputeId = ids.next<'Dispute'>();
        intents.set(orderId, 'pi_c1');
        const soA = await paid(ids.next<'Seller'>(), orderId);
        const soB = await paid(ids.next<'Seller'>(), orderId);
        publish(disputeId, orderId, lostState());
        await changed(disputeId, orderId);

        const results = await Promise.all([
          decide(disputeId, soA, 'platform'),
          decide(disputeId, soB, 'seller', '100'),
        ]);
        expect(results.every((r) => r.ok)).toBe(true);
        // The decision that ran second saw the first and released the holds.
        expect(results.filter((r) => r.ok && r.value.holdsReleased).length).toBe(1);
        expect((await holdsOf(disputeId)).every((r) => r.released_at !== null)).toBe(true);
        expect(await caseRow(disputeId)).toMatchObject({ bucket: 'closed' });
      });

      it('one seller order decided twice at once: one wins, the other is already decided, one ledger row', async () => {
        const orderId = ids.next<'Order'>();
        const disputeId = ids.next<'Dispute'>();
        intents.set(orderId, 'pi_c2');
        const soA = await paid(ids.next<'Seller'>(), orderId);
        publish(disputeId, orderId, lostState());
        await changed(disputeId, orderId);

        const results = await Promise.all([
          decide(disputeId, soA, 'seller', '400'),
          decide(disputeId, soA, 'seller', '400'),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.find((r) => !r.ok)).toMatchObject({
          ok: false,
          error: { code: 'commission-payouts.dispute.already-decided' },
        });
        expect(await debitsOf(soA)).toEqual(['400']);
      });

      it('two disputes of one order deciding the same seller order: the total stays within the cap', async () => {
        const orderId = ids.next<'Order'>();
        const first = ids.next<'Dispute'>();
        const second = ids.next<'Dispute'>();
        intents.set(orderId, 'pi_c3');
        const soA = await paid(ids.next<'Seller'>(), orderId);
        for (const disputeId of [first, second]) {
          publish(disputeId, orderId, lostState());
          await changed(disputeId, orderId);
        }

        // Cap 850: 600 and 600 cannot both be taken.
        const results = await Promise.all([
          decide(first, soA, 'seller', '600'),
          decide(second, soA, 'seller', '600'),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.find((r) => !r.ok)).toMatchObject({
          ok: false,
          error: { code: 'commission-payouts.dispute.amount-out-of-range' },
        });
        expect(await debitsOf(soA)).toEqual(['600']);
      });

      it('a seller order with nothing left to recover refuses a seller bearer and lets the platform bear it', async () => {
        const orderId = ids.next<'Order'>();
        const disputeId = ids.next<'Dispute'>();
        intents.set(orderId, 'pi_c4');
        const soA = await paid(ids.next<'Seller'>(), orderId);
        publish(disputeId, orderId, lostState());
        await changed(disputeId, orderId);
        // The whole cap, then a second dispute of the order finds the cap at zero.
        expect(await decide(disputeId, soA, 'seller', '850')).toMatchObject({ ok: true });
        const later = ids.next<'Dispute'>();
        publish(later, orderId, lostState());
        await changed(later, orderId);
        expect(await decide(later, soA, 'seller', '1')).toMatchObject({
          ok: false,
          error: { code: 'commission-payouts.dispute.amount-out-of-range' },
        });
        expect(await decide(later, soA, 'platform')).toMatchObject({ ok: true });
        expect(await debitsOf(soA)).toEqual(['850']);
      });
    });

    it('lost and reinstated: needs review; the platform reverses a seller decision with a dispute-reinstate', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_c1');
      const so = await paid(sellerId, orderId);
      publish(disputeId, orderId, lostState());
      await changed(disputeId, orderId);
      expect(await decide(disputeId, so, 'seller', '300')).toMatchObject({ ok: true });
      expect(await decide(disputeId, so, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });

      publish(
        disputeId,
        orderId,
        lostState({ fundsReinstated: true, fundsReinstatedAt: T0.add({ hours: 5 }) }),
      );
      await changed(disputeId, orderId);
      expect(await caseRow(disputeId)).toMatchObject({ bucket: 'decision-needed' });
      expect(await decide(disputeId, so, 'platform')).toMatchObject({
        ok: true,
        value: { reversal: true, bucket: 'closed' },
      });
      const kinds = await sql.query<{ kind: string; amount_minor: string }>(
        `SELECT kind, amount::text AS amount_minor FROM commission_payouts.ledger_entries
          WHERE market_id = $1 AND seller_order_id = $2 AND source_id = $3 ORDER BY kind`,
        [market.marketId, so, disputeId],
      );
      expect(kinds.rows).toEqual([
        { kind: 'dispute-debit', amount_minor: '300' },
        { kind: 'dispute-reinstate', amount_minor: '300' },
      ]);
      expect(await decide(disputeId, so, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
      // Reversed: two decisions, the second superseding the first.
      const own = await ownOf(sellerId);
      expect(own.decisions.map((d) => [d.bearer, d.supersedes === null])).toEqual(
        expect.arrayContaining([
          ['seller', true],
          ['platform', false],
        ]),
      );
    });

    it('replays and out-of-order deliveries give the same state', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_d1');
      const so = await paid(sellerId, orderId);
      // The newest state is read by the first (late) delivery of the first event.
      publish(disputeId, orderId, lostState(), 5);
      await changed(disputeId, orderId);
      expect(await caseRow(disputeId)).toMatchObject({ last_synced_version: 5 });
      // An older read never goes back: the case stays lost and closed.
      publish(disputeId, orderId, { status: 'needs_response' }, 2);
      await changed(disputeId, orderId);
      expect(await caseRow(disputeId)).toMatchObject({ last_synced_version: 5, closed: true });
      // The same state again, many times: one hold, one event, one notice.
      publish(disputeId, orderId, lostState(), 5);
      await changed(disputeId, orderId);
      await changed(disputeId, orderId);
      expect(await holdsOf(disputeId)).toHaveLength(1);
      expect(await outboxOf(so)).toHaveLength(1);
      expect(await noticesOf(sellerId)).toHaveLength(1);
    });

    it('parks a PaymentIntent mismatch and an unknown order: a security event, no hold, no case', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_e1');
      await paid(sellerId, orderId);
      publish(disputeId, orderId, { paymentIntentRef: 'pi_somebody_else' });
      await changed(disputeId, orderId);
      const ghostOrder = ids.next<'Order'>();
      const ghost = ids.next<'Dispute'>();
      publish(ghost, ghostOrder, { paymentIntentRef: 'pi_ghost' });
      await changed(ghost, ghostOrder);
      expect(await holdsOf(disputeId)).toHaveLength(0);
      expect(await caseRow(disputeId)).toBeUndefined();
      expect(await caseRow(ghost)).toBeUndefined();
      const events = await sql.query<{ payload: Record<string, string>; severity: string }>(
        `SELECT payload, severity FROM platform.security_events
          WHERE market_id = $1 AND type = 'commission-payouts.dispute.order-mismatch'
            AND payload->>'disputeId' = ANY($2)`,
        [market.marketId, [disputeId, ghost]],
      );
      expect(
        events.rows.map((r) => [r.payload.disputeId, r.payload.reason, r.severity]).sort(),
      ).toEqual(
        [
          [disputeId, 'payment-intent-mismatch', 's2'],
          [ghost, 'unknown-order', 's2'],
        ].sort(),
      );
    });

    it('holds only its own Market: the same order id in the other Market is untouched', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const disputeId = ids.next<'Dispute'>();
      intents.set(orderId, 'pi_f1');
      const so = await paid(sellerId, orderId);
      const foreignSo = await paid(ids.next<'Seller'>(), orderId, other);
      publish(disputeId, orderId, {});
      await changed(disputeId, orderId);
      expect((await holdsOf(disputeId)).map((h) => h.seller_order_id)).toEqual([so]);
      expect(await holdsOf(disputeId, other)).toHaveLength(0);
      expect(await caseRow(disputeId, other)).toBeUndefined();
      expect(await outboxOf(foreignSo)).toHaveLength(0);
      // The other Market's admin sees nothing of the case.
      const foreignAdmin = testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
        `db-8b-${ids.next()}`,
      );
      expect(
        await app.get(ListDisputes, { strict: false }).execute(foreignAdmin, {}),
      ).toMatchObject({ ok: false });
    });
  });
});
