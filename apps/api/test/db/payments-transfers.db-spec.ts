import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { TransferRecord } from '../../src/modules/payments/application/ports/transfer-store';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { PrismaTransferStore } from '../../src/modules/payments/infrastructure/prisma-transfer-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The transfer executions on PostgreSQL (payments.transfer_executions, package 6c), as the
// application role, for both Market fixtures: one row per key, the guarded changes, the Market
// guard, every CHECK and the trigger that keeps a transfer sent once and never taken back, the
// hash of the default bank account with its key-version rule, the change rows found by the live
// check (no event), and the transfer events in the inbox.

const T0 = Temporal.Instant.from('2026-10-27T10:00:00Z');
const CHECK = '23514';
const RESTRICT = '23001';
const NO_PRIVILEGE = '42501';
const HMAC_A = `hmac-sha256:k1:${'a'.repeat(64)}`;
const HMAC_B = `hmac-sha256:k1:${'b'.repeat(64)}`;
const HMAC_C = `hmac-sha256:k2:${'c'.repeat(64)}`;
const RESTRICT_OR_CHECK = [RESTRICT, CHECK];
const codeOf = async (statement: Promise<unknown>): Promise<string | null> => {
  try {
    await statement;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};
let sequence = 0;
const next = (prefix: string) => `${prefix}_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('transfer executions in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let db: Persistence;
  let store: PrismaTransferStore;
  let accounts: PrismaConnectedAccountStore;
  let inbox: PrismaStripeEventInbox;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    store = new PrismaTransferStore(db.service);
    accounts = new PrismaConnectedAccountStore(db.service);
    inbox = new PrismaStripeEventInbox(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
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
  const seller = async (): Promise<{ sellerId: string; accountRef: string }> => {
    const sellerId = randomUUID();
    const accountRef = next('acct_test');
    await value(market, async () => {
      await accounts.insert(market, sellerId, T0);
      await accounts.linkRef(market, sellerId, accountRef, T0);
    });
    return { sellerId, accountRef };
  };
  const record = (
    sellerId: string,
    accountRef: string,
    fields: Partial<TransferRecord> = {},
  ): TransferRecord => ({
    id: randomUUID(),
    instructionKey: next('payout'),
    sellerId,
    accountRef,
    amountMinor: 5000n,
    currency,
    reference: randomUUID(),
    state: 'sending',
    providerTransferRef: null,
    failureCode: null,
    reversedMinor: 0n,
    sendCount: 1,
    leaseUntil: T0.add({ seconds: 120 }),
    abandonedAt: null,
    fenceBreachedAt: null,
    executedAt: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...fields,
  });

  it('stores a command once by its key, reads it back and lets no other Market see it', async () => {
    const { sellerId, accountRef } = await seller();
    const row = record(sellerId, accountRef);

    expect(await value(market, () => store.insert(market, row))).toBe('inserted');
    expect(await value(market, () => store.insert(market, { ...row, id: randomUUID() }))).toBe(
      'conflict',
    );
    expect(await value(market, () => store.findByKey(market, row.instructionKey))).toEqual(row);
    expect(
      await value(market, () => store.findManyByKey(market, [row.instructionKey, 'unknown'])),
    ).toEqual([row]);
    expect(await value(other, () => store.findByKey(other, row.instructionKey))).toBeNull();
    expect(await value(other, () => store.findManyByKey(other, [row.instructionKey]))).toEqual([]);
    expect(
      await value(other, () =>
        store.change(
          other,
          row.id,
          { state: 'sending', version: 1 },
          {
            state: 'executed',
            providerTransferRef: 'tr_x',
            executedAt: T0,
          },
          T0,
        ),
      ),
    ).toBe(false);
  });

  it('changes a row only from the state and version it was decided from', async () => {
    const { sellerId, accountRef } = await seller();
    const row = record(sellerId, accountRef);
    await value(market, () => store.insert(market, row));
    const t1 = T0.add({ seconds: 5 });
    const executed = {
      state: 'executed' as const,
      providerTransferRef: next('tr_test'),
      executedAt: t1,
    };

    expect(
      await value(market, () =>
        store.change(market, row.id, { state: 'sending', version: 2 }, executed, t1),
      ),
    ).toBe(false);
    expect(
      await value(market, () =>
        store.change(market, row.id, { state: 'abandoned', version: 1 }, executed, t1),
      ),
    ).toBe(false);
    expect(
      await value(market, () =>
        store.change(market, row.id, { state: 'sending', version: 1 }, executed, t1),
      ),
    ).toBe(true);
    expect(await value(market, () => store.findByKey(market, row.instructionKey))).toEqual({
      ...row,
      ...executed,
      updatedAt: t1,
      version: 2,
    });
  });

  it('stores a tombstone of a key, which blocks a later command with that key', async () => {
    const { sellerId, accountRef } = await seller();
    const key = next('tomb');

    expect(
      await value(market, () =>
        store.insertTombstone(market, { id: randomUUID(), instructionKey: key, at: T0 }),
      ),
    ).toBe('inserted');
    expect(
      await value(market, () =>
        store.insertTombstone(market, { id: randomUUID(), instructionKey: key, at: T0 }),
      ),
    ).toBe('conflict');
    expect(
      await value(market, () =>
        store.insert(market, record(sellerId, accountRef, { instructionKey: key })),
      ),
    ).toBe('conflict');
    expect(await value(market, () => store.findByKey(market, key))).toMatchObject({
      sellerId: null,
      state: 'abandoned',
      sendCount: 0,
      abandonedAt: T0,
    });
  });

  it('lists the sends past their lease and totals the executed ones of a window', async () => {
    const { sellerId, accountRef } = await seller();
    // An instant of its own, so rows of other tests are outside the window.
    const base = Temporal.Instant.fromEpochMilliseconds(Date.now() + 400 * 24 * 3600 * 1000);
    const due = record(sellerId, accountRef, { leaseUntil: base.subtract({ seconds: 1 }) });
    const live = record(sellerId, accountRef, { leaseUntil: base.add({ hours: 5 }) });
    const done = record(sellerId, accountRef, {
      state: 'executed',
      providerTransferRef: next('tr_test'),
      executedAt: base,
      amountMinor: 7000n,
    });
    for (const r of [due, live, done]) await value(market, () => store.insert(market, r));

    const pastLease = await value(market, () => store.sendingPastLease(market, base, 10_000));
    expect(pastLease.map((r) => r.id)).toContain(due.id);
    expect(pastLease.map((r) => r.id)).not.toContain(live.id);
    expect(pastLease.map((r) => r.id)).not.toContain(done.id);
    expect(
      (await value(other, () => store.sendingPastLease(other, base, 10_000))).map((r) => r.id),
    ).not.toContain(due.id);

    const window = (from: Temporal.Instant, to: Temporal.Instant, target = market) =>
      value(target, () => store.executedTotal(target, currency, from, to));
    expect(await window(base.subtract({ seconds: 1 }), base.add({ seconds: 1 }))).toBe(7000n);
    expect(await window(base.add({ seconds: 1 }), base.add({ hours: 1 }))).toBe(0n);
    // The end of the window is exclusive, and another Market's total is its own.
    expect(await window(base.subtract({ seconds: 1 }), base)).toBe(0n);
    expect(await window(base.subtract({ seconds: 1 }), base.add({ seconds: 1 }), other)).toBe(0n);
  });

  describe('guards', () => {
    let row: TransferRecord;
    let sellerId: string;
    let accountRef: string;
    beforeEach(async () => {
      ({ sellerId, accountRef } = await seller());
      row = record(sellerId, accountRef);
      await value(market, () => store.insert(market, row));
    });
    const raw = (client: Client, set: string, id = row.id) =>
      client.query(
        `UPDATE payments.transfer_executions SET ${set} WHERE market_id = $1 AND id = $2`,
        [code, id],
      );
    const update = (set: string, id = row.id) => raw(sql, `${set}, version = version + 1`, id);
    const insertRow = async (fields: Record<string, unknown>) => {
      const values: Record<string, unknown> = {
        market_id: code,
        id: randomUUID(),
        tenant_id: market.tenantId,
        instruction_key: next('payout'),
        seller_id: sellerId,
        account_ref: accountRef,
        amount_minor: 5000,
        currency,
        reference: randomUUID(),
        state: 'sending',
        send_count: 1,
        lease_until: '2026-10-27T10:02:00Z',
        created_at: '2026-10-27T10:00:00Z',
        updated_at: '2026-10-27T10:00:00Z',
        version: 1,
        ...fields,
      };
      const columns = Object.keys(values);
      return sql.query(
        `INSERT INTO payments.transfer_executions (${columns.join(', ')}) VALUES (${columns
          .map((_c, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(values),
      );
    };

    it.each([
      ['the key', `instruction_key = 'other-key'`],
      ['the seller', `seller_id = gen_random_uuid()`],
      ['the account', `account_ref = 'acct_other'`],
      ['the amount', `amount_minor = amount_minor + 1`],
      ['the currency', `currency = 'NZD'`],
      ['the reference', `reference = gen_random_uuid()`],
    ])(
      'refuses to change %s of a transfer to the application and the owner',
      async (_label, set) => {
        // The application has no grant on the column; the trigger refuses even the owner.
        await expect(update(set)).rejects.toMatchObject({ code: NO_PRIVILEGE });
        await expect(raw(owner, `${set}, version = version + 1`)).rejects.toMatchObject({
          code: RESTRICT,
        });
      },
    );

    it('refuses to move the creation instant, to the owner too', async () => {
      await expect(
        raw(owner, `created_at = created_at + interval '1 second', version = version + 1`),
      ).rejects.toMatchObject({ code: RESTRICT });
    });

    it('counts a send once: from zero to one only, never back and never above one', async () => {
      // A row that was never sent (reserved) may be sent once.
      const reserved = record(sellerId, accountRef, {
        state: 'reserved',
        sendCount: 0,
        leaseUntil: null,
      });
      await value(market, () => store.insert(market, reserved));
      expect(RESTRICT_OR_CHECK).toContain(await codeOf(update(`send_count = 2`, reserved.id)));
      await expect(
        update(`state = 'sending', send_count = 1, lease_until = now()`, reserved.id),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(update(`send_count = 0`, reserved.id)).rejects.toMatchObject({ code: RESTRICT });
      expect(RESTRICT_OR_CHECK).toContain(await codeOf(update(`send_count = 2`, reserved.id)));
    });

    it('writes the Stripe id and the instants once', async () => {
      await update(`state = 'executed', provider_transfer_ref = 'tr_one', executed_at = now()`);
      await expect(update(`provider_transfer_ref = 'tr_two'`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await expect(update(`executed_at = now() + interval '1 day'`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await expect(update(`reversed_minor = 100`)).resolves.toMatchObject({ rowCount: 1 });
    });

    it('lets a reversal grow, never shrink and never pass the amount', async () => {
      await update(`state = 'executed', provider_transfer_ref = 'tr_rev', executed_at = now()`);
      await update(`reversed_minor = 1000`);
      await expect(update(`reversed_minor = 999`)).rejects.toMatchObject({ code: RESTRICT });
      await expect(update(`reversed_minor = 5001`)).rejects.toMatchObject({ code: CHECK });
      await expect(update(`reversed_minor = 5000`)).resolves.toMatchObject({ rowCount: 1 });
    });

    it('refuses a reversal on a transfer that is not executed', async () => {
      await expect(update(`reversed_minor = 1`)).rejects.toMatchObject({ code: CHECK });
    });

    it('moves the states only along the machine', async () => {
      // sending -> refused is final: nothing leaves a refused transfer.
      await update(`state = 'refused', failure_code = 'provider-refused'`);
      await expect(
        update(`state = 'executed', provider_transfer_ref = 'tr_x', executed_at = now()`),
      ).rejects.toMatchObject({ code: RESTRICT });
      await expect(update(`failure_code = 'transfer-failed'`)).rejects.toMatchObject({
        code: RESTRICT,
      });
    });

    it('lets an executed transfer fail but then keeps it final', async () => {
      await update(`state = 'executed', provider_transfer_ref = 'tr_f', executed_at = now()`);
      await expect(update(`state = 'sending'`)).rejects.toMatchObject({ code: RESTRICT });
      await expect(update(`state = 'abandoned', abandoned_at = now()`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await update(`state = 'failed', failure_code = 'transfer-failed'`);
      await expect(update(`state = 'executed'`)).rejects.toMatchObject({ code: RESTRICT });
    });

    it('moves an abandoned row to executed only as a recorded fence breach of a sent row', async () => {
      await update(`state = 'abandoned', abandoned_at = now()`);
      // Without the breach stamp: refused. The stamp alone, without executing: refused.
      await expect(
        update(`state = 'executed', provider_transfer_ref = 'tr_b', executed_at = now()`),
      ).rejects.toMatchObject({ code: RESTRICT });
      await expect(update(`fence_breached_at = now()`)).rejects.toMatchObject({ code: RESTRICT });
      await expect(
        update(
          `state = 'executed', provider_transfer_ref = 'tr_b', executed_at = now(), fence_breached_at = now()`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(update(`fence_breached_at = NULL`)).rejects.toMatchObject({ code: RESTRICT });
    });

    it('never executes an abandoned tombstone or a row that was not sent', async () => {
      const tombstone = randomUUID();
      await insertRow({
        id: tombstone,
        instruction_key: next('tomb'),
        seller_id: null,
        account_ref: null,
        amount_minor: null,
        currency: null,
        reference: null,
        state: 'abandoned',
        send_count: 0,
        lease_until: null,
        abandoned_at: '2026-10-27T10:00:00Z',
      });
      expect(RESTRICT_OR_CHECK).toContain(
        await codeOf(
          update(
            `state = 'executed', provider_transfer_ref = 'tr_t', executed_at = now(), fence_breached_at = now()`,
            tombstone,
          ),
        ),
      );
    });

    it('refuses a skipped version and a version that stays', async () => {
      await expect(raw(sql, `reversed_minor = 0, version = version + 2`)).rejects.toMatchObject({
        code: RESTRICT,
      });
      await expect(raw(sql, `updated_at = now()`)).rejects.toMatchObject({ code: RESTRICT });
    });

    it('refuses to delete a transfer, to the application', async () => {
      await expect(
        sql.query(`DELETE FROM payments.transfer_executions WHERE market_id = $1 AND id = $2`, [
          code,
          row.id,
        ]),
      ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    });

    it.each([
      ['a malformed key', { instruction_key: 'bad key' }],
      ['an empty key', { instruction_key: '' }],
      ['a zero amount', { amount_minor: 0 }],
      ['a lower-case currency', { currency: 'aud' }],
      ['a malformed account', { account_ref: 'ba_123' }],
      [
        'a malformed Stripe id',
        { state: 'executed', provider_transfer_ref: 'ch_1', executed_at: '2026-10-27T10:00:00Z' },
      ],
      ['an unknown state', { state: 'paid' }],
      ['an unknown failure code', { state: 'refused', failure_code: 'because' }],
      ['a send count of two', { send_count: 2 }],
      ['a version of zero', { version: 0 }],
      ['a sending row without a lease', { lease_until: null }],
      ['a sending row with a Stripe id', { provider_transfer_ref: 'tr_1' }],
      [
        'an executed row without its Stripe id',
        { state: 'executed', executed_at: '2026-10-27T10:00:00Z' },
      ],
      ['an executed row without its instant', { state: 'executed', provider_transfer_ref: 'tr_1' }],
      ['a refused row without its code', { state: 'refused' }],
      ['an abandoned row without its instant', { state: 'abandoned' }],
      ['a failure code on a sending row', { failure_code: 'provider-refused' }],
      ['a reversal on a sending row', { reversed_minor: 1 }],
      [
        'a reversal above the amount',
        {
          state: 'executed',
          provider_transfer_ref: 'tr_1',
          executed_at: '2026-10-27T10:00:00Z',
          reversed_minor: 5001,
        },
      ],
      ['a command without its seller', { seller_id: null }],
      ['a command without its reference', { reference: null }],
      [
        'a tombstone that was sent',
        {
          seller_id: null,
          account_ref: null,
          amount_minor: null,
          currency: null,
          reference: null,
          state: 'abandoned',
          abandoned_at: '2026-10-27T10:00:00Z',
          send_count: 1,
        },
      ],
      [
        'a tombstone that is sending',
        {
          seller_id: null,
          account_ref: null,
          amount_minor: null,
          currency: null,
          reference: null,
          send_count: 0,
        },
      ],
      ['a fence breach on a sending row', { fence_breached_at: '2026-10-27T10:00:00Z' }],
    ])('refuses to insert %s', async (_label, fields) => {
      await expect(insertRow(fields)).rejects.toMatchObject({ code: CHECK });
    });

    it('refuses a transfer of a seller that has no connected account', async () => {
      await expect(insertRow({ seller_id: randomUUID() })).rejects.toMatchObject({ code: '23503' });
    });

    it('refuses the same key twice in a Market, and allows it in another', async () => {
      const key = next('dup');
      await insertRow({ instruction_key: key });
      await expect(insertRow({ instruction_key: key })).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('the default bank account hash', () => {
    it('stamps a never-stamped hash, and re-stamps the same account under a newer key', async () => {
      const { sellerId } = await seller();

      expect(
        await value(market, () =>
          accounts.stampExternalAccountHmac(market, sellerId, null, HMAC_A, T0),
        ),
      ).toBe('stamped');
      expect(await value(market, () => accounts.find(market, sellerId))).toMatchObject({
        externalAccountHmac: HMAC_A,
      });
      // A stale expectation is a conflict.
      expect(
        await value(market, () =>
          accounts.stampExternalAccountHmac(market, sellerId, null, HMAC_C, T0),
        ),
      ).toBe('conflict');
      expect(
        await value(market, () =>
          accounts.stampExternalAccountHmac(market, sellerId, HMAC_A, HMAC_C, T0),
        ),
      ).toBe('stamped');
      expect(
        await value(other, () =>
          accounts.stampExternalAccountHmac(other, sellerId, HMAC_C, HMAC_A, T0),
        ),
      ).toBe('conflict');
    });

    it('refuses a different value under the same key version without a change row', async () => {
      const { sellerId } = await seller();
      await value(market, () =>
        accounts.stampExternalAccountHmac(market, sellerId, null, HMAC_A, T0),
      );

      expect(
        await value(market, () =>
          accounts.stampExternalAccountHmac(market, sellerId, HMAC_A, HMAC_B, T0),
        ),
      ).toBe('needs-change');
      expect(await value(market, () => accounts.find(market, sellerId))).toMatchObject({
        externalAccountHmac: HMAC_A,
      });
    });

    it('takes a different value with its change row, found by the live check and carrying no event', async () => {
      const { sellerId } = await seller();
      await value(market, () =>
        accounts.stampExternalAccountHmac(market, sellerId, null, HMAC_A, T0),
      );
      const until = T0.add({ hours: 24 });
      const change = {
        id: randomUUID(),
        kind: 'updated' as const,
        detectedAt: T0,
        coolingOffUntil: until,
        sourceEventId: null,
        detectedBy: 'live-check' as const,
        externalAccountHmac: HMAC_B,
      };

      expect(
        await value(market, () => accounts.recordChange(market, sellerId, change, null, until, T0)),
      ).toBe('recorded');
      expect(await value(market, () => accounts.find(market, sellerId))).toMatchObject({
        externalAccountHmac: HMAC_B,
        lastChangeId: change.id,
        coolingOffUntil: until,
        payoutsPausedUntil: until,
      });
      const rows = await sql.query(
        `SELECT detected_by, source_event_id FROM payments.payout_account_changes WHERE seller_id = $1`,
        [sellerId],
      );
      expect(rows.rows).toEqual([{ detected_by: 'live-check', source_event_id: null }]);
    });

    it.each([
      ['a hash without a key version', 'hmac-sha256:' + 'a'.repeat(64)],
      ['a hash of the wrong length', `hmac-sha256:k1:${'a'.repeat(63)}`],
      ['an upper-case hash', `hmac-sha256:k1:${'A'.repeat(64)}`],
      ['a plain Stripe id', 'ba_1234567890'],
      ['key version zero', `hmac-sha256:k0:${'a'.repeat(64)}`],
    ])('refuses %s', async (_label, hash) => {
      const { sellerId } = await seller();
      await expect(
        sql.query(
          `UPDATE payments.connected_accounts SET external_account_hmac = $3 WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId, hash],
        ),
      ).rejects.toMatchObject({ code: CHECK });
    });

    it.each([
      ['a webhook change without its event', { detected_by: 'webhook', source_event_id: null }],
      [
        'a live-check change with an event',
        { detected_by: 'live-check', source_event_id: 'evt_test_1' },
      ],
      ['an unknown detector', { detected_by: 'manual', source_event_id: null }],
      ['a malformed event id', { detected_by: 'webhook', source_event_id: 'x' }],
    ])('refuses a change row with %s', async (_label, fields) => {
      const { sellerId } = await seller();
      const values: Record<string, unknown> = {
        market_id: code,
        id: randomUUID(),
        tenant_id: market.tenantId,
        seller_id: sellerId,
        kind: 'updated',
        detected_at: '2026-10-27T10:00:00Z',
        cooling_off_until: '2026-10-28T10:00:00Z',
        ...fields,
      };
      const columns = Object.keys(values);
      await expect(
        sql.query(
          `INSERT INTO payments.payout_account_changes (${columns.join(', ')}) VALUES (${columns
            .map((_c, i) => `$${i + 1}`)
            .join(', ')})`,
          Object.values(values),
        ),
      ).rejects.toMatchObject({ code: CHECK });
    });
  });

  it('keeps the transfer events in the inbox with their outcome', async () => {
    for (const type of ['transfer.created', 'transfer.reversed'] as const) {
      const eventId = next('evt_test');
      expect(
        await value(market, () =>
          inbox.record(market, { eventId, type, objectId: next('tr_test'), receivedAt: T0 }),
        ),
      ).toBe('recorded');
      expect(
        await value(market, () => inbox.finish(market, eventId, 'transfer-recorded', T0)),
      ).toBe(true);
    }
  });
});
