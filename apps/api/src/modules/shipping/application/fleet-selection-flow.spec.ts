import {
  changeTrailOf,
  FakeChangeActors,
  InMemoryAuditTrail,
} from '../../../../test/support/change-trail-fakes';
import { err, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  ListRegistry,
  MemorySelection,
  ScriptedFleet,
} from '../../../../test/support/shipping-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import {
  SHIPPING_FLEET_SELECTION_MANAGE,
  SHIPPING_FLEET_SELECTION_VIEW,
} from '../contracts/permissions';
import { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import type { ShippingDependencies } from './shipping-dependencies';
import { CreateFleetSelectionModel } from './use-cases/create-fleet-selection-model.use-case';
import { SetFleetSelection } from './use-cases/set-fleet-selection.use-case';
import { UpdateFleetSelectionModel } from './use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelectionHistory } from './use-cases/view-fleet-selection-history.use-case';
import { ViewFleetSelection } from './use-cases/view-fleet-selection.use-case';

// The admin side of fleet selection in memory on both Market fixtures: define, edit and name
// models of the three kinds, pick the active model per method, set reliability, and audit every
// change. The permissions are the access declarations of the use cases.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);

class RecordingAudit extends InMemoryAuditTrail implements AuditWriter {
  override record(context: CallContext, entry: AuditEntry): Promise<void> {
    if (!SHIPPING_AUDIT_ACTIONS.some((definition) => definition.action === entry.action)) {
      throw new Error(`audit: unknown action ${entry.action}`);
    }
    return super.record(context, entry);
  }
}

describe('the access declarations', () => {
  it('need the view key to read and the protected manage key to change', () => {
    expect(ViewFleetSelection.access.rule).toEqual({
      kind: 'permissions',
      allOf: [SHIPPING_FLEET_SELECTION_VIEW.key],
    });
    for (const useCase of [
      CreateFleetSelectionModel,
      UpdateFleetSelectionModel,
      SetFleetSelection,
    ]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key],
      });
    }
    expect(SHIPPING_FLEET_SELECTION_MANAGE.protected).toBe(true);
    expect(SHIPPING_FLEET_SELECTION_VIEW.protected).toBe(false);
  });
});

describe.each([['AU'], ['ZZ']] as const)('fleet selection in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `fleet-${population}-abcd`,
    );
  const admin = actor('admin');

  let selection: MemorySelection;
  let audit: RecordingAudit;
  let actors: FakeChangeActors;
  let clock: FixedClock;
  let deps: ShippingDependencies;
  let drive: ScriptedFleet;

  beforeEach(() => {
    selection = new MemorySelection();
    clock = new FixedClock(T0);
    audit = new RecordingAudit(clock);
    actors = new FakeChangeActors();
    drive = new ScriptedFleet('mondapac_drive', {
      fleet: 'mondapac_drive',
      methods: ['instant', 'scheduled'],
      serviceAreas: [],
      outsideCityAreasOnly: false,
      temperatures: ['ambient'],
      maxItemWeightGrams: null,
      maxItems: null,
      maxOrderValue: null,
      prohibitedClasses: [],
      idempotentBooking: true,
      supportsWindow: true,
    });
    const unitOfWork = new FakeUnitOfWork();
    deps = {
      unitOfWork,
      policy: undefined as never,
      sellers: undefined as never,
      audit,
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: undefined as never,
      bookings: undefined as never,
      fleets: new ListRegistry([drive]),
      selection,
      deliverySettings: undefined as never,
      carrierPolicy: new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} }),
      quotes: undefined as never,
      ledger: undefined as never,
      pickups: undefined as never,
      webhookSignature: undefined as never,
      uberWebhookSignature: undefined as never,
      securityEvents: undefined as never,
      trail: changeTrailOf(unitOfWork, audit, actors),
    };
  });

  const create = (name: unknown, rule: unknown, context: CallContext = admin) =>
    new CreateFleetSelectionModel(gate, deps).execute(context, { name, rule });
  const update = (modelId: unknown, name: unknown, rule: unknown, expectedVersion: unknown) =>
    new UpdateFleetSelectionModel(gate, deps).execute(admin, {
      modelId,
      name,
      rule,
      expectedVersion,
    });
  const NONE = { instant: null, same_day: null, scheduled: null };
  const save = (
    expectedVersion: unknown,
    active: unknown = NONE,
    reliabilityScores: unknown = {},
    context: CallContext = admin,
  ) =>
    new SetFleetSelection(gate, deps).execute(context, {
      expectedVersion,
      active,
      reliability: reliabilityScores,
    });
  const view = (context: CallContext = admin) =>
    new ViewFleetSelection(gate, deps).execute(context, {});
  const created = async (name: string, rule: unknown = { kind: 'cheapest' }) => {
    const result = await create(name, rule);
    if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };

  it('creates a model of each kind at version 1 and audits it without its name', async () => {
    const a = await created('Cheapest wins');
    const b = await created('Speed first', {
      kind: 'weighted',
      weights: { price: 20, eta: 70, reliability: 10 },
    });
    const c = await created('Own fleet only', {
      kind: 'fixed_priority',
      order: ['mondapac_drive'],
    });
    expect([a.version, b.version, c.version]).toEqual([1, 1, 1]);
    expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      [
        'shipping.fleet-model.created',
        a.id,
        null,
        {
          kind: 'cheapest',
          version: 1,
          weightPrice: null,
          weightEta: null,
          weightReliability: null,
          order: [],
        },
      ],
      [
        'shipping.fleet-model.created',
        b.id,
        null,
        {
          kind: 'weighted',
          version: 1,
          weightPrice: 20,
          weightEta: 70,
          weightReliability: 10,
          order: [],
        },
      ],
      [
        'shipping.fleet-model.created',
        c.id,
        null,
        {
          kind: 'fixed-priority',
          version: 1,
          weightPrice: null,
          weightEta: null,
          weightReliability: null,
          order: ['mondapac-drive'],
        },
      ],
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain('Cheapest wins');
  });

  it('refuses a bad name or rule with the field, and a name taken in the Market in any case', async () => {
    expect(
      await create('', { kind: 'weighted', weights: { price: 0, eta: 0, reliability: 0 } }),
    ).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'name', code: 'format' },
          { path: 'rule.weights', code: 'zero-sum' },
        ],
      }),
    );
    await created('Cheapest wins');
    expect(await create('cheapest WINS', { kind: 'cheapest' })).toEqual(
      err({ code: 'shipping.fleet-model-name-taken' }),
    );
    expect(audit.entries).toHaveLength(1);
  });

  it('keeps the models of each Market apart', async () => {
    await created('Shared name');
    const elsewhere = new CreateFleetSelectionModel(gate, deps).execute(
      testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: id<'Session'>(0x62),
          sellerId: null,
        }),
        'fleet-other-abcd',
      ),
      { name: 'Shared name', rule: { kind: 'cheapest' } },
    );
    expect((await elsewhere).ok).toBe(true);
    const listed = await view();
    expect(listed.ok && listed.value.models).toHaveLength(1);
  });

  it('edits a model: the name, the kind and the settings, with the version raised and old and new audited', async () => {
    const model = await created('Cheapest wins');
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    const edited = await update(
      model.id,
      'Reliable first',
      { kind: 'weighted', weights: { price: 10, eta: 10, reliability: 80 } },
      1,
    );
    expect(edited).toMatchObject({
      ok: true,
      value: { id: model.id, name: 'Reliable first', version: 2, createdAt: T0 },
    });
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'shipping.fleet-model.edited',
      targetId: model.id,
      before: { kind: 'cheapest', version: 1 },
      after: { kind: 'weighted', version: 2, weightReliability: 80 },
    });
  });

  it('refuses an edit from a stale page, of a missing model, or with a name taken', async () => {
    const model = await created('One');
    await created('Two');
    expect(await update(model.id, 'One b', { kind: 'cheapest' }, 1)).toMatchObject({ ok: true });
    expect(await update(model.id, 'One c', { kind: 'cheapest' }, 1)).toEqual(
      err({
        code: 'shipping.fleet-model-conflict',
        lastChanged: { at: T0, byDisplayName: null, byKind: 'member' },
      }),
    );
    expect(await update(model.id, 'two', { kind: 'cheapest' }, 2)).toEqual(
      err({ code: 'shipping.fleet-model-name-taken' }),
    );
    expect(await update(id<'FleetSelectionModel'>(0x999), 'X', { kind: 'cheapest' }, 1)).toEqual(
      err({ code: 'shipping.fleet-model-not-found' }),
    );
    expect(await update('nope', 'X', { kind: 'cheapest' }, 0)).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'modelId', code: 'format' },
          { path: 'expectedVersion', code: 'range' },
        ],
      }),
    );
    expect(audit.entries.map((e) => e.action)).toEqual([
      'shipping.fleet-model.created',
      'shipping.fleet-model.created',
      'shipping.fleet-model.edited',
    ]);
  });

  it('saves the page in one batch: the active model per method and the scores, audited per change, version raised', async () => {
    const model = await created('Cheapest wins');
    const first = await save(
      0,
      { instant: model.id, same_day: null, scheduled: model.id },
      { uber_direct: 80, zoom2u: null },
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        version: 1,
        active: { instant: model.id, same_day: null, scheduled: model.id },
      },
    });
    const second = await save(
      1,
      { instant: null, same_day: null, scheduled: model.id },
      { uber_direct: 90 },
    );
    expect(second).toMatchObject({
      ok: true,
      value: { version: 2, active: { instant: null, same_day: null, scheduled: model.id } },
    });
    expect(audit.entries.slice(1).map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      ['shipping.fleet-model.activated', 'instant', { modelId: null }, { modelId: model.id }],
      ['shipping.fleet-model.activated', 'scheduled', { modelId: null }, { modelId: model.id }],
      ['shipping.fleet-reliability.set', 'uber-direct', { score: null }, { score: 80 }],
      ['shipping.fleet-model.activated', 'instant', { modelId: model.id }, { modelId: null }],
      ['shipping.fleet-reliability.set', 'uber-direct', { score: 80 }, { score: 90 }],
    ]);
    const shown = await view();
    expect(shown.ok && shown.value.version).toBe(2);
    expect(
      shown.ok && shown.value.fleets.map((f) => [f.fleet, f.reliability, f.effectiveReliability]),
    ).toContainEqual(['uber_direct', 90, 90]);
  });

  it('says who changed the page last and when, on the read and the save', async () => {
    expect(await view()).toMatchObject({ ok: true, value: { lastChanged: null } });
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    const model = await created('Cheapest wins');
    clock.advance(Temporal.Duration.from({ minutes: 4 }));
    const saved = await save(0, { ...NONE, instant: model.id }, { zoom2u: 70 });
    const lastChanged = { at: T0.add({ minutes: 4 }), byDisplayName: 'Sara K.', byKind: 'member' };
    expect(saved.ok && saved.value.lastChanged).toEqual(lastChanged);
    expect(await view()).toMatchObject({ ok: true, value: { lastChanged } });
  });

  it('lists the changes of every model, method and score, naming the field and never a value', async () => {
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    const model = await created('Secret model name');
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    await update(
      model.id,
      'Secret model name 2',
      { kind: 'weighted', weights: { price: 20, eta: 70, reliability: 10 } },
      1,
    );
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    await save(0, { ...NONE, instant: model.id }, { zoom2u: 70 });
    const history = (input: object, context: CallContext = admin) =>
      new ViewFleetSelectionHistory(gate, deps).execute(context, input);
    const page = await history({});
    expect(page.ok && page.value.items.map((i) => [...i.fields])).toEqual([
      ['reliability'],
      ['activeModel'],
      ['kind', 'weightEta', 'weightPrice', 'weightReliability'],
      ['model'],
    ]);
    expect(JSON.stringify(page)).not.toContain('Secret');
    const first = await history({ limit: 3 });
    const next = first.ok ? first.value.next : null;
    expect(next).not.toBeNull();
    const rest = await history({ after: next });
    expect(rest.ok && rest.value.items).toHaveLength(1);
    expect((await history({}, actor('customer'))).ok).toBe(false);
  });

  it('shows version 0 before the first save', async () => {
    const shown = await view();
    expect(shown).toMatchObject({ ok: true, value: { version: 0 } });
  });

  it('refuses a stale page with the conflict code and writes and audits nothing', async () => {
    const model = await created('Cheapest wins');
    const entries = audit.entries.length;
    await save(0, { ...NONE, instant: model.id });
    const winner = { at: T0, byDisplayName: null, byKind: 'member' };
    expect(await save(0, { ...NONE, scheduled: model.id }, { zoom2u: 70 })).toEqual(
      err({ code: 'shipping.fleet-selection-conflict', lastChanged: winner }),
    );
    expect(await save(5)).toEqual(
      err({ code: 'shipping.fleet-selection-conflict', lastChanged: winner }),
    );
    expect(audit.entries.length).toBe(entries + 1);
    expect((await selection.assignments(market)).get('scheduled')).toBeUndefined();
    expect((await selection.reliabilities(market)).size).toBe(0);
    expect(await selection.selectionVersion(market)).toBe(1);
  });

  it('keeps the page version of each Market apart', async () => {
    await save(0);
    expect(await selection.selectionVersion(market)).toBe(1);
    expect(await selection.selectionVersion(other)).toBe(0);
  });

  it('writes and audits only what changed', async () => {
    const model = await created('Cheapest wins');
    await save(0, { ...NONE, instant: model.id }, { zoom2u: 70 });
    const entries = audit.entries.length;
    expect(await save(1, { ...NONE, instant: model.id }, { zoom2u: 70 })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
    expect(audit.entries.length).toBe(entries);
  });

  it('refuses a model that does not exist or belongs to another Market, before any write', async () => {
    const foreign = await new CreateFleetSelectionModel(gate, deps).execute(
      testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: id<'Session'>(0x62),
          sellerId: null,
        }),
        'fleet-other-abcd',
      ),
      { name: 'Foreign', rule: { kind: 'cheapest' } },
    );
    if (!foreign.ok) throw new Error('create failed');
    for (const modelId of [id<'FleetSelectionModel'>(0x999), foreign.value.id]) {
      expect(await save(0, { ...NONE, same_day: modelId }, { zoom2u: 70 })).toEqual(
        err({ code: 'shipping.fleet-model-not-found' }),
      );
    }
    expect(await selection.selectionVersion(market)).toBe(0);
    expect((await selection.reliabilities(market)).size).toBe(0);
  });

  it('refuses a bad page with every field named', async () => {
    expect(
      await save(
        -1,
        { instant: 'nope', same_day: undefined, pickup: null, scheduled: null },
        { fedex: 1, zoom2u: 101, auspost: 50.5 },
      ),
    ).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'expectedVersion', code: 'range' },
          { path: 'active.pickup', code: 'unknown-field' },
          { path: 'active.instant', code: 'format' },
          { path: 'active.same_day', code: 'required' },
          { path: 'reliability.fedex', code: 'unknown-field' },
          { path: 'reliability.zoom2u', code: 'range' },
          { path: 'reliability.auspost', code: 'range' },
        ],
      }),
    );
    expect(await save('1')).toMatchObject({ ok: false });
    expect(await save(0, null, [])).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'active', code: 'format' },
          { path: 'reliability', code: 'format' },
        ],
      }),
    );
    expect(await selection.selectionVersion(market)).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('shows the scores with the fleets of the Market', async () => {
    await save(0, NONE, { uber_direct: 90 });
    const shown = await view();
    expect(
      shown.ok &&
        shown.value.fleets.map((f) => [f.fleet, f.enabled, f.reliability, f.effectiveReliability]),
    ).toEqual([
      ['mondapac_drive', true, null, 50],
      ['uber_direct', false, 90, 90],
      ['zoom2u', false, null, 50],
      ['doordash_drive', false, null, 50],
      ['auspost', false, null, 50],
      ['fake_test', false, null, 50],
    ]);
    expect(shown.ok && shown.value.fleets[0]!.methods).toEqual(['instant', 'scheduled']);
    expect(shown.ok && shown.value.defaultOrder).toEqual([
      'mondapac_drive',
      'uber_direct',
      'zoom2u',
      'doordash_drive',
      'auspost',
      'fake_test',
    ]);
  });

  it('answers only to an admin: a seller, a customer, an anonymous caller and the system are refused', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'fleet-anon-abcd');
    const system = testCallContext(market, 'system', 'fleet-system-abcd');
    for (const context of [actor('seller'), actor('customer'), anonymous, system]) {
      expect((await create('X', { kind: 'cheapest' }, context)).ok).toBe(false);
      expect((await view(context)).ok).toBe(false);
      expect((await save(0, NONE, {}, context)).ok).toBe(false);
    }
    expect(selection.models.size).toBe(0);
    expect(await selection.selectionVersion(market)).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('refuses a caller without the permission, whoever the actor is', async () => {
    const denying = createUseCaseGate(markets, {
      check: () => Promise.resolve({ allowed: false, denial: { code: 'access.denied' } as const }),
    });
    const result = await new CreateFleetSelectionModel(denying, deps).execute(admin, {
      name: 'X',
      rule: { kind: 'cheapest' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(selection.models.size).toBe(0);
  });
});
