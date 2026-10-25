import { randomBytes, randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { IdentityModule } from '../../src/modules/identity';
import { AccountDisabledAudit } from '../../src/modules/identity/domain/audit';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { PrismaRoot } from '../../src/platform/persistence/prisma-root';
import {
  SignInFailed,
  SignInSucceeded,
  StripeWebhookSignatureFailed,
} from '../../src/platform/security-events/security-event-catalogue';
import { SecurityEventRetention } from '../../src/platform/security-events/security-event-retention';
import {
  SECURITY_EVENTS,
  SecurityEventRefusedError,
  type SecurityEvents,
} from '../../src/platform/security-events/security-events';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// SOC package 1 (docs/design/data/platform.md 13): the recorder in a real unit,
// the projection of audited actions, the migration `platform_security_events` (CHECKs,
// insert-only triggers with their retention floors, grants) and the retention job's store.
// Every case runs for both Market fixtures.

const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';

/** A recorder of identity and one of payments, as their modules bind them. */
@Module({
  providers: [PersistenceModule.securityEventsFor('identity')],
  exports: [SECURITY_EVENTS],
})
class IdentityEventsTestModule {}

@Module({
  providers: [PersistenceModule.securityEventsFor('payments')],
  exports: [SECURITY_EVENTS],
})
class PaymentsEventsTestModule {}

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const correlation = () => `secev-db-${randomBytes(8).toString('hex')}`;
const newId = <K extends string = string>() => uuidV7(Date.now(), randomBytes(10)) as Id<K>;
/** The real time in whole milliseconds: the triggers' floors read the database clock. */
const nowMs = () => Temporal.Instant.fromEpochMilliseconds(Date.now());

/** Runs one statement in a transaction that is always rolled back; answers its SQLSTATE. */
async function sqlStateOf(client: Client, statement: string, values: unknown[] = []) {
  await client.query('BEGIN');
  try {
    await client.query(statement, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('platform security events (database integration, SOC package 1)', () => {
  const clock = new FixedClock(nowMs());
  let app: INestApplicationContext;
  let identityEvents: SecurityEvents;
  let paymentsEvents: SecurityEvents;
  let identityAudit: AuditWriter;
  let unitOfWork: UnitOfWork;
  let retention: SecurityEventRetention;
  let root: PrismaRoot;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
        IdentityEventsTestModule,
        PaymentsEventsTestModule,
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = await moduleRef.init();
    identityEvents = app.select(IdentityEventsTestModule).get(SECURITY_EVENTS, { strict: true });
    paymentsEvents = app.select(PaymentsEventsTestModule).get(SECURITY_EVENTS, { strict: true });
    identityAudit = app.select(IdentityModule).get<AuditWriter>(AUDIT_WRITER, { strict: true });
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    retention = app.get(SecurityEventRetention);
    root = app.get(PrismaRoot);
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

  const eventsOf = (correlationId: string) =>
    root.securityEvent.findMany({ where: { correlationId }, orderBy: { id: 'asc' } });

  /** An event row inserted as `client`, `days` before the real time. */
  async function eventAt(
    marketId: string,
    days: number,
    table: 'security_events' | 'security_events_archive',
    client: Client = owner,
  ) {
    const id = randomUUID();
    const at = new Date(Date.now() - days * 86_400_000);
    at.setUTCMilliseconds(0);
    const archived = table === 'security_events_archive';
    await client.query(
      `INSERT INTO platform.${table}
         (id, market_id, tenant_id, occurred_at, type, severity, actor_type, payload,
          correlation_id${archived ? ', archived_at' : ''})
       VALUES ($1, $2, $3, $4, 'identity.sign-in.failed', 's4', 'ANONYMOUS', '{}',
               'secev-db-retention'${archived ? ', $4' : ''})`,
      [id, marketId, PLATFORM_TENANT_ID, at.toISOString()],
    );
    return id;
  }

  describe.each(TEST_MARKETS)('Market %s', (code) => {
    const market = marketOf(code);
    const account = () => newId<'Account'>();

    it('records an event in the caller unit: actor, Market, severity, address and payload', async () => {
      const correlationId = correlation();
      const context = testCallContext(market, 'anonymous', correlationId);
      const accountId = account();
      const sessionId = newId<'Session'>();
      await unitOfWork.run(market, async () => {
        await identityEvents.record(
          context,
          SignInSucceeded.event({
            targetId: accountId,
            ip: '2001:db8::1',
            payload: { population: 'customer', sessionId },
          }),
        );
        return ok(undefined);
      });

      const [row, ...rest] = await eventsOf(correlationId);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        marketId: code,
        tenantId: PLATFORM_TENANT_ID,
        type: 'identity.sign-in.succeeded',
        severity: 's4',
        actorType: 'ANONYMOUS',
        actorId: null,
        targetType: 'account',
        targetId: accountId,
        ip: '2001:db8::1',
        payload: { population: 'customer', sessionId },
        correlationId,
      });
      expect(row!.occurredAt.getTime()).toBe(clock.now().epochMilliseconds);
    });

    it('commits nothing when the unit rolls back', async () => {
      const correlationId = correlation();
      const context = testCallContext(market, 'anonymous', correlationId);
      const result = await unitOfWork.run(market, async () => {
        await identityEvents.record(
          context,
          SignInFailed.event({
            ip: '192.0.2.10',
            payload: { population: 'seller', reason: 'credentials-invalid' },
          }),
        );
        return err('rolled-back');
      });
      expect(result).toEqual(err('rolled-back'));
      expect(await eventsOf(correlationId)).toEqual([]);
    });

    it('refuses outside a read-write unit, another owner, and input outside the definition', async () => {
      const context: CallContext = testCallContext(market, 'anonymous', correlation());
      const failed = SignInFailed.event({
        ip: '192.0.2.10',
        payload: { population: 'admin', reason: 'link-rejected' },
      });
      const refusal = async (events: SecurityEvents, event: unknown) => {
        try {
          await unitOfWork.run(market, async () => {
            await events.record(context, event as never);
            return ok(undefined);
          });
          return null;
        } catch (error) {
          return error instanceof SecurityEventRefusedError ? error.reason : 'other';
        }
      };

      await expect(identityEvents.record(context, failed)).rejects.toMatchObject({
        reason: 'no-open-unit',
      });
      await expect(
        unitOfWork.run(market, () => identityEvents.record(context, failed).then(() => ok(1)), {
          readOnly: true,
        }),
      ).rejects.toMatchObject({ reason: 'read-only-unit' });
      expect(await refusal(paymentsEvents, failed)).toBe('type-of-another-owner');
      expect(await refusal(identityEvents, { ...failed, type: 'identity.sign-in.guessed' })).toBe(
        'type-not-in-catalogue',
      );
      expect(await refusal(identityEvents, { ...failed, ip: 'not-an-address' })).toBe('ip-invalid');
      expect(await refusal(identityEvents, { ...failed, targetId: 'someone@example.com' })).toBe(
        'target-id-invalid',
      );
      expect(
        await refusal(paymentsEvents, {
          ...StripeWebhookSignatureFailed.event({ payload: { provider: 'stripe' } }),
          targetId: account(),
        }),
      ).toBe('target-undeclared');
      expect(
        await refusal(identityEvents, {
          ...failed,
          payload: { population: 'admin', reason: 'link-rejected', email: 'a@example.com' },
        }),
      ).toBe('payload-invalid');
      expect(
        await refusal(identityEvents, {
          ...failed,
          payload: { population: 'admin', reason: 'password was hunter2' },
        }),
      ).toBe('payload-invalid');
      expect(await eventsOf(context.correlationId)).toEqual([]);
    });

    it('projects a security-relevant audited action in the same unit', async () => {
      const correlationId = correlation();
      const adminId = account();
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: adminId,
          sessionId: newId<'Session'>(),
          sellerId: null,
        }),
        correlationId,
      );
      const targetId = account();
      await unitOfWork.run(market, async () => {
        await identityAudit.record(
          context,
          AccountDisabledAudit.entry(targetId, {
            before: { status: 'active' },
            after: { status: 'disabled', population: 'admin' },
          }),
        );
        return ok(undefined);
      });

      const [audit] = await root.auditLog.findMany({ where: { correlationId } });
      const [event, ...rest] = await eventsOf(correlationId);
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'identity.account.disabled',
        severity: 's3',
        actorType: 'USER',
        actorId: adminId,
        targetType: 'identity.account',
        targetId,
        ip: null,
        payload: { auditLogId: audit!.id },
      });
      expect(event!.occurredAt).toEqual(audit!.occurredAt);
    });

    it('archives events older than 90 days and deletes archived ones older than 90 + 365 days', async () => {
      const recent = await eventAt(code, 30, 'security_events');
      const old = await eventAt(code, 100, 'security_events');
      const kept = await eventAt(code, 300, 'security_events_archive');
      const expired = await eventAt(code, 500, 'security_events_archive');
      clock.set(nowMs());

      const report = await retention.run(market);

      expect(report.archived).toBeGreaterThanOrEqual(1);
      expect(report.purged).toBeGreaterThanOrEqual(1);
      const hot = await root.securityEvent.findMany({ where: { id: { in: [recent, old] } } });
      expect(hot.map((row) => row.id)).toEqual([recent]);
      const archive = await root.securityEventArchive.findMany({
        where: { id: { in: [old, kept, expired] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(archive.map((row) => row.id)).toEqual([kept, old]);
      expect(archive[1]!.archivedAt.getTime()).toBe(clock.now().epochMilliseconds);
      // A second run finds nothing more of these.
      await retention.run(market);
      expect(await root.securityEvent.count({ where: { id: old } })).toBe(0);
    });

    it('is insert-only: no UPDATE or TRUNCATE for anyone, no DELETE of a recent row', async () => {
      const recent = await eventAt(code, 10, 'security_events');
      const archived = await eventAt(code, 200, 'security_events_archive');
      for (const [table, id] of [
        ['security_events', recent],
        ['security_events_archive', archived],
      ] as const) {
        expect(
          await sqlStateOf(sql, `UPDATE platform.${table} SET severity = 's1' WHERE id = $1`, [id]),
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect(
          await sqlStateOf(owner, `UPDATE platform.${table} SET severity = 's1' WHERE id = $1`, [
            id,
          ]),
        ).toBe(RESTRICT_VIOLATION);
        expect(await sqlStateOf(sql, `DELETE FROM platform.${table} WHERE id = $1`, [id])).toBe(
          RESTRICT_VIOLATION,
        );
        expect(await sqlStateOf(owner, `DELETE FROM platform.${table} WHERE id = $1`, [id])).toBe(
          RESTRICT_VIOLATION,
        );
        expect(await sqlStateOf(owner, `TRUNCATE platform.${table}`)).toBe(RESTRICT_VIOLATION);
      }
    });

    it('checks codes, actors, targets and the payload shape', async () => {
      const insert = (columns: Record<string, unknown>) => {
        const row = {
          id: randomUUID(),
          market_id: code,
          tenant_id: PLATFORM_TENANT_ID,
          occurred_at: '2026-10-01T00:00:00.000Z',
          type: 'identity.sign-in.failed',
          severity: 's4',
          actor_type: 'ANONYMOUS',
          payload: '{}',
          correlation_id: 'secev-db-checks',
          ...columns,
        };
        const names = Object.keys(row);
        return sqlStateOf(
          sql,
          `INSERT INTO platform.security_events (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      expect(await insert({})).toBe('ok');
      expect(await insert({ severity: 's5' })).toBe(CHECK_VIOLATION);
      expect(await insert({ type: 'Sign In Failed' })).toBe(CHECK_VIOLATION);
      expect(await insert({ actor_type: 'USER' })).toBe(CHECK_VIOLATION);
      expect(await insert({ actor_id: randomUUID() })).toBe(CHECK_VIOLATION);
      expect(await insert({ target_type: 'account' })).toBe(CHECK_VIOLATION);
      expect(await insert({ payload: '[]' })).toBe(CHECK_VIOLATION);
      expect(await insert({ payload: JSON.stringify({ a: 'x'.repeat(5000) }) })).toBe(
        CHECK_VIOLATION,
      );
      expect(await insert({ occurred_at: '2026-10-01T00:00:00.000001Z' })).toBe(CHECK_VIOLATION);
      expect(await insert({ correlation_id: 'short' })).toBe(CHECK_VIOLATION);
    });
  });
});
