import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { SystemRequestsModule } from '../../src/modules/system-requests';
import {
  POLICY_REPOSITORY,
  type PolicyRepository,
} from '../../src/modules/system-requests/application/ports/policy.repository';
import {
  REQUEST_REPOSITORY,
  type NewRequest,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// System requests (Admin Inbox › System requests): the request repository in a real unit (the
// per-Market counter, supersession, decisions, the list's filters, keyset and search) and the
// migration `system_requests_core` (CHECKs including maker-checker, the decision guard, the
// no-delete triggers and the column grants). Every case runs for both Market fixtures.

const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const nowMs = () => Temporal.Instant.fromEpochMilliseconds(Date.now());
const account = () => randomUUID() as Id<'Account'>;

describe('system requests (database integration)', () => {
  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let requests: RequestRepository;
  let policy: PolicyRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    app = await moduleRef.init();
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const module = app.select(SystemRequestsModule);
    requests = module.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
    policy = module.get<PolicyRepository>(POLICY_REPOSITORY, { strict: true });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
  });

  const inUnit = <T>(market: ReturnType<typeof marketOf>, work: () => Promise<T>) =>
    unitOfWork.run(market, async () => ok(await work()));
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new Error(`unit failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };

  const newRequest = (fields: Partial<NewRequest> = {}): NewRequest => {
    const appliedAt = nowMs();
    return {
      id: randomUUID() as Id<'SystemRequest'>,
      area: 'catalogue',
      subjectKind: 'settings.market-setting',
      subjectRef: `ref-${randomUUID()}`,
      risk: 'medium',
      before: { size: 25 },
      after: { size: 50 },
      note: 'Raise the limit',
      requestedBy: account(),
      appliedAt,
      reviewDueAt: appliedAt.add({ hours: 7 * 24 }),
      ...fields,
    };
  };

  const open = (market: ReturnType<typeof marketOf>, request: NewRequest) =>
    inUnit(market, () =>
      requests.open(market, request, randomUUID() as Id<'SystemRequestActivity'>),
    ).then(value);

  describe.each(TEST_MARKETS.map((code) => [code]))('in market %s', (code) => {
    const market = marketOf(code);

    it('numbers the openings of a Market one after another and supersedes earlier requests', async () => {
      const first = newRequest();
      const opened = await open(market, first);
      const second = newRequest({ subjectRef: first.subjectRef, before: { size: 50 } });
      const next = await open(market, second);
      expect(next.number).toBeGreaterThan(opened.number);
      expect(next.superseded).toEqual([first.id]);
      const stored = value(await inUnit(market, () => requests.find(market, first.id)));
      expect(stored).toMatchObject({ status: 'open', supersededBy: second.id, commentCount: 0 });
      const lines = value(await inUnit(market, () => requests.activity(market, first.id)));
      expect(lines.map((line) => line.kind)).toEqual(['applied']);
      // The other Market sees neither.
      const otherMarket = marketOf(TEST_MARKETS.find((c) => c !== code)!);
      expect(
        value(await inUnit(otherMarket, () => requests.find(otherMarket, first.id))),
      ).toBeNull();
    });

    it('writes a decision once, and the database keeps it', async () => {
      const request = newRequest();
      await open(market, request);
      const decider = account();
      const decided = value(
        await inUnit(market, async () => {
          const locked = await requests.findForUpdate(market, request.id);
          expect(locked?.status).toBe('open');
          return requests.decide(market, request.id, {
            status: 'approved',
            decision: 'approved',
            decidedBy: decider,
            decidedAt: nowMs(),
            reason: null,
          });
        }),
      );
      expect(decided).toBe(true);
      const again = value(
        await inUnit(market, () =>
          requests.decide(market, request.id, {
            status: 'reverted',
            decision: 'rejected',
            decidedBy: decider,
            decidedAt: nowMs(),
            reason: 'late',
          }),
        ),
      );
      expect(again).toBe(false);
      expect(
        await sqlState(
          sql,
          `UPDATE system_requests.requests SET status = 'reverted', decision = 'rejected',
             decision_reason = 'x' WHERE id = $1`,
          [request.id],
        ),
      ).toBe(RESTRICT_VIOLATION);
      // A decided request may still be superseded and commented on.
      const later = newRequest({ subjectRef: request.subjectRef });
      expect((await open(market, later)).superseded).toEqual([request.id]);
      expect(
        value(
          await inUnit(market, () =>
            requests.addComment(market, request.id, {
              id: randomUUID() as Id<'SystemRequestActivity'>,
              kind: 'commented',
              actor: decider,
              at: nowMs(),
              body: 'Looked fine',
            }),
          ),
        ),
      ).toBe(1);
      expect(
        await sqlState(
          sql,
          'UPDATE system_requests.requests SET superseded_by_request_id = NULL WHERE id = $1',
          [request.id],
        ),
      ).toBe(RESTRICT_VIOLATION);
    });

    it('releases a supersession only once the newer request is reverted', async () => {
      const first = newRequest();
      await open(market, first);
      const second = newRequest({ subjectRef: first.subjectRef });
      await open(market, second);
      // While the newer request is open, the database refuses the release.
      await expect(inUnit(market, () => requests.release(market, second.id))).rejects.toThrow();
      expect(value(await inUnit(market, () => requests.find(market, first.id)))?.supersededBy).toBe(
        second.id,
      );
      const released = value(
        await inUnit(market, async () => {
          const written = await requests.decide(market, second.id, {
            status: 'reverted',
            decision: 'withdrawn',
            decidedBy: second.requestedBy,
            decidedAt: nowMs(),
            reason: 'Undo',
          });
          expect(written).toBe(true);
          return requests.release(market, second.id);
        }),
      );
      expect(released).toEqual([first.id]);
      expect(
        value(await inUnit(market, () => requests.find(market, first.id)))?.supersededBy,
      ).toBeNull();
      // Pointing a supersession anywhere else stays refused.
      const third = newRequest({ subjectRef: first.subjectRef });
      await open(market, third);
      expect(
        await sqlState(
          sql,
          'UPDATE system_requests.requests SET superseded_by_request_id = $2 WHERE id = $1',
          [first.id, second.id],
        ),
      ).toBe(RESTRICT_VIOLATION);
    });

    it('refuses an author deciding their own request (maker-checker CHECK)', async () => {
      const request = newRequest();
      await open(market, request);
      const own = await inUnit(market, () =>
        requests.decide(market, request.id, {
          status: 'approved',
          decision: 'approved',
          decidedBy: request.requestedBy,
          decidedAt: nowMs(),
          reason: null,
        }),
      ).catch((error: unknown) => error);
      expect(String((own as { message?: unknown })?.message ?? own)).toMatch(
        /requests_.*check|23514|constraint/i,
      );
      // Withdrawn is the author's own decision; anyone else withdrawing is refused.
      expect(
        await sqlState(
          sql,
          `UPDATE system_requests.requests SET status = 'reverted', decision = 'withdrawn',
             decided_by_account_id = $2, decided_at = now(), decision_reason = 'x' WHERE id = $1`,
          [request.id, account()],
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('lists by filters, keyset and a literal search', async () => {
      const author = account();
      const marker = randomUUID().slice(0, 8);
      const made: NewRequest[] = [];
      for (let n = 0; n < 5; n += 1) {
        const request = newRequest({
          requestedBy: author,
          note: n === 2 ? `cut 50% for ${marker}` : `note ${marker} ${n}`,
          risk: n % 2 === 0 ? 'low' : 'high',
          appliedAt: nowMs().add({ milliseconds: n }),
        });
        made.push(request);
        await open(market, request);
      }
      const filter = { requestedBy: author };
      const count = value(await inUnit(market, () => requests.count(market, filter, 10_000)));
      expect(count).toBe(5);
      expect(value(await inUnit(market, () => requests.count(market, filter, 3)))).toBe(3);
      const highs = value(
        await inUnit(market, () =>
          requests.page(market, { ...filter, risks: ['high'] }, 'applied', 'asc', {
            kind: 'offset',
            offset: 0,
            limit: 10,
          }),
        ),
      );
      expect(highs.map((row) => row.id)).toEqual([made[1]!.id, made[3]!.id]);

      const seen: string[] = [];
      let after: { value: Temporal.Instant | number; number: number } | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const page = value(
          await inUnit(market, () =>
            requests.page(market, filter, 'number', 'desc', { kind: 'keyset', after, limit: 2 }),
          ),
        );
        if (page.length === 0) break;
        seen.push(...page.map((row) => row.id));
        const last = page[page.length - 1]!;
        after = { value: last.number, number: last.number };
      }
      expect(seen).toEqual([...made].reverse().map((request) => request.id));

      // `%` and `_` are text: "50%" finds the one note, "5_%" finds nothing.
      const percent = value(
        await inUnit(market, () =>
          requests.count(market, { ...filter, text: `50% FOR ${marker.toUpperCase()}` }, 100),
        ),
      );
      expect(percent).toBe(1);
      const wildcard = value(
        await inUnit(market, () => requests.count(market, { ...filter, text: '5_%' }, 100)),
      );
      expect(wildcard).toBe(0);
    });

    it('stores the policy with a version check', async () => {
      // Another spec may hold this Market's policy rows; work from what is there.
      const current = value(await inUnit(market, () => policy.area(market, 'content')));
      const version = (current?.version ?? 0) + 1;
      const by = account();
      const written = value(
        await inUnit(market, () =>
          policy.setArea(
            market,
            'content',
            { enabled: true, risk: 'low' },
            {
              version,
              at: nowMs(),
              by,
            },
          ),
        ),
      );
      expect(written).toBe(true);
      const stale = value(
        await inUnit(market, () =>
          policy.setArea(
            market,
            'content',
            { enabled: false, risk: 'low' },
            {
              version,
              at: nowMs(),
              by,
            },
          ),
        ),
      );
      expect(stale).toBe(false);
      expect(value(await inUnit(market, () => policy.area(market, 'content')))).toMatchObject({
        enabled: true,
        version,
        updatedBy: by,
      });
    });
  });

  describe('migration rules', () => {
    const market = marketOf(TEST_MARKETS[0]);

    it('refuses deletes for the application and the owner alike', async () => {
      const request = newRequest();
      await open(market, request);
      expect(
        await sqlState(sql, 'DELETE FROM system_requests.requests WHERE id = $1', [request.id]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlState(owner, 'DELETE FROM system_requests.requests WHERE id = $1', [request.id]),
      ).toBe(RESTRICT_VIOLATION);
      expect(
        await sqlState(
          owner,
          'DELETE FROM system_requests.request_activity WHERE request_id = $1',
          [request.id],
        ),
      ).toBe(RESTRICT_VIOLATION);
      expect(
        await sqlState(
          owner,
          "UPDATE system_requests.request_activity SET body = 'x' WHERE request_id = $1",
          [request.id],
        ),
      ).toBe(RESTRICT_VIOLATION);
    });

    it('lets the application change only the decision columns of a request', async () => {
      const request = newRequest();
      await open(market, request);
      expect(
        await sqlState(sql, "UPDATE system_requests.requests SET note = 'edited' WHERE id = $1", [
          request.id,
        ]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlState(sql, "UPDATE system_requests.requests SET risk = 'low' WHERE id = $1", [
          request.id,
        ]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('checks the shape of a request', async () => {
      const insert = (fields: Record<string, unknown>) => {
        const row = {
          id: randomUUID(),
          market_id: market.marketId,
          tenant_id: PLATFORM_TENANT_ID,
          number: 900_000_000 + Math.floor(Math.random() * 90_000_000),
          area: 'catalogue',
          subject_kind: 'settings.market-setting',
          subject_ref: 'x',
          risk: 'medium',
          status: 'open',
          before: '{}',
          after: '{"a":1}',
          note: 'n',
          requested_by_account_id: randomUUID(),
          applied_at: new Date().toISOString(),
          review_due_at: new Date(Date.now() + 86_400_000).toISOString(),
          ...fields,
        };
        const columns = Object.keys(row);
        return sqlState(
          owner,
          `INSERT INTO system_requests.requests (${columns.join(', ')})
           VALUES (${columns.map((_, n) => `$${n + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      expect(await insert({ area: 'everything' })).toBe(CHECK_VIOLATION);
      expect(await insert({ risk: 'extreme' })).toBe(CHECK_VIOLATION);
      expect(await insert({ subject_kind: 'NoDot' })).toBe(CHECK_VIOLATION);
      expect(await insert({ subject_ref: 'bad key' })).toBe(CHECK_VIOLATION);
      expect(await insert({ before: '[]' })).toBe(CHECK_VIOLATION);
      expect(await insert({ note: '' })).toBe(CHECK_VIOLATION);
      expect(await insert({ review_due_at: new Date(0).toISOString() })).toBe(CHECK_VIOLATION);
      expect(await insert({ status: 'approved' })).toBe(CHECK_VIOLATION);
      expect(await insert({})).toBeNull();
    });
  });
});
