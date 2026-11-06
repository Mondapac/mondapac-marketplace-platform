import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import {
  SELLERS_AUDIT_ACTIONS,
  StoreImageChanged,
  StoreProfileSaved,
} from '../../src/modules/sellers/domain/audit';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import {
  AuditReadRefusedError,
  type AuditTrailReader,
} from '../../src/platform/audit/audit-trail-reader';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// `AuditTrailReader.historyOf` (several of a module's own actions, one target or the whole
// Market) over the real audit writer on PostgreSQL, as the application role, for both Market
// fixtures: newest first, keyset paging, the target filter, the Market boundary and the refusals.

const T0 = Temporal.Instant.from('2026-10-15T01:00:00Z');
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKETS)('the audit trail multi-action history in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const catalogue = new AuditActionCatalogue();
  catalogue.register('sellers', SELLERS_AUDIT_ACTIONS);
  catalogue.seal();
  const audit = PersistenceModule.auditWriterFor('sellers').useFactory(
    catalogue,
    ids,
    clock,
    NO_PERMISSION_KEYS,
  ) as AuditWriter;
  const reader = PersistenceModule.auditTrailReaderFor('sellers').useFactory(
    catalogue,
  ) as AuditTrailReader;
  let db: Persistence;

  beforeAll(() => {
    db = createPersistence();
  });
  afterAll(async () => {
    await db.close();
  });

  const contextOf = (sellerId: Id<'Seller'>, m = market) =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'seller',
        accountId: ACCOUNT,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  const write = async (
    sellerId: Id<'Seller'>,
    entry: Parameters<AuditWriter['record']>[1],
    m = market,
  ) => {
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    const done = await db.unitOfWork.run(m, async () => {
      await audit.record(contextOf(sellerId, m), entry);
      return ok(undefined);
    });
    if (!done.ok) throw new Error('unreachable');
  };
  const saved = (sellerId: Id<'Seller'>) =>
    StoreProfileSaved.entry(sellerId, {
      after: { revisionId: ids.next<'Revision'>(), revisionNo: 1 },
    });
  const image = (sellerId: Id<'Seller'>) =>
    StoreImageChanged.entry(sellerId, {
      before: { imageId: null },
      after: { kind: 'logo', imageId: ids.next<'Image'>() },
    });
  const read = (scope: Parameters<AuditTrailReader['historyOf']>[1], m = market) =>
    db.unitOfWork.run(
      m,
      async () => {
        const result = await reader.historyOf(m, scope);
        return ok(result);
      },
      { readOnly: true },
    );

  const ACTIONS = [StoreProfileSaved.action, StoreImageChanged.action];

  it('reads both actions of one target newest first, and pages with the row id', async () => {
    const seller = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    await write(seller, saved(seller));
    await write(otherSeller, saved(otherSeller));
    await write(seller, image(seller));
    await write(seller, saved(seller));

    const first = await read({ actions: ACTIONS, targetId: seller, after: null, limit: 2 });
    expect(first.ok && first.value.ok).toBe(true);
    const page = first.ok && first.value.ok ? first.value.value : [];
    expect(page.map((row) => row.action)).toEqual([
      StoreProfileSaved.action,
      StoreImageChanged.action,
    ]);
    expect(page.every((row) => row.targetId === seller && row.actorId === ACCOUNT)).toBe(true);
    expect(page[0]!.occurredAt.epochMilliseconds).toBeGreaterThan(
      page[1]!.occurredAt.epochMilliseconds,
    );

    const next = await read({ actions: ACTIONS, targetId: seller, after: page[1]!.id, limit: 2 });
    const rest = next.ok && next.value.ok ? next.value.value : [];
    expect(rest.map((row) => row.action)).toEqual([StoreProfileSaved.action]);
  });

  it('reads every target of the actions of the Market when the target is null, and only that Market', async () => {
    const seller = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    await write(seller, saved(seller));
    await write(otherSeller, saved(otherSeller));
    await write(seller, saved(seller), other);

    const here = await read({ actions: ACTIONS, targetId: null, after: null, limit: 100 });
    const targets = (here.ok && here.value.ok ? here.value.value : []).map((row) => row.targetId);
    expect(targets).toEqual(expect.arrayContaining([seller, otherSeller]));

    const there = await read(
      { actions: ACTIONS, targetId: otherSeller, after: null, limit: 100 },
      other,
    );
    expect(there.ok && there.value).toEqual({ ok: true, value: [] });
  });

  it('answers cursor.unknown for a row of another target, and refuses actions that are not its own', async () => {
    const seller = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    await write(seller, saved(seller));
    await write(otherSeller, saved(otherSeller));
    const theirs = await read({ actions: ACTIONS, targetId: otherSeller, after: null, limit: 1 });
    const cursor = theirs.ok && theirs.value.ok ? theirs.value.value[0]!.id : '';

    const stray = await read({ actions: ACTIONS, targetId: seller, after: cursor, limit: 5 });
    expect(stray.ok && stray.value).toEqual({ ok: false, error: { code: 'cursor.unknown' } });

    await expect(
      read({ actions: ['identity.account-role.assigned'], targetId: null, after: null, limit: 5 }),
    ).rejects.toBeInstanceOf(AuditReadRefusedError);
    await expect(
      read({ actions: [], targetId: null, after: null, limit: 5 }),
    ).rejects.toBeInstanceOf(AuditReadRefusedError);
    await expect(
      read({ actions: ACTIONS, targetId: null, after: null, limit: 101 }),
    ).rejects.toBeInstanceOf(AuditReadRefusedError);
  });
});
