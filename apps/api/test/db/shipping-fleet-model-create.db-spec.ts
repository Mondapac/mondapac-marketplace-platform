import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { createFleetSelectionModel } from '../../src/modules/shipping/application/fleet-selection-flow';
import { FleetModelCreateApplier } from '../../src/modules/shipping/application/shipping-appliers';
import type {
  FleetModelCreateDependencies,
  ShippingApplierDependencies,
} from '../../src/modules/shipping/application/shipping-dependencies';
import { fleetModelNameRef } from '../../src/modules/shipping/application/shipping-review';
import { ConfigCarrierPolicy } from '../../src/modules/shipping/infrastructure/config-carrier-policy';
import { ConfigShippingPolicy } from '../../src/modules/shipping/infrastructure/config-shipping-policy';
import { PrismaFleetSelectionRepository } from '../../src/modules/shipping/infrastructure/prisma-fleet-selection.repository';
import { ShippingModule } from '../../src/modules/shipping/shipping.module';
import {
  SYSTEM_ACTION_PROPOSER,
  SYSTEM_REQUEST_RECORDER,
  SystemRequestsModule,
  type SystemActionProposer,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { loadServiceAreas } from '../../src/platform/market-config/service-area-config';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  testAppConfig,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../support/test-config';
import { ListRegistry } from '../support/shipping-fakes';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The create of a fleet-selection model in approval mode (Admin Inbox › System requests, owner
// decision of 18 Nov 2026, "mixed") on the real proposer, the real audit writer and the real
// shipping store, in both Market fixtures (area delivery is reviewed by default): the create
// files a proposal and writes no model; a second proposal of the same name is already-pending;
// the applier creates the model in the decision's unit as the approving admin, its audit row
// naming the request, and answers changed-since once the name is taken. Names are new per test.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

describe.each(TEST_MARKETS)(
  'a new fleet model waiting for approval in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const clock = new FixedClock(Temporal.Instant.from('2026-11-18T10:00:00Z'));
    const ids = new UuidV7IdGenerator(clock);
    const admin = (name: string): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
        name,
      );

    let app: INestApplicationContext;
    let deps: FleetModelCreateDependencies & ShippingApplierDependencies;
    let requests: RequestRepository;
    let sql: Client;
    const audits: AuditEntry[] = [];

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
      const prisma = app.get(PrismaService);
      const reviews = app.select(SystemRequestsModule);
      const realAudit = app.select(ShippingModule).get<AuditWriter>(AUDIT_WRITER, { strict: true });
      deps = {
        unitOfWork: app.get<UnitOfWork>(UNIT_OF_WORK),
        policy: new ConfigShippingPolicy(markets, areas),
        sellers: undefined as never,
        audit: {
          record: (context, entry) => {
            audits.push(entry);
            return realAudit.record(context, entry);
          },
        },
        review: reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true }),
        proposer: reviews.get<SystemActionProposer>(SYSTEM_ACTION_PROPOSER, { strict: true }),
        // The approver's keys come from identity in the app; its own specs cover the port.
        authorisation: { check: () => Promise.resolve({ allowed: true }) },
        clock,
        ids,
        outbox: undefined as never,
        bookings: undefined as never,
        fleets: new ListRegistry([]),
        selection: new PrismaFleetSelectionRepository(prisma),
        deliverySettings: undefined as never,
        carrierPolicy: new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} }),
        quotes: undefined as never,
        ledger: undefined as never,
        pickups: undefined as never,
        webhookSignature: undefined as never,
        uberWebhookSignature: undefined as never,
        securityEvents: undefined as never,
        trail: undefined as never,
      };
      requests = reviews.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
      await app.close();
    });
    beforeEach(() => {
      audits.length = 0;
    });

    const inUnit = async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await deps.unitOfWork.run(market, async () => ok(await work()));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const unique = (label: string) => `${label} ${ids.next<'Account'>().slice(-8)}`;
    const modelsNamed = async (name: string) =>
      (
        await sql.query<{ id: string; version: number; created_by: string }>(
          'SELECT id, version, created_by FROM shipping.fleet_selection_models ' +
            'WHERE market_id = $1 AND lower(name) = lower($2)',
          [market.marketId, name],
        )
      ).rows;
    const RULE = { kind: 'fixed_priority', order: ['mondapac_drive', 'zoom2u'] };

    it('files the create for approval with nothing written, and refuses it without a note', async () => {
      const author = admin('fleet-create-db-author');
      const name = unique('Own fleet first');
      const refused = await createFleetSelectionModel(deps, author, { name, rule: RULE });
      expect(!refused.ok && refused.error).toMatchObject({
        code: 'validation.failed',
        fields: [{ path: 'note', code: 'required' }],
      });

      const tooLong = await createFleetSelectionModel(deps, author, {
        name,
        rule: RULE,
        note: 'x'.repeat(501),
      });
      expect(!tooLong.ok && tooLong.error).toMatchObject({
        code: 'validation.failed',
        fields: [{ path: 'note' }],
      });
      const filed = await sql.query(
        'SELECT 1 FROM system_requests.requests WHERE market_id = $1 AND subject_ref = $2',
        [market.marketId, fleetModelNameRef(name)],
      );
      expect(filed.rows).toEqual([]);
      expect(await modelsNamed(name)).toEqual([]);

      const proposed = await createFleetSelectionModel(deps, author, {
        name,
        rule: RULE,
        note: 'Our drivers first',
      });
      if (!proposed.ok || !('request' in proposed.value) || 'id' in proposed.value) {
        throw new Error('no proposal filed');
      }
      expect(Object.keys(proposed.value)).toEqual(['request']);
      const { request } = proposed.value;
      const stored = await inUnit(() => requests.find(market, request.id));
      expect(stored).toMatchObject({
        status: 'open',
        mode: 'approval',
        area: 'delivery',
        risk: 'medium',
        subjectKind: 'shipping.fleet-selection-model-create',
        subjectRef: fleetModelNameRef(name),
        before: { exists: false },
        after: { action: 'create', name, rule: RULE },
      });
      expect(await modelsNamed(name)).toEqual([]);
      expect(audits).toEqual([]);

      // One proposal per name, whatever its case.
      const again = await createFleetSelectionModel(deps, admin('fleet-create-db-other'), {
        name: name.toUpperCase(),
        rule: { kind: 'cheapest' },
        note: 'Me too',
      });
      expect(!again.ok && again.error).toEqual({
        code: 'system-requests.already-pending',
        pendingNumber: request.number,
      });
      expect(await modelsNamed(name)).toEqual([]);
    });

    it('creates the model on approval, as the approver, audited with the request id', async () => {
      const name = unique('Weighted rule');
      const proposed = await createFleetSelectionModel(deps, admin('fleet-create-db-author-2'), {
        name,
        rule: RULE,
        note: 'Try this order',
      });
      if (!proposed.ok || !('request' in proposed.value)) throw new Error('no proposal filed');
      const requestId = proposed.value.request.id;
      const stored = await inUnit(() => requests.find(market, requestId));
      const request = {
        requestId,
        subjectRef: stored!.subjectRef,
        before: stored!.before,
        after: stored!.after,
      };
      const approver = admin('fleet-create-db-approver');
      const applier = new FleetModelCreateApplier(deps);
      expect(await applier.check(approver, request)).toBe('ok');
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      const rows = await modelsNamed(name);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 1,
        created_by: (approver.actor as { accountId: string }).accountId,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'shipping.fleet-model.created',
        targetId: rows[0]!.id,
        after: { kind: 'fixed-priority', order: ['mondapac-drive', 'zoom2u'], requestId },
      });
      const kept = await sql.query<{ after: { requestId: string } }>(
        'SELECT after FROM platform.audit_log WHERE market_id = $1 AND target_id = $2',
        [market.marketId, rows[0]!.id],
      );
      expect(kept.rows.map((row) => row.after.requestId)).toEqual([requestId]);

      // The name is taken now: a second approval writes nothing.
      expect(await inUnit(() => applier.apply(approver, request))).toBe('changed-since');
      expect(await modelsNamed(name)).toHaveLength(1);
    });

    it('answers changed-since when another model took the name before the approval', async () => {
      const name = unique('Raced name');
      const proposed = await createFleetSelectionModel(deps, admin('fleet-create-db-author-3'), {
        name,
        rule: { kind: 'cheapest' },
        note: 'Cheapest',
      });
      if (!proposed.ok || !('request' in proposed.value)) throw new Error('no proposal filed');
      const requestId = proposed.value.request.id;
      const stored = await inUnit(() => requests.find(market, requestId));
      // The area was switched off meanwhile and an admin created the name at once.
      const atOnce = await createFleetSelectionModel(
        { ...deps, proposer: { proposeChange: () => Promise.resolve(ok(null)) } },
        admin('fleet-create-db-direct'),
        { name: name.toLowerCase(), rule: { kind: 'cheapest' } },
      );
      expect(atOnce.ok && 'id' in atOnce.value).toBe(true);
      audits.length = 0;
      const applier = new FleetModelCreateApplier(deps);
      const request = {
        requestId,
        subjectRef: stored!.subjectRef,
        before: stored!.before,
        after: stored!.after,
      };
      expect(await inUnit(() => applier.apply(admin('fleet-create-db-approver-3'), request))).toBe(
        'changed-since',
      );
      expect(await modelsNamed(name)).toHaveLength(1);
      expect(audits).toEqual([]);
    });
  },
);
