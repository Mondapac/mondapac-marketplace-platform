import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PRICING_FIXTURES } from '../support/pricing-fixtures';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Pricing slice 1, part 2: the constraints, triggers and grants of migration
// pricing_series_regular (pricing-data 2, 3.1 to 3.3, 3.6, 3.8, 7, 10), as the application role
// and, for the triggers, as the owner, for both Market fixtures; and the write-refusal counters
// (3.8, D 5.2) through their repository.

const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');
const at = (seconds: number): string => T0.add({ seconds }).toString();
const MAX_SAFE = '9007199254740991';

describe.each(TEST_MARKETS)('pricing constraints in market %s (database integration)', (code) => {
  const otherCode = otherMarketOf(code);
  const currency = PRICING_FIXTURES.find((f) => f.code === code)!.policy.currency;
  const otherCurrency = PRICING_FIXTURES.find((f) => f.code === otherCode)!.policy.currency;
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const submitter = ids.next<'Account'>();
  const decider = ids.next<'Account'>();
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  async function insert(
    client: Client,
    table: string,
    row: Record<string, unknown>,
  ): Promise<string | null> {
    const columns = Object.keys(row);
    return sqlState(
      client,
      `INSERT INTO pricing.${table} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  function seriesRow(overrides: Record<string, unknown> = {}) {
    return {
      id: ids.next(),
      market_id: code,
      tenant_id: 'default',
      offer_id: ids.next(),
      variant_id: ids.next(),
      product_id: ids.next(),
      seller_id: ids.next(),
      currency,
      version: 1,
      created_at: at(0),
      ...overrides,
    };
  }
  async function newSeries(overrides: Record<string, unknown> = {}): Promise<string> {
    const row = seriesRow(overrides);
    expect(await insert(app, 'price_series', row)).toBeNull();
    return row.id;
  }

  /** An accepted record effective from `from` (seconds after T0), open unless `to` is given. */
  function recordRow(seriesId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: ids.next(),
      market_id: code,
      tenant_id: 'default',
      series_id: seriesId,
      amount_minor: '1000',
      currency,
      tax_inclusive: true,
      status: 'accepted',
      submitted_at: at(0),
      submitted_by_account_id: submitter,
      effective_from: at(0),
      ...overrides,
    };
  }
  async function newRecord(seriesId: string, overrides: Record<string, unknown> = {}) {
    const row = recordRow(seriesId, overrides);
    expect(await insert(app, 'regular_price_records', row)).toBeNull();
    return row.id;
  }
  /** A pending record held upward against `anchorId` (amount 1000). */
  const pendingRow = (
    seriesId: string,
    anchorId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    recordRow(seriesId, {
      status: 'pending-review',
      amount_minor: '5000',
      effective_from: null,
      anchor_record_id: anchorId,
      anchor_amount_minor: '1000',
      hold_direction: 'up',
      submitted_at: at(10),
      ...overrides,
    });
  const update = (client: Client, id: string, set: string, values: unknown[] = []) =>
    sqlState(
      client,
      `UPDATE pricing.regular_price_records SET ${set} WHERE market_id = '${code}' AND id = $${values.length + 1}`,
      [...values, id],
    );

  describe('price_series (3.2)', () => {
    it('keeps one series per key in a Market, and the same key apart in each Market', async () => {
      const row = seriesRow();
      expect(await insert(app, 'price_series', row)).toBeNull();
      expect(await insert(app, 'price_series', { ...row, id: ids.next() })).toBe('23505');
      expect(
        await insert(app, 'price_series', {
          ...row,
          id: ids.next(),
          market_id: otherCode,
          currency: otherCurrency,
        }),
      ).toBeNull();
    });

    it.each([
      ['a malformed currency', { currency: 'aud' }],
      ['a malformed Market', { market_id: 'au' }],
      ['version 0', { version: 0 }],
      ['a retirement without its cause', { retired_at: at(5) }],
      ['an unknown cause', { retired_at: at(5), retire_cause: 'gone' }],
      ['a retirement before creation', { retired_at: at(-5), retire_cause: 'offer-removed' }],
    ])('refuses %s (23514)', async (_name, overrides) => {
      expect(await insert(app, 'price_series', seriesRow(overrides))).toBe('23514');
    });

    it('lets the application change only version and retirement (42501 otherwise, no DELETE)', async () => {
      const id = await newSeries();
      const where = `WHERE market_id = '${code}' AND id = $1`;
      expect(
        await sqlState(app, `UPDATE pricing.price_series SET version = 2 ${where}`, [id]),
      ).toBeNull();
      expect(
        await sqlState(
          app,
          `UPDATE pricing.price_series SET retired_at = $2, retire_cause = 'variant-removed' ${where}`,
          [id, at(1)],
        ),
      ).toBeNull();
      for (const column of ['offer_id', 'variant_id', 'product_id', 'seller_id']) {
        expect(
          await sqlState(app, `UPDATE pricing.price_series SET ${column} = $2 ${where}`, [
            id,
            ids.next(),
          ]),
        ).toBe('42501');
      }
      expect(
        await sqlState(app, `UPDATE pricing.price_series SET currency = 'XXX' ${where}`, [id]),
      ).toBe('42501');
      expect(await sqlState(app, `DELETE FROM pricing.price_series ${where}`, [id])).toBe('42501');
    });
  });

  describe('regular_price_records: keys and money (P1, P2, P3)', () => {
    it('stores amounts in minor units of the series currency, up to 2^53 - 1', async () => {
      const seriesId = await newSeries();
      expect(
        await insert(app, 'regular_price_records', recordRow(seriesId, { amount_minor: MAX_SAFE })),
      ).toBeNull();
    });

    it.each([
      ['zero', '0'],
      ['a negative amount', '-5'],
      ['2^53', '9007199254740992'],
    ])('refuses %s (23514)', async (_name, amount) => {
      const seriesId = await newSeries();
      expect(
        await insert(app, 'regular_price_records', recordRow(seriesId, { amount_minor: amount })),
      ).toBe('23514');
    });

    it('refuses a record in another currency than its series, or claiming another Market (23503)', async () => {
      const seriesId = await newSeries();
      expect(
        await insert(
          app,
          'regular_price_records',
          recordRow(seriesId, { currency: otherCurrency }),
        ),
      ).toBe('23503');
      expect(
        await insert(app, 'regular_price_records', recordRow(seriesId, { market_id: otherCode })),
      ).toBe('23503');
    });

    it('refuses an anchor from another series, and the record as its own anchor', async () => {
      const seriesId = await newSeries();
      const foreignSeries = await newSeries();
      const foreignAnchor = await newRecord(foreignSeries);
      const id = ids.next();
      expect(await insert(app, 'regular_price_records', pendingRow(seriesId, foreignAnchor))).toBe(
        '23503',
      );
      expect(await insert(app, 'regular_price_records', pendingRow(seriesId, id, { id }))).toBe(
        '23514',
      );
    });
  });

  describe('regular_price_records: status columns (P4, P5; 3.3)', () => {
    let seriesId: string;
    let anchorId: string;
    beforeEach(async () => {
      seriesId = await newSeries();
      anchorId = await newRecord(seriesId);
    });

    it.each([
      ['an unknown status', { status: 'live' }],
      ['an accepted record without its start', { effective_from: null }],
      ['a start before the submission', { effective_from: at(-1) }],
      ['an empty period', { effective_to: at(0) }],
      ['an accepted record with a direction', { hold_direction: 'up' }],
      ['an anchor amount without its record', { anchor_amount_minor: '500' }],
      ['a decision on an accepted record', { decided_at: at(1), decided_by_account_id: decider }],
      ['a supersede on an accepted record', { superseded_at: at(1), supersede_cause: 'cancelled' }],
    ])('refuses %s (23514)', async (_name, overrides) => {
      expect(await insert(app, 'regular_price_records', recordRow(seriesId, overrides))).toBe(
        '23514',
      );
    });

    it.each([
      ['a held record without direction', { hold_direction: null }],
      ['a direction that disagrees with the amounts', { hold_direction: 'down' }],
      ['a held record without an anchor', { anchor_record_id: null, anchor_amount_minor: null }],
      ['a pending record with a start', { effective_from: at(10) }],
      ['a superseded record without its cause', { status: 'superseded', superseded_at: at(11) }],
      [
        'a replaced record without its successor',
        { status: 'superseded', superseded_at: at(11), supersede_cause: 'replaced' },
      ],
      [
        'a cancelled record naming a successor',
        {
          status: 'superseded',
          superseded_at: at(11),
          supersede_cause: 'cancelled',
          superseded_by_record_id: '00000000-0000-7000-8000-000000000001',
        },
      ],
      [
        'a rejection without a reason',
        { status: 'rejected', decided_at: at(11), decided_by_account_id: decider },
      ],
      [
        'the submitter deciding their own record (H4)',
        {
          status: 'rejected',
          decided_at: at(11),
          decided_by_account_id: submitter,
          decision_reason_code: 'too-high',
        },
      ],
      [
        'a decision before the submission',
        {
          status: 'rejected',
          decided_at: at(5),
          decided_by_account_id: decider,
          decision_reason_code: 'too-high',
        },
      ],
      [
        'a malformed reason code',
        {
          status: 'rejected',
          decided_at: at(11),
          decided_by_account_id: decider,
          decision_reason_code: 'Too High',
        },
      ],
      [
        'a note with a bidi override',
        {
          status: 'rejected',
          decided_at: at(11),
          decided_by_account_id: decider,
          decision_reason_code: 'too-high',
          decision_note: 'see ‮ here',
        },
      ],
      [
        'a note with outer spaces',
        {
          status: 'rejected',
          decided_at: at(11),
          decided_by_account_id: decider,
          decision_reason_code: 'too-high',
          decision_note: ' padded ',
        },
      ],
      [
        'a note of 1,001 characters',
        {
          status: 'rejected',
          decided_at: at(11),
          decided_by_account_id: decider,
          decision_reason_code: 'too-high',
          decision_note: 'x'.repeat(1001),
        },
      ],
      [
        'an approval effective before the decision',
        {
          status: 'approved',
          decided_at: at(20),
          decided_by_account_id: decider,
          effective_from: at(15),
        },
      ],
    ])('refuses %s (23514)', async (_name, overrides) => {
      expect(
        await insert(app, 'regular_price_records', pendingRow(seriesId, anchorId, overrides)),
      ).toBe('23514');
    });

    it('accepts a rejection with a reason code and a multi-line note', async () => {
      expect(
        await insert(
          app,
          'regular_price_records',
          pendingRow(seriesId, anchorId, {
            status: 'rejected',
            decided_at: at(11),
            decided_by_account_id: decider,
            decision_reason_code: 'too-high',
            decision_note: 'Line one\nLine two',
          }),
        ),
      ).toBeNull();
    });

    it('keeps at most one pending record per series (PD2, AC 12; 23505)', async () => {
      expect(await insert(app, 'regular_price_records', pendingRow(seriesId, anchorId))).toBeNull();
      expect(await insert(app, 'regular_price_records', pendingRow(seriesId, anchorId))).toBe(
        '23505',
      );
    });
  });

  describe('regular_price_records: effective periods never overlap (PD1, P7, M1)', () => {
    it('refuses an overlap (23P01), accepts adjacent periods, ignores records out of force', async () => {
      const seriesId = await newSeries();
      const first = await newRecord(seriesId);
      expect(
        await insert(
          app,
          'regular_price_records',
          recordRow(seriesId, { effective_from: at(5), submitted_at: at(5) }),
        ),
      ).toBe('23P01');
      // Pending, superseded and rejected rows are outside the constraint.
      expect(await insert(app, 'regular_price_records', pendingRow(seriesId, first))).toBeNull();

      // Shrink, then grow: close the open period, then insert the next one at its end.
      expect(await update(app, first, 'effective_to = $1', [at(5)])).toBeNull();
      expect(
        await insert(
          app,
          'regular_price_records',
          recordRow(seriesId, { effective_from: at(5), submitted_at: at(5) }),
        ),
      ).toBeNull();
    });

    it('refuses approving before closing the period in force, and accepts close-then-approve', async () => {
      const seriesId = await newSeries();
      const first = await newRecord(seriesId);
      const pending = pendingRow(seriesId, first);
      expect(await insert(app, 'regular_price_records', pending)).toBeNull();
      const approve = `status = 'approved', effective_from = $1, decided_at = $1, decided_by_account_id = '${decider}'`;

      expect(await update(app, pending.id, approve, [at(20)])).toBe('23P01');
      expect(await update(app, first, 'effective_to = $1', [at(20)])).toBeNull();
      expect(await update(app, pending.id, approve, [at(20)])).toBeNull();
    });

    it('keeps the same instants apart in different series and Markets', async () => {
      const one = await newSeries();
      const two = await newSeries();
      await newRecord(one);
      await newRecord(two);
    });
  });

  describe('regular_price_records: write-once trigger and no delete (P5, P6)', () => {
    let seriesId: string;
    let closed: string;
    let open: string;
    let rejected: string;
    beforeAll(async () => {
      seriesId = await newSeries();
      closed = await newRecord(seriesId, { effective_to: at(5) });
      open = await newRecord(seriesId, { effective_from: at(5), submitted_at: at(5) });
      const row = pendingRow(seriesId, closed, {
        status: 'rejected',
        decided_at: at(11),
        decided_by_account_id: decider,
        decision_reason_code: 'too-high',
      });
      expect(await insert(app, 'regular_price_records', row)).toBeNull();
      rejected = row.id;
    });

    it.each([
      ['the application', () => app],
      ['the owner', () => owner],
    ])('refuses, as %s, every move that D 3 does not list (23001)', async (_who, client) => {
      const c = client();
      // A final status is final; accepted is never superseded.
      expect(
        await update(c, rejected, `status = 'approved', effective_from = $1, decided_at = $1`, [
          at(12),
        ]),
      ).toBe('23001');
      expect(
        await update(
          c,
          open,
          `status = 'superseded', superseded_at = $1, supersede_cause = 'cancelled', effective_from = NULL`,
          [at(12)],
        ),
      ).toBe('23001');
      // A written-once column is never rewritten nor reopened.
      expect(await update(c, closed, 'effective_to = $1', [at(6)])).toBe('23001');
      expect(await update(c, closed, 'effective_to = NULL')).toBe('23001');
      // A decision column changes only with the status: no note added later.
      expect(await update(c, rejected, `decision_note = 'later'`)).toBe('23001');
    });

    it('lets only the owner reach the content columns, and refuses them too (23001)', async () => {
      expect(await update(app, open, 'amount_minor = 1')).toBe('42501');
      expect(await update(owner, open, 'amount_minor = 1')).toBe('23001');
      expect(await update(owner, open, `submitted_at = $1`, [at(1)])).toBe('23001');
      expect(
        await update(
          owner,
          open,
          'anchor_record_id = $1, anchor_amount_minor = 1000, hold_direction = NULL',
          [closed],
        ),
      ).toBe('23001');
    });

    it('refuses DELETE and TRUNCATE: 42501 for the application, 23001 for the owner', async () => {
      const where = `WHERE market_id = '${code}' AND id = $1`;
      expect(
        await sqlState(app, `DELETE FROM pricing.regular_price_records ${where}`, [open]),
      ).toBe('42501');
      expect(
        await sqlState(owner, `DELETE FROM pricing.regular_price_records ${where}`, [open]),
      ).toBe('23001');
      expect(await sqlState(app, 'TRUNCATE pricing.regular_price_records')).toBe('42501');
      expect(await sqlState(owner, 'TRUNCATE pricing.regular_price_records CASCADE')).toBe('23001');
    });
  });

  describe('tombstones, outbox and inbox', () => {
    it('keeps tombstones insert-only for the application (42501)', async () => {
      const offerId = ids.next();
      const row = {
        market_id: code,
        tenant_id: 'default',
        offer_id: offerId,
        retired_at: at(0),
        cause_event_id: ids.next(),
      };
      expect(await insert(app, 'retired_offers', row)).toBeNull();
      expect(await insert(app, 'retired_offers', row)).toBe('23505');
      const where = `WHERE market_id = '${code}' AND offer_id = $1`;
      expect(
        await sqlState(app, `UPDATE pricing.retired_offers SET retired_at = now() ${where}`, [
          offerId,
        ]),
      ).toBe('42501');
      expect(await sqlState(app, `DELETE FROM pricing.retired_offers ${where}`, [offerId])).toBe(
        '42501',
      );
      expect(
        await sqlState(app, `DELETE FROM pricing.retired_variants WHERE market_id = '${code}'`),
      ).toBe('42501');
    });

    it("refuses another module's event type and handler name (23514)", async () => {
      const event = {
        event_id: ids.next(),
        type: 'catalog.offer-deleted.v1',
        occurred_at: at(0),
        market_id: code,
        tenant_id: 'default',
        aggregate_type: 'price-series',
        aggregate_id: ids.next(),
        aggregate_version: 1,
        correlation_id: 'pricing-db-test-0001',
        payload: {},
      };
      expect(await insert(app, 'outbox', event)).toBe('23514');
      expect(
        await insert(app, 'outbox', { ...event, type: 'pricing.effective-price-changed.v1' }),
      ).toBeNull();
      const handled = {
        event_id: ids.next(),
        market_id: code,
        tenant_id: 'default',
        processed_at: at(0),
      };
      expect(await insert(app, 'inbox', { ...handled, handler: 'catalog.retire' })).toBe('23514');
      expect(
        await insert(app, 'inbox', {
          ...handled,
          handler: 'pricing.retire-series-for-removed-offer',
        }),
      ).toBeNull();
    });
  });

  describe('write-refusal counters (3.8; D 5.2, H3, M7)', () => {
    const market = marketOf(code);
    let persistence: Persistence;
    let throttles: PrismaWriteRefusalThrottleRepository;
    beforeAll(() => {
      persistence = createPersistence();
      throttles = new PrismaWriteRefusalThrottleRepository(persistence.service);
    });
    afterAll(() => persistence.close());

    const inUnit = <T>(work: () => Promise<T>, target: MarketContext = market) =>
      persistence.unitOfWork
        .run(target, async () => ok(await work()))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });
    const MINUTE = 60_000;
    const t = (seconds: number) => T0.add({ seconds });

    it('lets one refusal per (actor, Offer) per minute through, per Market', async () => {
      const actor = ids.next<'Account'>();
      const offer = ids.next<'Offer'>();
      const claim = (s: number, target = market) =>
        inUnit(() => throttles.claimOfferWindow(target, actor, offer, t(s), MINUTE), target);

      expect(await claim(0)).toBe(true);
      expect(await claim(30)).toBe(false);
      expect(await claim(59)).toBe(false);
      expect(await claim(60)).toBe(true);
      expect(await claim(61)).toBe(false);
      expect(
        await inUnit(() =>
          throttles.claimOfferWindow(market, actor, ids.next<'Offer'>(), t(61), MINUTE),
        ),
      ).toBe(true);
      const other = marketOf(otherCode);
      expect(await claim(61, other)).toBe(true);
    });

    it('caps an actor across Offers: record up to the cap, one summary, then nothing, per window', async () => {
      const actor = ids.next<'Account'>();
      const count = (s: number) =>
        inUnit(() => throttles.countActorRefusal(market, actor, t(s), MINUTE, 2));

      expect([
        await count(0),
        await count(1),
        await count(2),
        await count(3),
        await count(4),
      ]).toEqual(['record', 'record', 'summarise', 'suppress', 'suppress']);
      expect(await count(60)).toBe('record');
      const { rows } = await app.query(
        `SELECT recorded_count, suppressed_count FROM pricing.write_refusal_actor_throttles
          WHERE market_id = $1 AND actor_account_id = $2`,
        [code, actor],
      );
      expect(rows).toEqual([{ recorded_count: 1, suppressed_count: 0 }]);
    });

    it('rolls a counter back with its unit, so it never advances without the unit (M7)', async () => {
      const actor = ids.next<'Account'>();
      const offer = ids.next<'Offer'>();
      const failed = await persistence.unitOfWork.run(market, async () => {
        await throttles.claimOfferWindow(market, actor, offer, t(0), MINUTE);
        await throttles.countActorRefusal(market, actor, t(0), MINUTE, 20);
        return { ok: false as const, error: 'rolled back' };
      });

      expect(failed.ok).toBe(false);
      expect(
        await inUnit(() => throttles.claimOfferWindow(market, actor, offer, t(1), MINUTE)),
      ).toBe(true);
      expect(await inUnit(() => throttles.countActorRefusal(market, actor, t(1), MINUTE, 20))).toBe(
        'record',
      );
    });

    it('purges counters whose window started before the horizon, in this Market only', async () => {
      const actor = ids.next<'Account'>();
      await inUnit(() =>
        throttles.claimOfferWindow(market, actor, ids.next<'Offer'>(), t(-7200), MINUTE),
      );
      await inUnit(() => throttles.countActorRefusal(market, actor, t(-7200), MINUTE, 20));

      expect(
        await inUnit(() => throttles.purgeStartedBefore(market, t(-3600))),
      ).toBeGreaterThanOrEqual(2);
      const { rows } = await app.query(
        `SELECT 1 FROM pricing.write_refusal_actor_throttles WHERE market_id = $1 AND actor_account_id = $2`,
        [code, actor],
      );
      expect(rows).toEqual([]);
    });

    it('gives the application only the counter columns to update (42501 otherwise)', async () => {
      expect(
        await sqlState(
          app,
          `UPDATE pricing.write_refusal_throttles SET offer_id = $1 WHERE market_id = '${code}'`,
          [ids.next()],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          app,
          `UPDATE pricing.write_refusal_actor_throttles SET actor_account_id = $1 WHERE market_id = '${code}'`,
          [ids.next()],
        ),
      ).toBe('42501');
      expect(
        await insert(app, 'write_refusal_actor_throttles', {
          market_id: code,
          tenant_id: 'default',
          actor_account_id: ids.next(),
          window_started_at: at(0),
          recorded_count: -1,
          suppressed_count: 0,
        }),
      ).toBe('23514');
    });
  });
});
