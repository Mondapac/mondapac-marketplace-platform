import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { SignInRecord } from '../../src/modules/identity/application/ports/sign-in-record.repository';
import { PrismaSignInRecordRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-sign-in-record.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// A customer's sign-in records for the customer page (customers management phase 2b) on
// PostgreSQL, as the application role, for both Market fixtures: the new `device` column and its
// check, the page and count of one customer's records (own account, customer population, range,
// result filter, never the address), and the address read of one record within 90 days.

const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');

describe('customer sign-in records (database integration)', () => {
  let db: Persistence;
  let records: PrismaSignInRecordRepository;
  let pg: Client;

  beforeAll(async () => {
    db = createPersistence();
    records = new PrismaSignInRecordRepository(db.service);
    pg = new Client({ connectionString: testDatabaseUrl() });
    await pg.connect();
  });
  afterAll(async () => {
    await pg.end();
    await db.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const accountId = randomUUID() as Id<'Account'>;

    const record = (overrides: Partial<SignInRecord> = {}): SignInRecord => ({
      id: randomUUID() as Id<'SignInRecord'>,
      population: 'customer',
      accountId,
      outcome: 'signed-in',
      occurredAt: NOW.subtract({ hours: 1 }),
      address: '198.51.100.20',
      sessionId: null,
      correlationId: 'correlation-1',
      device: 'chrome.windows',
      ...overrides,
    });
    const add = (m: typeof market, r: SignInRecord) =>
      db.unitOfWork.run(m, async () => {
        await records.add(m, r);
        return ok(undefined);
      });
    const read = <T>(m: typeof market, work: () => Promise<T>) =>
      db.unitOfWork.run(m, async () => ok(await work()), { readOnly: true });

    const success = record();
    const failure = record({
      outcome: 'password.incorrect',
      occurredAt: NOW.subtract({ hours: 2 }),
      device: null,
    });
    const reset = record({ outcome: 'password-reset', occurredAt: NOW.subtract({ hours: 3 }) });
    const old = record({ occurredAt: NOW.subtract({ hours: 24 * 100 }) });
    const seller = record({ population: 'seller' });
    const foreign = record({ id: randomUUID() as Id<'SignInRecord'> });

    beforeAll(async () => {
      for (const r of [success, failure, reset, old, seller]) await add(market, r);
      await add(other, foreign);
    });

    const query = (results: null | ('success' | 'failure' | 'credential-change')[]) => ({
      accountId,
      results,
      from: NOW.subtract({ hours: 24 * 90 }),
      to: null,
    });

    it('pages one customer’s own records of the range, newest first, by result', async () => {
      const page = await read(market, () =>
        records.pageOfCustomer(market, query(null), 'desc', { offset: 0, limit: 10 }),
      );
      expect(page.ok && page.value.map((r) => [r.id, r.outcome, r.device])).toEqual([
        [success.id, 'signed-in', 'chrome.windows'],
        [failure.id, 'password.incorrect', null],
        [reset.id, 'password-reset', 'chrome.windows'],
      ]);
      expect(JSON.stringify(page)).not.toContain('198.51.100');
      const failures = await read(market, () =>
        records.countOfCustomer(market, query(['failure'])),
      );
      expect(failures).toEqual({ ok: true, value: 1 });
      const changes = await read(market, () =>
        records.pageOfCustomer(market, query(['success', 'credential-change']), 'asc', {
          offset: 0,
          limit: 10,
        }),
      );
      expect(changes.ok && changes.value.map((r) => r.id)).toEqual([reset.id, success.id]);
      const elsewhere = await read(other, () => records.countOfCustomer(other, query(null)));
      expect(elsewhere).toEqual({ ok: true, value: 1 });
    });

    it('reads the address of the customer’s own record of the window only', async () => {
      const since = NOW.subtract({ hours: 24 * 90 });
      const found = await read(market, () =>
        records.customerAddressOf(market, accountId, success.id, since),
      );
      expect(found).toEqual({
        ok: true,
        value: { address: '198.51.100.20', occurredAt: success.occurredAt },
      });
      for (const id of [old.id, seller.id, foreign.id]) {
        const none = await read(market, () =>
          records.customerAddressOf(market, accountId, id, since),
        );
        expect(none).toEqual({ ok: true, value: null });
      }
    });

    it('refuses a device that is not a code pair', async () => {
      await expect(
        pg.query(
          `INSERT INTO identity.sign_in_records
             (id, market_id, tenant_id, population, account_id, outcome, occurred_at, origin, correlation_id, device)
           VALUES ($1, $2, $3, 'customer', $4, 'signed-in', now(), '198.51.100.1', 'correlation-1', 'Mozilla/5.0')`,
          [randomUUID(), market.marketId, market.tenantId, accountId],
        ),
      ).rejects.toThrow(/sign_in_records_device_check/);
    });
  });
});
