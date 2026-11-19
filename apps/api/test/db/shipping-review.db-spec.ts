import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import {
  revertDeliverySettings,
  setDeliverySettings,
  setSellerDeliveryMethods,
} from '../../src/modules/shipping/application/delivery-settings-flow';
import {
  createFleetSelectionModel,
  revertFleetSelection,
  revertFleetSelectionModel,
  setFleetSelection,
  updateFleetSelectionModel,
  viewFleetSelection,
} from '../../src/modules/shipping/application/fleet-selection-flow';
import {
  DeliverySettingsReverter,
  FleetSelectionModelReverter,
  FleetSelectionReverter,
  SellerDeliveryMethodsReverter,
} from '../../src/modules/shipping/application/shipping-reverters';
import type { ShippingDependencies } from '../../src/modules/shipping/application/shipping-dependencies';
import { ConfigCarrierPolicy } from '../../src/modules/shipping/infrastructure/config-carrier-policy';
import { ConfigShippingPolicy } from '../../src/modules/shipping/infrastructure/config-shipping-policy';
import { PrismaDeliverySettingsRepository } from '../../src/modules/shipping/infrastructure/prisma-delivery-settings.repository';
import { PrismaFleetSelectionRepository } from '../../src/modules/shipping/infrastructure/prisma-fleet-selection.repository';
import {
  SYSTEM_REQUEST_RECORDER,
  SystemRequestsModule,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
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

// Area delivery of Admin Inbox › System requests on the real recorder and the real shipping
// stores, in both Market fixtures (delivery is reviewed by default, medium risk): a change without
// a note leaves nothing behind, a change with one opens its request in the same unit, and the
// reverters restore the settings, the seller's methods, the fleet page and a model, then answer
// changed-since or gone. Sellers and models are new per test; the Market-wide rows (settings and
// the page) are read first and every change builds on what is there.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

const SETTINGS = {
  enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  sameDayCutoff: '12:00',
  scheduledDaysAhead: 7,
  scheduledWindowMinutes: 120,
  readyPrepMinutes: 60,
  margin: { kind: 'none' },
  roundingStepMinor: 1,
};

describe.each(TEST_MARKETS)('delivery reviews in market %s (database)', (code) => {
  const market = marketOf(code);
  const clock = new FixedClock(Temporal.Instant.from('2026-11-15T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const admin = (name: string) =>
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
  let deps: ShippingDependencies;
  let requests: RequestRepository;
  let sql: Client;
  let sellerKnown = true;
  const audit: AuditEntry[] = [];

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
    deps = {
      unitOfWork: app.get<UnitOfWork>(UNIT_OF_WORK),
      policy: new ConfigShippingPolicy(markets, areas),
      sellers: { exists: () => Promise.resolve(sellerKnown) },
      audit: {
        record: (_context, entry) => {
          audit.push(entry);
          return Promise.resolve();
        },
      },
      review: reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true }),
      clock,
      ids,
      outbox: undefined as never,
      bookings: undefined as never,
      fleets: new ListRegistry([]),
      selection: new PrismaFleetSelectionRepository(prisma),
      deliverySettings: new PrismaDeliverySettingsRepository(prisma),
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
    sellerKnown = true;
    audit.length = 0;
  });

  const inUnit = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await deps.unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const settingsNow = () => inUnit(() => deps.deliverySettings.settings(market));
  const unique = (label: string) => `${label} ${ids.next<'Account'>().slice(-8)}`;
  /** The models these cases edit are made at once: a proposer that files nothing. */
  const createsAtOnce = () => ({
    ...deps,
    proposer: { proposeChange: () => Promise.resolve(ok(null)) },
  });

  it('keeps nothing of a settings save without a note, and reverts one with its request', async () => {
    const author = admin('delivery-db-settings');
    const before = await settingsNow();
    const input = {
      ...SETTINGS,
      scheduledDaysAhead: before.scheduledDaysAhead === 4 ? 5 : 4,
      expectedVersion: before.version,
    };
    const refused = await setDeliverySettings(deps, author, input);
    expect(!refused.ok && refused.error).toMatchObject({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(await settingsNow()).toEqual(before);

    const saved = await setDeliverySettings(deps, author, { ...input, note: 'Shorter horizon' });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(saved.value.review).toEqual({ reviewed: true, risk: 'medium' });
    const after = await settingsNow();
    expect(after.version).toBe(before.version + 1);
    const requestId = saved.value.request.id;
    const stored = await inUnit(() => requests.find(market, requestId));
    expect(stored).toMatchObject({
      status: 'open',
      area: 'delivery',
      risk: 'medium',
      subjectKind: 'shipping.delivery-settings',
      subjectRef: 'delivery-settings',
    });

    const reverter = new DeliverySettingsReverter(deps);
    const request = {
      requestId,
      subjectRef: 'delivery-settings',
      before: stored!.before,
      after: stored!.after,
    };
    const reviewer = admin('delivery-db-settings-reviewer');
    audit.length = 0;
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    const restored = await settingsNow();
    expect(restored).toEqual({ ...before, version: before.version + 2 });
    expect(audit.at(-1)).toMatchObject({
      action: 'shipping.delivery-settings.reverted',
      targetId: 'market',
      after: { version: before.version + 2, requestId },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
    expect(await inUnit(() => revertDeliverySettings(deps, reviewer, request))).toBe(
      'changed-since',
    );
  });

  it('needs no note and opens nothing for a save that changes nothing', async () => {
    const author = admin('delivery-db-same');
    const before = await settingsNow();
    const saved = await setDeliverySettings(deps, author, {
      ...SETTINGS,
      sameDayCutoff: `${String(Math.floor(before.sameDayCutoffMinutes / 60)).padStart(2, '0')}:${String(before.sameDayCutoffMinutes % 60).padStart(2, '0')}`,
      enabled: { ...before.enabled },
      scheduledDaysAhead: before.scheduledDaysAhead,
      scheduledWindowMinutes: before.scheduledWindowMinutes,
      readyPrepMinutes: before.readyPrepMinutes,
      margin:
        before.margin.kind === 'percent'
          ? { kind: 'percent', basisPoints: before.margin.basisPoints }
          : before.margin.kind === 'fixed'
            ? { kind: 'fixed', amountMinor: before.margin.amountMinor }
            : { kind: 'none' },
      roundingStepMinor: before.roundingStepMinor,
      expectedVersion: before.version,
    });
    expect(saved.ok && saved.value.request).toBeNull();
  });

  it('keeps nothing of a seller methods change without a note, and reverts one', async () => {
    const seller = ids.next<'Seller'>();
    const author = admin('delivery-db-seller');
    const refused = await setSellerDeliveryMethods(deps, author, {
      sellerId: seller,
      supported: ['pickup'],
    });
    expect(!refused.ok && refused.error.code).toBe('validation.failed');
    expect((await inUnit(() => deps.deliverySettings.unsupportedOf(market, [seller]))).size).toBe(
      0,
    );

    const saved = await setSellerDeliveryMethods(deps, author, {
      sellerId: seller,
      supported: ['pickup', 'scheduled'],
      note: 'No bike couriers',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    const requestId = saved.value.request.id;
    const stored = await inUnit(() => requests.find(market, requestId));
    expect(stored).toMatchObject({
      area: 'delivery',
      subjectKind: 'shipping.seller-delivery-methods',
      subjectRef: seller,
      before: { unsupported: [] },
      after: { unsupported: ['instant', 'same_day'] },
    });

    const reverter = new SellerDeliveryMethodsReverter(deps);
    const request = {
      requestId,
      subjectRef: seller,
      before: stored!.before,
      after: stored!.after,
    };
    const reviewer = admin('delivery-db-seller-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await inUnit(() => deps.deliverySettings.unsupportedOf(market, [seller]))).toEqual(
      new Map([[seller, []]]),
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'shipping.seller-delivery-methods.reverted',
      targetId: seller,
      after: { unsupported: [], requestId },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
    sellerKnown = false;
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('gone');
  });

  it('reverts a fleet page save (the active model and a score) and a model edit', async () => {
    const author = admin('delivery-db-fleets');
    const reviewer = admin('delivery-db-fleets-reviewer');
    // A model is created at once here (its create waits for approval where delivery is reviewed:
    // shipping-fleet-model-create.db-spec.ts).
    const model = await createFleetSelectionModel(createsAtOnce(), author, {
      name: unique('Review model'),
      rule: { kind: 'cheapest' },
    });
    if (!model.ok || !('id' in model.value)) throw new Error('model not created');
    const modelId = model.value.id;
    const view = async () => {
      const read = await viewFleetSelection(deps, author);
      if (!read.ok) throw new Error('view failed');
      return read.value;
    };
    const start = await view();
    expect(start.review).toEqual({ reviewed: true, risk: 'medium' });
    const page = { ...start };
    const score = start.fleets.find((fleet) => fleet.fleet === 'zoom2u')?.reliability ?? null;
    const nextScore = score === 77 ? 78 : 77;
    const input = {
      expectedVersion: page.version,
      active: { ...page.active, same_day: model.value.id },
      reliability: { zoom2u: nextScore },
    };
    const refused = await setFleetSelection(deps, author, input);
    expect(!refused.ok && refused.error).toMatchObject({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(await view()).toEqual(start);

    const saved = await setFleetSelection(deps, author, { ...input, note: 'Try the model' });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(saved.value.version).toBe(start.version + 1);
    const requestId = saved.value.request.id;
    const stored = await inUnit(() => requests.find(market, requestId));
    expect(stored).toMatchObject({
      area: 'delivery',
      subjectKind: 'shipping.fleet-selection',
      subjectRef: 'fleet-selection',
      before: { active: { same_day: start.active.same_day }, reliability: { zoom2u: score } },
      after: { active: { same_day: model.value.id }, reliability: { zoom2u: nextScore } },
    });
    const request = {
      requestId,
      subjectRef: 'fleet-selection',
      before: stored!.before,
      after: stored!.after,
    };
    audit.length = 0;
    expect(await inUnit(() => new FleetSelectionReverter(deps).revert(reviewer, request))).toBe(
      'reverted',
    );
    const restored = await view();
    expect(restored.version).toBe(start.version + 2);
    expect(restored.active.same_day).toBe(start.active.same_day);
    expect(restored.fleets.find((fleet) => fleet.fleet === 'zoom2u')?.effectiveReliability).toBe(
      score ?? 50,
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'shipping.fleet-model.activation-reverted',
      'shipping.fleet-reliability.reverted',
    ]);
    expect(audit[0]).toMatchObject({ after: { requestId } });
    expect(await inUnit(() => revertFleetSelection(deps, reviewer, request))).toBe('changed-since');

    // The model: an edit with a note, then its revert (a new version), then changed-since.
    const edited = await updateFleetSelectionModel(deps, author, {
      modelId: model.value.id,
      name: unique('Edited model'),
      rule: { kind: 'fixed_priority', order: ['mondapac_drive', 'zoom2u'] },
      expectedVersion: 1,
      note: 'New order',
    });
    if (!edited.ok || edited.value.request === null) throw new Error('no request opened');
    const editId = edited.value.request.id;
    const editStored = await inUnit(() => requests.find(market, editId));
    expect(editStored).toMatchObject({
      subjectKind: 'shipping.fleet-selection-model',
      subjectRef: model.value.id,
      before: { name: model.value.name, rule: { kind: 'cheapest' } },
    });
    const editRequest = {
      requestId: editId,
      subjectRef: model.value.id,
      before: editStored!.before,
      after: editStored!.after,
    };
    expect(
      await inUnit(() => new FleetSelectionModelReverter(deps).revert(reviewer, editRequest)),
    ).toBe('reverted');
    const back = await inUnit(() => deps.selection.findModel(market, modelId));
    expect(back).toMatchObject({ name: model.value.name, rule: { kind: 'cheapest' }, version: 3 });
    expect(await inUnit(() => revertFleetSelectionModel(deps, reviewer, editRequest))).toBe(
      'changed-since',
    );
  });

  it('puts the neutral score 50 in the row for a fleet that had none, and stales a page opened before the revert', async () => {
    const author = admin('delivery-db-neutral');
    const reviewer = admin('delivery-db-neutral-reviewer');
    const read = async () => {
      const result = await viewFleetSelection(deps, author);
      if (!result.ok) throw new Error('view failed');
      return result.value;
    };
    const start = await read();
    expect(start.fleets.find((fleet) => fleet.fleet === 'fake_test')?.reliability).toBeNull();
    const saved = await setFleetSelection(deps, author, {
      expectedVersion: start.version,
      active: { ...start.active },
      reliability: { fake_test: 30 },
      note: 'Score a fleet',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    // A page an admin opened before the revert.
    const opened = await read();
    const requestId = saved.value.request.id;
    const stored = await inUnit(() => requests.find(market, requestId));
    const request = {
      requestId,
      subjectRef: 'fleet-selection',
      before: stored!.before,
      after: stored!.after,
    };
    expect(await inUnit(() => new FleetSelectionReverter(deps).revert(reviewer, request))).toBe(
      'reverted',
    );
    const row = await sql.query<{ score: number }>(
      'SELECT score FROM shipping.fleet_reliability WHERE market_id = $1 AND fleet = $2',
      [market.marketId, 'fake_test'],
    );
    expect(row.rows).toEqual([{ score: 50 }]);
    const stale = await setFleetSelection(deps, author, {
      expectedVersion: opened.version,
      active: { ...opened.active },
      reliability: { fake_test: 10 },
      note: 'From the old page',
    });
    expect(!stale.ok && stale.error.code).toBe('shipping.fleet-selection-conflict');
  });

  it('keeps nothing of a refused model edit and does not review a nothing-to-do page save', async () => {
    const author = admin('delivery-db-refusals');
    const model = await createFleetSelectionModel(createsAtOnce(), author, {
      name: unique('Refusal model'),
      rule: { kind: 'cheapest' },
    });
    if (!model.ok || !('id' in model.value)) throw new Error('model not created');
    const modelId = model.value.id;
    const refused = await updateFleetSelectionModel(deps, author, {
      modelId: model.value.id,
      name: unique('Never kept'),
      rule: { kind: 'cheapest' },
      expectedVersion: 1,
    });
    expect(!refused.ok && refused.error.code).toBe('validation.failed');
    expect(await inUnit(() => deps.selection.findModel(market, modelId))).toMatchObject({
      name: model.value.name,
      version: 1,
    });
    const read = await viewFleetSelection(deps, author);
    if (!read.ok) throw new Error('view failed');
    // Nothing differs from what is stored: no request and no note needed.
    const same = await setFleetSelection(deps, author, {
      expectedVersion: read.value.version,
      active: { ...read.value.active },
      reliability: {},
    });
    expect(same.ok && same.value.request).toBeNull();
  });
});
