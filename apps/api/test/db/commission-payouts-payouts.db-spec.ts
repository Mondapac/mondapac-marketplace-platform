import { randomUUID } from 'node:crypto';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuditEntry } from '@mondapac/shared-kernel';
import { AllowingStepUp } from '../support/commission-payouts-fakes';
import {
  FakeSellerNames,
  RecordingSecurityEvents,
} from '../support/commission-payouts-dispute-fakes';
import {
  FixedPayoutPolicy,
  ScriptedAccess,
  ScriptedPayments,
  ScriptedPrerequisites,
} from '../support/commission-payouts-payout-fakes';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { PayoutDependencies } from '../../src/modules/commission-payouts/application/payout-dependencies';
import { approvePayout } from '../../src/modules/commission-payouts/application/payout-admin-flow';
import { reconcileInstructions } from '../../src/modules/commission-payouts/application/payout-reconcile-flow';
import { runPayouts } from '../../src/modules/commission-payouts/application/payout-run-flow';
import { PayoutTermsResolver } from '../../src/modules/commission-payouts/application/payout-terms-resolver';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import { netBySellerOrder as pureNetBySellerOrder } from '../../src/modules/commission-payouts/domain/ledger';
import {
  approve,
  moveTo,
  openPayout,
  type Payout,
  type PayoutItem,
} from '../../src/modules/commission-payouts/domain/payout';
import { ConfigCommissionPolicy } from '../../src/modules/commission-payouts/infrastructure/config-commission-policy';
import { ConfigPayoutTermsPolicy } from '../../src/modules/commission-payouts/infrastructure/config-payout-terms-policy';
import { PrismaEligibilityAnchorRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-eligibility-anchor.repository';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { PrismaPayoutCursorRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-cursor.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaPayoutTermsRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-terms.repository';
import { PrismaPayoutRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { payoutRunOwnerTestDatabaseUrl, payoutRunTestDatabaseUrl } from './test-database';

// Package 6d on PostgreSQL, in both Market fixtures, on its own copy of the run database: the
// payouts, their items and the schedule cursors (CHECKs, the guard triggers, the unique indexes,
// the grants), the repositories, and the payout run end to end on the real stores with only the
// other modules' answers scripted.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const FIXTURES = {
  AU: { zone: 'Australia/Sydney', currency: 'AUD', runAt: '2026-10-20T00:00:00Z', minimum: 5000n },
  ZZ: { zone: 'Asia/Tokyo', currency: 'JPY', runAt: '2026-10-15T06:00:00Z', minimum: 3000n },
} as const;

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('payouts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const fixture = FIXTURES[code];
  const currency = fixture.currency;
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let payouts: PrismaPayoutRepository;
  let cursors: PrismaPayoutCursorRepository;
  let anchors: PrismaEligibilityAnchorRepository;
  let holds: PrismaPayoutHoldRepository;
  let ledger: PrismaLedgerRepository;
  let termsRepository: PrismaPayoutTermsRepository;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: payoutRunTestDatabaseUrl() });
    payouts = new PrismaPayoutRepository(db.service);
    cursors = new PrismaPayoutCursorRepository(db.service);
    anchors = new PrismaEligibilityAnchorRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
    ledger = new PrismaLedgerRepository(db.service);
    termsRepository = new PrismaPayoutTermsRepository(db.service);
    sql = new Client({ connectionString: payoutRunTestDatabaseUrl() });
    owner = new Client({ connectionString: payoutRunOwnerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

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

  const newPayout = (
    sellerId: Id<'Seller'>,
    items: readonly PayoutItem[],
    overrides: { netted?: bigint; firstPayout?: boolean; mode?: 'AUTO' | 'MANUAL' } = {},
  ): Payout =>
    openPayout({
      id: ids.next<'Payout'>(),
      sellerId,
      currency,
      items,
      netted: overrides.netted ?? 0n,
      approvalMode: overrides.mode ?? 'AUTO',
      firstPayout: overrides.firstPayout ?? false,
      minimum: fixture.minimum,
      slotAt: T0,
      now: T0,
    });
  const item = (amount: bigint): PayoutItem => ({
    sellerOrderId: ids.next<'SellerOrder'>(),
    amount,
  });
  const store = (payout: Payout, items: readonly PayoutItem[]) =>
    value(market, () => payouts.insert(market, payout, items));

  // --- the repository ---------------------------------------------------------------------------

  describe('the payout repository', () => {
    it('stores a payout with its items, finds it by id, seller and transfer, and only in its Market', async () => {
      const sellerId = ids.next<'Seller'>();
      const items = [item(7000n), item(8000n)];
      const payout = newPayout(sellerId, items, { netted: 1000n });
      await store(payout, items);

      const read = await value(market, () => payouts.findWithItems(market, payout.id));
      expect(read?.payout).toEqual(payout);
      expect(read?.items.map((i) => i.amount).sort()).toEqual([7000n, 8000n]);
      expect(await value(market, () => payouts.findLive(market, sellerId))).toEqual(payout);
      expect(await value(other, () => payouts.find(other, payout.id))).toBeNull();
      expect(await value(other, () => payouts.findLive(other, sellerId))).toBeNull();

      const sent = moveTo(payout, 'instructed', T0.add({ minutes: 1 }), {
        transferExecutionId: randomUUID(),
      });
      expect(await value(market, () => payouts.change(market, payout, sent))).toBe(true);
      expect(
        await value(market, () =>
          payouts.findByTransferExecution(market, sent.transferExecutionId!),
        ),
      ).toEqual(sent);
      expect(
        await value(other, () => payouts.findByTransferExecution(other, sent.transferExecutionId!)),
      ).toBeNull();
      // instructed is not live: the seller may have the next one.
      expect(await value(market, () => payouts.findLive(market, sellerId))).toBeNull();
    });

    it('changes a payout only from the state and version it was read at', async () => {
      const sellerId = ids.next<'Seller'>();
      const items = [item(9000n)];
      const payout = newPayout(sellerId, items, { mode: 'MANUAL' });
      await store(payout, items);
      const approved = approve(payout, 9000n, ids.next<'Account'>(), T0.add({ minutes: 1 }));
      if (!approved.ok) throw new Error('approve refused');
      expect(await value(market, () => payouts.change(market, payout, approved.value))).toBe(true);
      // The same change again, from the old read: lost.
      expect(await value(market, () => payouts.change(market, payout, approved.value))).toBe(false);
      expect(await value(other, () => payouts.change(other, payout, approved.value))).toBe(false);
      const stored = await value(market, () => payouts.find(market, payout.id));
      expect(stored).toMatchObject({
        state: 'approved',
        version: 2,
        approval: { approvedTransfer: 9000n },
      });
    });

    it('reports what a seller was paid, what is taken and whether it has been paid before', async () => {
      const sellerId = ids.next<'Seller'>();
      const first = [item(10000n)];
      const paid = newPayout(sellerId, first, { netted: 2000n });
      await store(paid, first);
      expect((await value(market, () => payouts.position(market, sellerId))).hasPaid).toBe(false);
      const instructed = moveTo(paid, 'instructed', T0.add({ minutes: 1 }), {
        transferExecutionId: randomUUID(),
      });
      await value(market, () => payouts.change(market, paid, instructed));
      const done = moveTo(instructed, 'paid', T0.add({ minutes: 2 }));
      await value(market, () => payouts.change(market, instructed, done));

      const second = [item(6000n)];
      const waiting = newPayout(sellerId, second, { mode: 'MANUAL' });
      await store(waiting, second);

      const position = await value(market, () => payouts.position(market, sellerId));
      expect(position.hasPaid).toBe(true);
      expect(position.nettedTotal).toBe(2000n);
      expect(position.itemAmounts.get(first[0]!.sellerOrderId)).toBe(10000n);
      expect(position.takenAmounts.get(first[0]!.sellerOrderId)).toBe(10000n);
      // A waiting payout holds its items but has taken nothing.
      expect(position.itemAmounts.get(second[0]!.sellerOrderId)).toBe(6000n);
      expect(position.takenAmounts.has(second[0]!.sellerOrderId)).toBe(false);
      const otherPosition = await value(other, () => payouts.position(other, sellerId));
      expect(otherPosition.itemAmounts.size).toBe(0);
    });

    it('frees the items of a payout that ends without paying, so a new payout can take them', async () => {
      const sellerId = ids.next<'Seller'>();
      const items = [item(9000n)];
      const payout = newPayout(sellerId, items);
      await store(payout, items);
      expect((await value(market, () => payouts.position(market, sellerId))).itemAmounts.size).toBe(
        1,
      );
      const refused = moveTo(payout, 'not-sent', T0.add({ minutes: 1 }), {
        outcomeCode: 'payments.transfer.account-not-ready',
      });
      await value(market, () => payouts.change(market, payout, refused));
      const freed = await sql.query<{ freed_at: Date | null }>(
        `SELECT freed_at FROM commission_payouts.payout_items WHERE payout_id = $1`,
        [payout.id],
      );
      expect(freed.rows[0]!.freed_at).not.toBeNull();
      expect((await value(market, () => payouts.position(market, sellerId))).itemAmounts.size).toBe(
        0,
      );
      const next = newPayout(sellerId, items);
      await store(next, items);
      expect((await value(market, () => payouts.findLive(market, sellerId)))?.id).toBe(next.id);
    });

    it('lists newest first with a cursor, by state, per seller without the hidden states', async () => {
      const sellerId = ids.next<'Seller'>();
      const created: Payout[] = [];
      for (let n = 0; n < 4; n += 1) {
        const items = [item(8000n)];
        const payout = {
          ...newPayout(sellerId, items),
          createdAt: T0.add({ minutes: n }),
          stateChangedAt: T0.add({ minutes: n }),
        };
        await store(payout, items);
        // One live payout per seller: end each one before the next.
        const ended =
          n === 3
            ? payout
            : moveTo(payout, 'not-sent', T0.add({ minutes: n, seconds: 30 }), {
                outcomeCode: 'voided.hold',
              });
        if (n !== 3) await value(market, () => payouts.change(market, payout, ended));
        created.push(ended);
      }
      const page1 = await value(market, () =>
        payouts.listForSeller(market, sellerId, [], { limit: 3, after: null }),
      );
      expect(page1.map((p) => p.id)).toEqual(
        [created[3]!, created[2]!, created[1]!].map((p) => p.id),
      );
      const last = page1[2]!;
      const page2 = await value(market, () =>
        payouts.listForSeller(market, sellerId, [], {
          limit: 3,
          after: { createdAt: last.createdAt, id: last.id },
        }),
      );
      expect(page2.map((p) => p.id)).toEqual([created[0]!.id]);
      const visible = await value(market, () =>
        payouts.listForSeller(market, sellerId, ['not-sent'], { limit: 10, after: null }),
      );
      expect(visible.map((p) => p.state)).toEqual(['instructing']);
      const byState = await value(market, () =>
        payouts.list(market, { state: 'instructing' }, { limit: 500, after: null }),
      );
      expect(byState.every((p) => p.state === 'instructing')).toBe(true);
      expect(byState.map((p) => p.id)).toContain(created[3]!.id);
      expect(
        await value(other, () =>
          payouts.listForSeller(other, sellerId, [], { limit: 10, after: null }),
        ),
      ).toEqual([]);
    });

    it('adds up what went to payments since an instant, and lists the open payouts oldest change first', async () => {
      const since = T0.add({ hours: 100 });
      const sellerId = ids.next<'Seller'>();
      const items = [item(9000n)];
      const payout = {
        ...newPayout(sellerId, items),
        createdAt: since,
        stateChangedAt: since,
        instructingAt: since,
      };
      await store(payout, items);
      const before = await value(market, () => payouts.sumTransferredSince(market, since));
      const otherBefore = await value(other, () => payouts.sumTransferredSince(other, since));
      const sent = moveTo(payout, 'instructed', since.add({ minutes: 1 }), {
        transferExecutionId: randomUUID(),
      });
      await value(market, () => payouts.change(market, payout, sent));
      expect(await value(market, () => payouts.sumTransferredSince(market, since))).toBe(
        before + 9000n,
      );
      expect(await value(other, () => payouts.sumTransferredSince(other, since))).toBe(otherBefore);
      const open = await value(market, () => payouts.listByState(market, ['instructed'], 500));
      expect(open.map((p) => p.id)).toContain(payout.id);
      const sorted = [...open].sort(
        (a, b) => a.stateChangedAt.epochMilliseconds - b.stateChangedAt.epochMilliseconds,
      );
      expect(open.map((p) => p.id)).toEqual(sorted.map((p) => p.id));
    });
  });

  // --- constraints, triggers and grants ---------------------------------------------------------

  describe('the table rules', () => {
    interface Row {
      id: string;
      seller_id: string;
      gross: bigint;
      netted: bigint;
      transfer: bigint;
      approval_mode: string;
      approval_reason: string | null;
      minimum: bigint;
      state: string;
      approved_by: string | null;
      approved_at: Date | null;
      approved_transfer: bigint | null;
      transfer_execution_id: string | null;
      outcome_code: string | null;
      instructing_at: Date | null;
      abandoned_at: Date | null;
      item: bigint;
    }
    const row = (overrides: Partial<Row> = {}): Row => ({
      id: randomUUID(),
      seller_id: randomUUID(),
      gross: 10000n,
      netted: 0n,
      transfer: 10000n,
      approval_mode: 'AUTO',
      approval_reason: null,
      minimum: fixture.minimum,
      state: 'instructing',
      approved_by: null,
      approved_at: null,
      approved_transfer: null,
      transfer_execution_id: null,
      outcome_code: null,
      instructing_at: new Date(T0.epochMilliseconds),
      abandoned_at: null,
      item: overrides.gross ?? 10000n,
      ...overrides,
    });
    /** A payout and one item in one transaction, as the repository writes them. */
    async function insertRaw(
      r: Row,
      marketId: string = code,
      guarded: boolean = true,
    ): Promise<void> {
      const db = guarded ? sql : owner;
      await db.query('BEGIN');
      try {
        // The CHECKs and unique indexes are tested on rows the insert guard would refuse first
        // (a payout born paid, say): the owner switches the guard off for that transaction only.
        if (!guarded) {
          await db.query(
            'ALTER TABLE commission_payouts.payouts DISABLE TRIGGER payouts_guard_insert',
          );
        }
        await db.query(
          `INSERT INTO commission_payouts.payouts
             (id, market_id, tenant_id, seller_id, currency, gross_minor, netted_minor, transfer_minor,
              approval_mode, approval_reason, minimum_minor, slot_at, state, approved_by, approved_at,
              approved_transfer_minor, transfer_execution_id, outcome_code, instructing_at, abandoned_at,
              created_at, state_changed_at, version)
           VALUES ($1, $2, 'platform', $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15,
                   $16, $17, $18, now(), now(), 1)`,
          [
            r.id,
            marketId,
            r.seller_id,
            currency,
            r.gross,
            r.netted,
            r.transfer,
            r.approval_mode,
            r.approval_reason,
            r.minimum,
            r.state,
            r.approved_by,
            r.approved_at,
            r.approved_transfer,
            r.transfer_execution_id,
            r.outcome_code,
            r.instructing_at,
            r.abandoned_at,
          ],
        );
        if (r.item > 0n) {
          await db.query(
            `INSERT INTO commission_payouts.payout_items
               (market_id, payout_id, seller_order_id, tenant_id, seller_id, currency, amount_minor)
             VALUES ($1, $2, $3, 'platform', $4, $5, $6)`,
            [marketId, r.id, randomUUID(), r.seller_id, currency, r.item],
          );
        }
        if (!guarded) {
          // The deferred sum check runs now, so the table has no pending trigger events to alter.
          await db.query('SET CONSTRAINTS ALL IMMEDIATE');
          await db.query(
            'ALTER TABLE commission_payouts.payouts ENABLE TRIGGER payouts_guard_insert',
          );
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
    const update = (id: string, set: string, params: unknown[] = []) =>
      sql.query(`UPDATE commission_payouts.payouts SET ${set} WHERE id = $1`, [id, ...params]);
    const move = (id: string, state: string, extra = '') =>
      update(id, `state = $2, state_changed_at = now(), version = version + 1${extra}`, [state]);

    it.each([
      ['an unknown state', { state: 'paused' }],
      ['a transfer that is not the gross less the netted', { transfer: 9000n }],
      [
        'a transfer under the minimum that is not fully netted',
        {
          gross: 1000n,
          transfer: 1000n,
        },
      ],
      ['a gross of zero', { gross: 0n, transfer: 0n, item: 0n }],
      ['a MANUAL payout with no reason', { approval_mode: 'MANUAL', state: 'awaiting-approval' }],
      ['an AUTO payout that waits for approval', { state: 'awaiting-approval' }],
      ['a netted payout that is not settled by netting', { netted: 10000n, transfer: 0n }],
      ['an instructed payout with no transfer id', { state: 'instructed' }],
      ['an instructing payout with no instant', { instructing_at: null }],
      ['a voided payout with no outcome code', { state: 'voided' }],
      ['an outcome code that is free text', { state: 'voided', outcome_code: 'Because I said so' }],
    ] as const)('refuses %s', async (_label, overrides) => {
      expect(await codeOf(insertRaw(row(overrides as Partial<Row>), code, false))).toBe(CHECK);
    });

    it('binds the approval to the amount: 5,999 for 6,000 is refused, the exact amount is kept', async () => {
      const approval = {
        approval_mode: 'MANUAL',
        approval_reason: 'terms',
        state: 'approved',
        gross: 6000n,
        transfer: 6000n,
        approved_by: randomUUID(),
        approved_at: new Date(T0.epochMilliseconds),
      };
      expect(
        await codeOf(insertRaw(row({ ...approval, approved_transfer: 5999n }), code, false)),
      ).toBe(CHECK);
      expect(
        await codeOf(insertRaw(row({ ...approval, approved_transfer: null }), code, false)),
      ).toBe(CHECK);
      expect(
        await codeOf(insertRaw(row({ ...approval, approved_transfer: 6000n }), code, false)),
      ).toBe('allowed');
      // An approved payout without an approver is refused too.
      expect(
        await codeOf(
          insertRaw(
            row({ ...approval, approved_by: null, approved_at: null, approved_transfer: null }),
            code,
            false,
          ),
        ),
      ).toBe(CHECK);
    });

    it('has one live payout per seller, and any number once they have ended', async () => {
      const sellerId = randomUUID();
      const first = row({ seller_id: sellerId });
      await insertRaw(first);
      expect(await codeOf(insertRaw(row({ seller_id: sellerId })))).toBe(UNIQUE);
      expect(await codeOf(insertRaw(row({ seller_id: randomUUID() })))).toBe('allowed');
      await move(first.id, 'not-sent', `, outcome_code = 'voided.hold'`);
      expect(await codeOf(insertRaw(row({ seller_id: sellerId })))).toBe('allowed');
    });

    it('keeps a payout and its items together: the gross is the sum of the items', async () => {
      expect(await codeOf(insertRaw(row({ item: 9000n })))).toBe(CHECK);
      expect(await codeOf(insertRaw(row({ item: 0n })))).toBe(CHECK);
      expect(await codeOf(insertRaw(row({ item: 10000n })))).toBe('allowed');
    });

    it("stores payments' transfer id once per Market", async () => {
      const transfer = randomUUID();
      const sent = { state: 'instructed', transfer_execution_id: transfer } as const;
      await insertRaw(row(sent), code, false);
      expect(await codeOf(insertRaw(row(sent), code, false))).toBe(UNIQUE);
      // The other Market may hold the same id (it is a different Market's transfer).
      expect(await codeOf(insertRaw(row(sent), otherMarketOf(code), false))).toBe('allowed');
    });

    it('allows the transitions of the state machine and no others', async () => {
      const path = async (states: readonly string[], extra: Partial<Row> = {}) => {
        const r = row(extra);
        await insertRaw(r);
        for (const state of states) {
          const set =
            state === 'instructed'
              ? `, transfer_execution_id = '${randomUUID()}'`
              : state === 'not-sent'
                ? `, outcome_code = 'transfer-refused'`
                : state === 'failed'
                  ? `, outcome_code = 'transfer-failed'`
                  : '';
          await move(r.id, state, set);
        }
        return r;
      };
      await path(['instructed', 'paid']);
      await path(['instructed', 'failed']);
      await path(['not-sent']);

      const waiting = row({
        approval_mode: 'MANUAL',
        approval_reason: 'first-payout',
        state: 'awaiting-approval',
      });
      await insertRaw(waiting);
      expect(await codeOf(move(waiting.id, 'instructing'))).toBe(RESTRICT);
      expect(await codeOf(move(waiting.id, 'paid'))).toBe(RESTRICT);
      expect(
        await codeOf(
          update(
            waiting.id,
            `state = 'approved', approved_by = $2, approved_at = now(),
             approved_transfer_minor = transfer_minor, state_changed_at = now(), version = version + 1`,
            [randomUUID()],
          ),
        ),
      ).toBe('allowed');
      expect(await codeOf(move(waiting.id, 'instructing'))).toBe('allowed');
      // Backwards, and sideways, are refused.
      expect(await codeOf(move(waiting.id, 'approved'))).toBe(RESTRICT);
      expect(await codeOf(move(waiting.id, 'paid'))).toBe(RESTRICT);
    });

    it('never changes a payout in a final state, nor the money, nor an approval or transfer id once written', async () => {
      const r = row();
      await insertRaw(r);
      await move(r.id, 'instructed', `, transfer_execution_id = '${randomUUID()}'`);
      expect(await codeOf(update(r.id, `transfer_execution_id = $2`, [randomUUID()]))).toBe(
        RESTRICT,
      );
      await move(r.id, 'paid');
      expect(await codeOf(update(r.id, `outcome_code = 'late'`))).toBe(RESTRICT);
      expect(await codeOf(move(r.id, 'failed'))).toBe(RESTRICT);

      const live = row();
      await insertRaw(live);
      // A change of state raises the version.
      expect(
        await codeOf(
          update(live.id, `state = 'instructed', transfer_execution_id = $2`, [randomUUID()]),
        ),
      ).toBe(RESTRICT);
      // The money and the seller are not granted to the application role at all.
      expect(await codeOf(update(live.id, `gross_minor = 1`))).toBe(NO_PRIVILEGE);
      expect(await codeOf(update(live.id, `seller_id = $2`, [randomUUID()]))).toBe(NO_PRIVILEGE);
      expect(await codeOf(update(live.id, `transfer_minor = 1`))).toBe(NO_PRIVILEGE);
      // The owner's own change of the money is still caught by the guard trigger.
      expect(
        await codeOf(
          owner.query(`UPDATE commission_payouts.payouts SET gross_minor = 1 WHERE id = $1`, [
            live.id,
          ]),
        ),
      ).toBe(RESTRICT);
    });

    it('lets a payout be born only in a state with nothing earned yet', async () => {
      const approver = { approved_by: randomUUID(), approved_at: new Date(T0.epochMilliseconds) };
      const approved = {
        approval_mode: 'MANUAL',
        approval_reason: 'terms',
        state: 'approved',
        approved_transfer: 10000n,
        ...approver,
      } as const;
      for (const overrides of [
        approved,
        { state: 'instructed', transfer_execution_id: randomUUID() },
        { state: 'paid', transfer_execution_id: randomUUID() },
        { state: 'failed', outcome_code: 'transfer-failed', transfer_execution_id: randomUUID() },
        { state: 'not-sent', outcome_code: 'transfer-refused' },
        { state: 'voided', outcome_code: 'voided.hold' },
      ] as readonly Partial<Row>[]) {
        expect(await codeOf(insertRaw(row(overrides)))).toBe(RESTRICT);
      }
      // An initial state that already carries an approval, a transfer id, an outcome or a fence.
      for (const overrides of [
        { ...approved, state: 'awaiting-approval' },
        { transfer_execution_id: randomUUID() },
        { outcome_code: 'voided.hold' },
        { abandoned_at: new Date(T0.epochMilliseconds) },
      ] as readonly Partial<Row>[]) {
        expect(await codeOf(insertRaw(row(overrides)))).toBe(RESTRICT);
      }
      // The four states the run creates payouts in.
      expect(await codeOf(insertRaw(row({ state: 'instructing' })))).toBe('allowed');
      expect(
        await codeOf(
          insertRaw(
            row({
              approval_mode: 'MANUAL',
              approval_reason: 'terms',
              state: 'awaiting-approval',
              instructing_at: null,
            }),
          ),
        ),
      ).toBe('allowed');
      expect(
        await codeOf(
          insertRaw(
            row({
              state: 'settled-by-netting',
              netted: 10000n,
              transfer: 0n,
              instructing_at: null,
            }),
          ),
        ),
      ).toBe('allowed');
      expect(await codeOf(insertRaw(row({ state: 'pending', instructing_at: null })))).toBe(
        'allowed',
      );
    });

    it('writes instructing_at once, on entering instructing, and abandoned_at once, while instructing', async () => {
      const waiting = row({
        approval_mode: 'MANUAL',
        approval_reason: 'terms',
        state: 'awaiting-approval',
        instructing_at: null,
      });
      await insertRaw(waiting);
      // Not outside the move into instructing.
      expect(await codeOf(update(waiting.id, `instructing_at = now()`))).toBe(RESTRICT);
      await update(
        waiting.id,
        `state = 'approved', approved_by = $2, approved_at = now(),
         approved_transfer_minor = transfer_minor, state_changed_at = now(), version = version + 1`,
        [randomUUID()],
      );
      expect(await codeOf(update(waiting.id, `instructing_at = now()`))).toBe(RESTRICT);
      // No fence before the payout is instructing.
      expect(await codeOf(update(waiting.id, `abandoned_at = now()`))).toBe(RESTRICT);
      expect(await codeOf(move(waiting.id, 'instructing', `, instructing_at = now()`))).toBe(
        'allowed',
      );

      // Neither moves again: not later, not earlier, not back to empty.
      for (const set of [
        `instructing_at = now() + interval '1 hour'`,
        `instructing_at = now() - interval '1 hour'`,
        `instructing_at = NULL`,
      ]) {
        expect(await codeOf(update(waiting.id, set))).toBe(RESTRICT);
      }
      expect(await codeOf(update(waiting.id, `abandoned_at = now()`))).toBe('allowed');
      for (const set of [
        `abandoned_at = now() + interval '1 hour'`,
        `abandoned_at = now() - interval '1 hour'`,
        `abandoned_at = NULL`,
      ]) {
        expect(await codeOf(update(waiting.id, set))).toBe(RESTRICT);
      }
      // The move on keeps both as they were.
      expect(await codeOf(move(waiting.id, 'not-sent', `, outcome_code = 'payout-unwound'`))).toBe(
        'allowed',
      );
    });

    it('writes the transfer id only with the move from instructing to instructed', async () => {
      const r = row();
      await insertRaw(r);
      expect(await codeOf(update(r.id, `transfer_execution_id = $2`, [randomUUID()]))).toBe(
        RESTRICT,
      );
      expect(
        await codeOf(move(r.id, 'not-sent', `, transfer_execution_id = '${randomUUID()}'`)),
      ).toBe(RESTRICT);
      expect(
        await codeOf(move(r.id, 'instructed', `, transfer_execution_id = '${randomUUID()}'`)),
      ).toBe('allowed');
    });

    it('accepts business-id-recheck as the reason a cursor shows', async () => {
      const sellerId = randomUUID();
      await sql.query(
        `INSERT INTO commission_payouts.payout_schedule_cursors
           (market_id, seller_id, tenant_id, last_slot_at, next_slot_at, block_reason, updated_at, version)
         VALUES ($1, $2, 'platform', $3, '2999-01-01T00:00:00Z', 'business-id-recheck', $3, 1)`,
        [code, sellerId, new Date(T0.epochMilliseconds)],
      );
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_schedule_cursors SET block_reason = 'whatever'
              WHERE market_id = $1 AND seller_id = $2`,
            [code, sellerId],
          ),
        ),
      ).toBe(CHECK);
    });

    it('refuses every delete and truncate, for the application role and the owner', async () => {
      const r = row();
      await insertRaw(r);
      expect(
        await codeOf(sql.query(`DELETE FROM commission_payouts.payouts WHERE id = $1`, [r.id])),
      ).toBe(NO_PRIVILEGE);
      expect(await codeOf(sql.query(`TRUNCATE commission_payouts.payouts`))).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(owner.query(`DELETE FROM commission_payouts.payouts WHERE id = $1`, [r.id])),
      ).toBe(RESTRICT);
      expect(await codeOf(owner.query(`TRUNCATE commission_payouts.payouts CASCADE`))).toBe(
        RESTRICT,
      );
      expect(await codeOf(owner.query(`DELETE FROM commission_payouts.payout_items`))).toBe(
        RESTRICT,
      );
    });

    it('lets an item change only by its release, and once', async () => {
      const r = row();
      await insertRaw(r);
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_items SET amount_minor = 1 WHERE payout_id = $1`,
            [r.id],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(
          sql.query(`DELETE FROM commission_payouts.payout_items WHERE payout_id = $1`, [r.id]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_items SET freed_at = NULL WHERE payout_id = $1`,
            [r.id],
          ),
        ),
      ).toBe(RESTRICT);
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_items SET freed_at = now() WHERE payout_id = $1`,
            [r.id],
          ),
        ),
      ).toBe('allowed');
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_items SET freed_at = now() WHERE payout_id = $1`,
            [r.id],
          ),
        ),
      ).toBe(RESTRICT);
    });

    it('allows one unfreed item per seller order across payouts', async () => {
      const sellerId = randomUUID();
      const sellerOrderId = randomUUID();
      const first = row({ seller_id: sellerId, item: 0n });
      const make = async (r: Row) => {
        await sql.query('BEGIN');
        try {
          await sql.query(
            `INSERT INTO commission_payouts.payouts (id, market_id, tenant_id, seller_id, currency, gross_minor,
               netted_minor, transfer_minor, approval_mode, minimum_minor, slot_at, state, instructing_at,
               created_at, state_changed_at, version)
             VALUES ($1, $2, 'platform', $3, $4, 10000, 0, 10000, 'AUTO', $5, now(), $6, now(), now(), now(), 1)`,
            [r.id, code, sellerId, currency, fixture.minimum, r.state],
          );
          await sql.query(
            `INSERT INTO commission_payouts.payout_items (market_id, payout_id, seller_order_id, tenant_id,
               seller_id, currency, amount_minor) VALUES ($1, $2, $3, 'platform', $4, $5, 10000)`,
            [code, r.id, sellerOrderId, sellerId, currency],
          );
          await sql.query('COMMIT');
        } catch (error) {
          await sql.query('ROLLBACK');
          throw error;
        }
      };
      await make(first);
      // A second payout of the same seller order while the first still holds it.
      await move(first.id, 'instructed', `, transfer_execution_id = '${randomUUID()}'`);
      expect(await codeOf(make(row({ state: 'instructing' })))).toBe(UNIQUE);
      await move(first.id, 'failed', `, outcome_code = 'transfer-failed'`);
      expect(await codeOf(make(row({ state: 'instructing' })))).toBe('allowed');
    });

    it('has the index of active holds by seller order that the payout run reads', async () => {
      const found = await sql.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'commission_payouts' AND indexname = 'payout_holds_active_seller_order_idx'`,
      );
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]!.indexdef).toContain('released_at IS NULL');
    });
  });

  // --- the cursors ------------------------------------------------------------------------------

  describe('the schedule cursors', () => {
    it('creates one cursor per seller, locks it by a version bump and moves it only forward', async () => {
      const sellerId = ids.next<'Seller'>();
      await value(market, () => cursors.ensure(market, sellerId, T0));
      await value(market, () => cursors.ensure(market, sellerId, T0.add({ hours: 5 })));
      const made = await value(market, () => cursors.find(market, sellerId));
      expect(made).toMatchObject({ version: 1, nextSlotAt: null, blockReason: null });
      expect(made?.lastSlotAt.toString()).toBe(T0.toString());
      expect(await value(other, () => cursors.find(other, sellerId))).toBeNull();
      expect(await value(other, () => cursors.lock(other, sellerId))).toBeNull();

      const locked = await value(market, () => cursors.lock(market, sellerId));
      expect(locked?.version).toBe(2);
      const later = T0.add({ hours: 7 });
      await value(market, () =>
        cursors.save(
          market,
          sellerId,
          {
            lastSlotAt: later,
            nextSlotAt: later.add({ hours: 24 }),
            zone: fixture.zone,
            blockReason: 'below-minimum',
            evaluatedAt: later,
          },
          later,
        ),
      );
      const saved = await value(market, () => cursors.find(market, sellerId));
      expect(saved).toMatchObject({ zone: fixture.zone, blockReason: 'below-minimum' });
      expect(saved?.lastSlotAt.toString()).toBe(later.toString());
      // Backwards is refused by the trigger.
      const backwards = db.unitOfWork.run(market, async () => {
        await cursors.save(
          market,
          sellerId,
          { lastSlotAt: T0, nextSlotAt: null, zone: null, blockReason: null, evaluatedAt: later },
          later,
        );
        return ok(undefined);
      });
      await expect(backwards).rejects.toThrow();
      const unchanged = await value(market, () => cursors.find(market, sellerId));
      expect(unchanged?.lastSlotAt.toString()).toBe(later.toString());
    });

    it('lists the sellers that are due, and works the next slot out again after a terms change', async () => {
      const due = ids.next<'Seller'>();
      const notYet = ids.next<'Seller'>();
      const now = T0.add({ hours: 9600 });
      await value(market, () => cursors.ensure(market, due, T0));
      await value(market, () => cursors.ensure(market, notYet, T0));
      const save = (sellerId: Id<'Seller'>, nextSlotAt: Temporal.Instant | null) =>
        value(market, () =>
          cursors.save(
            market,
            sellerId,
            { lastSlotAt: T0, nextSlotAt, zone: fixture.zone, blockReason: null, evaluatedAt: now },
            now,
          ),
        );
      await save(due, now.subtract({ minutes: 1 }));
      await save(notYet, now.add({ hours: 1 }));
      const listed = await value(market, () =>
        cursors.listDue(market, now, now.subtract({ hours: 1 }), 500),
      );
      expect(listed.map((c) => c.sellerId)).toContain(due);
      expect(listed.map((c) => c.sellerId)).not.toContain(notYet);
      expect(
        await value(other, () => cursors.listDue(other, now, now.subtract({ hours: 1 }), 500)),
      ).not.toContainEqual(expect.objectContaining({ sellerId: due }));
      await value(market, () => cursors.invalidate(market, notYet, now));
      const again = await value(market, () => cursors.find(market, notYet));
      expect(again).toMatchObject({ nextSlotAt: null, evaluatedAt: null });
      expect(
        (
          await value(market, () => cursors.listDue(market, now, now.subtract({ hours: 1 }), 500))
        ).map((c) => c.sellerId),
      ).toContain(notYet);
    });

    it('serialises two units that lock the same seller', async () => {
      const sellerId = ids.next<'Seller'>();
      await value(market, () => cursors.ensure(market, sellerId, T0));
      const order: string[] = [];
      const first = db.unitOfWork.run(market, async () => {
        await cursors.lock(market, sellerId);
        order.push('first-locked');
        await new Promise((resolve) => setTimeout(resolve, 300));
        order.push('first-done');
        return ok(undefined);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = db.unitOfWork.run(market, async () => {
        await cursors.lock(market, sellerId);
        order.push('second-locked');
        return ok(undefined);
      });
      await Promise.all([first, second]);
      expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
    });
  });

  // --- the ledger read --------------------------------------------------------------------------

  describe('what each seller order is worth', () => {
    it('sums credits less debits in the database as the pure function does, per currency', async () => {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      const line = ids.next<'OrderLine'>();
      const entry = (
        kind: LedgerEntry['kind'],
        amount: bigint,
        extra: Partial<LedgerEntry> = {},
      ): LedgerEntry => ({
        id: ids.next<'LedgerEntry'>(),
        sellerId,
        orderId,
        sellerOrderId,
        orderLineId: kind === 'shipping' ? null : line,
        kind,
        amount: money(amount, currency),
        rateBps: null,
        baseAmount: null,
        sourceId: null,
        occurredAt: T0,
        recordedAt: T0,
        ...extra,
      });
      const entries = [
        entry('sale', 20000n),
        entry('commission', 3000n, { rateBps: 1500, baseAmount: 20000n }),
        entry('shipping', 500n),
        entry('refund-sale', 4000n, { sourceId: ids.next<'Refund'>() }),
        entry('refund-commission', 600n, {
          sourceId: ids.next<'Refund'>(),
          rateBps: 1500,
          baseAmount: 4000n,
        }),
      ];
      await value(market, () => ledger.append(market, entries));
      const read = await value(market, () => ledger.netBySellerOrder(market, sellerId, currency));
      expect(read).toEqual(pureNetBySellerOrder(entries, sellerId, currency));
      expect(read).toEqual([{ sellerOrderId, net: 20000n - 3000n + 500n - 4000n + 600n }]);
      expect(await value(market, () => ledger.netBySellerOrder(market, sellerId, 'XXX'))).toEqual(
        [],
      );
      expect(await value(other, () => ledger.netBySellerOrder(other, sellerId, currency))).toEqual(
        [],
      );
    });
  });

  // --- the run, end to end ----------------------------------------------------------------------

  describe('the payout run on the real stores', () => {
    const clock = new FixedClock(Temporal.Instant.from(fixture.runAt));
    const system = testCallContext(market, 'system', 'cp-run-system');
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'cp-run-admin',
    );
    let access: ScriptedAccess;
    let payments: ScriptedPayments;
    let audit: RecordingAudit;
    let stepUp: AllowingStepUp;
    let security: RecordingSecurityEvents;
    let deps: PayoutDependencies;

    beforeEach(() => {
      clock.set(Temporal.Instant.from(fixture.runAt));
      access = new ScriptedAccess();
      payments = new ScriptedPayments();
      payments.instructAnswer = { kind: 'accepted', transferExecutionId: randomUUID() };
      audit = new RecordingAudit();
      stepUp = new AllowingStepUp();
      security = new RecordingSecurityEvents();
      deps = {
        unitOfWork: db.unitOfWork,
        payouts,
        cursors,
        ledger,
        anchors,
        holds,
        terms: new PayoutTermsResolver(new ConfigPayoutTermsPolicy(markets), termsRepository),
        policy: new ConfigCommissionPolicy(markets),
        payoutPolicy: new FixedPayoutPolicy(
          { AU: 'Australia/Sydney', ZZ: 'Asia/Tokyo' },
          { AU: 'AUD', ZZ: 'JPY' },
        ),
        access,
        prerequisites: new ScriptedPrerequisites(),
        payments,
        sellerNames: new FakeSellerNames(),
        securityEvents: security,
        stepUp,
        audit,
        ids,
        clock,
      };
    });

    /** A seller with a delivered, eligible seller order worth `net`, in the ledger and the anchors. */
    async function seller(
      net: bigint,
    ): Promise<{ sellerId: Id<'Seller'>; sellerOrderId: Id<'SellerOrder'> }> {
      const sellerId = ids.next<'Seller'>();
      const orderId = ids.next<'Order'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      const line = ids.next<'OrderLine'>();
      access.eligibleSellers.add(sellerId);
      access.zonesBySeller.set(sellerId, { zone: fixture.zone, provisional: false });
      payments.ready.add(sellerId);
      await value(market, async () => {
        await cursors.ensure(market, sellerId, T0);
        await ledger.append(market, [
          {
            id: ids.next<'LedgerEntry'>(),
            sellerId,
            orderId,
            sellerOrderId,
            orderLineId: line,
            kind: 'sale',
            amount: money(net, currency),
            rateBps: null,
            baseAmount: null,
            sourceId: null,
            occurredAt: T0,
            recordedAt: T0,
          },
        ]);
        await anchors.insertIfAbsent(market, {
          sellerOrderId,
          orderId,
          sellerId,
          deliveredAt: T0.subtract({ hours: 168 }),
          source: 'carrier',
          holdDaysApplied: 7,
          eligibleAt: T0,
          recordedAt: T0,
        });
      });
      return { sellerId, sellerOrderId };
    }
    const liveOf = (sellerId: Id<'Seller'>) =>
      value(market, () => payouts.listForSeller(market, sellerId, [], { limit: 10, after: null }));

    it('creates the first payout of a seller for approval, approves it and instructs it', async () => {
      const { sellerId, sellerOrderId } = await seller(20000n);
      expect(await runPayouts(deps, system)).toMatchObject({ ok: true, value: { created: 1 } });
      const [waiting] = await liveOf(sellerId);
      expect(waiting).toMatchObject({
        state: 'awaiting-approval',
        gross: 20000n,
        transfer: 20000n,
      });
      expect(
        (await value(market, () => payouts.findWithItems(market, waiting!.id)))?.items,
      ).toEqual([{ sellerOrderId, amount: 20000n }]);
      expect(payments.instructed).toEqual([]);

      const approved = await approvePayout(deps, admin, {
        payoutId: waiting!.id,
        amountMinor: '20000',
      });
      expect(approved).toMatchObject({ ok: true, value: { state: 'approved' } });
      expect(stepUp.spent).toEqual(['commission-payouts.payout.approve']);
      expect(audit.entries).toHaveLength(1);

      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      expect(await runPayouts(deps, system)).toMatchObject({ ok: true, value: { instructed: 1 } });
      const [sent] = await liveOf(sellerId);
      expect(sent).toMatchObject({ state: 'instructed', id: waiting!.id });
      expect(payments.instructed.map((c) => c.instructionKey)).toEqual([waiting!.id]);
      expect(sent!.transferExecutionId).not.toBeNull();

      // payments reports the transfer executed: the reconcile job marks it paid.
      payments.transfers.set(waiting!.id, {
        instructionKey: waiting!.id,
        state: 'executed',
        transferExecutionId: sent!.transferExecutionId,
      });
      expect(await reconcileInstructions(deps, system)).toMatchObject({
        ok: true,
        value: { paid: 1 },
      });
      expect((await liveOf(sellerId))[0]!.state).toBe('paid');
    });

    it('makes one payout when two runs race for the same seller', async () => {
      const { sellerId } = await seller(20000n);
      const results = await Promise.all([runPayouts(deps, system), runPayouts(deps, system)]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await liveOf(sellerId)).toHaveLength(1);
    });

    it('voids a waiting payout when a hold is placed on its seller order, and proposes the money again', async () => {
      const { sellerId, sellerOrderId } = await seller(20000n);
      await runPayouts(deps, system);
      const [waiting] = await liveOf(sellerId);
      await value(market, () =>
        holds.insertIfAbsent(market, {
          id: ids.next<'PayoutHold'>(),
          sellerId,
          sellerOrderId,
          reason: 'dispute',
          origin: 'system',
          sourceRef: randomUUID(),
          placedBy: null,
          placedAt: T0,
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
        }),
      );
      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      expect(await runPayouts(deps, system)).toMatchObject({ ok: true, value: { voided: 1 } });
      expect((await liveOf(sellerId))[0]).toMatchObject({
        id: waiting!.id,
        state: 'voided',
        outcomeCode: 'voided.hold',
      });
      // The item was freed: the position no longer holds the seller order.
      expect(
        (await value(market, () => payouts.position(market, sellerId))).itemAmounts.has(
          sellerOrderId,
        ),
      ).toBe(false);
    });

    it('does not touch another Market', async () => {
      const { sellerId } = await seller(20000n);
      const elsewhere = testCallContext(other, 'system', 'cp-run-other');
      await runPayouts(deps, elsewhere);
      expect(await liveOf(sellerId)).toEqual([]);
    });
  });
});
