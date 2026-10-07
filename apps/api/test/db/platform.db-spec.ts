import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureApp } from '../../src/configure-app';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';

function auditRow(marketId: string, overrides: Record<string, unknown> = {}) {
  return {
    // The application generates UUIDv7 ids; any UUID satisfies the column in a test.
    id: randomUUID(),
    marketId,
    tenantId: 'mondapac',
    occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    actorType: 'SYSTEM',
    action: 'platform.skeleton.checked',
    targetType: 'platform.skeleton',
    targetId: 'baseline',
    correlationId: 'db-test-correlation-0001',
    ...overrides,
  };
}

describe('platform persistence (database integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sql: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    const nestApp = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureApp(nestApp);
    await nestApp.init();
    app = nestApp;
    prisma = app.get(PrismaService);

    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  it('GET /health/ready reports ready when the database answers', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  describe('platform.audit_log', () => {
    it.each(TEST_MARKETS)('accepts an audit row for market %s', async (marketId) => {
      const row = auditRow(marketId, { after: { status: 'checked' } });

      await prisma.auditLog.create({ data: row });

      await expect(prisma.auditLog.findUnique({ where: { id: row.id } })).resolves.toMatchObject({
        marketId,
        actorType: 'SYSTEM',
        actorId: null,
        after: { status: 'checked' },
      });
    });

    it('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
      const row = auditRow('AU');
      await prisma.auditLog.create({ data: row });

      await expect(
        sql.query('UPDATE platform.audit_log SET action = $1 WHERE id = $2', ['x.y.z', row.id]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        sql.query('DELETE FROM platform.audit_log WHERE id = $1', [row.id]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(sql.query('TRUNCATE platform.audit_log')).rejects.toMatchObject({
        code: RESTRICT_VIOLATION,
      });

      await expect(prisma.auditLog.count({ where: { id: row.id } })).resolves.toBe(1);
    });

    it.each([
      ['a USER actor without actor_id', { actorType: 'USER' }, 'audit_log_actor_check'],
      ['a SYSTEM actor with actor_id', { actorId: randomUUID() }, 'audit_log_actor_check'],
      ['an unknown actor type', { actorType: 'ROBOT' }, 'audit_log_actor_type_check'],
      ['an empty market', { marketId: '' }, 'audit_log_market_id_check'],
      ['an empty tenant', { tenantId: '' }, 'audit_log_tenant_id_check'],
      ['an action that is not a dotted code', { action: 'Not A Code' }, 'audit_log_action_check'],
      ['an empty target id', { targetId: '' }, 'audit_log_target_id_check'],
      [
        'a target type that is not a dotted code',
        { targetType: 'Bad Type' },
        'audit_log_target_type_check',
      ],
      ['a non-object "after"', { after: 'text' }, 'audit_log_after_check'],
      [
        'impersonation without a real actor',
        { actingAsId: randomUUID() },
        'audit_log_acting_as_check',
      ],
      ['a non-object "before"', { before: ['not', 'an', 'object'] }, 'audit_log_before_check'],
      [
        'a malformed correlation id',
        { correlationId: 'has spaces in it' },
        'audit_log_correlation_id_check',
      ],
    ])('rejects %s', async (_case, overrides, constraint) => {
      const attempt = prisma.auditLog.create({ data: auditRow('ZZ', overrides) });

      await expect(attempt).rejects.toThrow(CHECK_VIOLATION);
      await expect(attempt).rejects.toThrow(`"${constraint}"`);
    });
  });
});
