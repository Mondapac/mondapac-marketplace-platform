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
import { ActivateFleetSelectionModel } from './use-cases/activate-fleet-selection-model.use-case';
import { CreateFleetSelectionModel } from './use-cases/create-fleet-selection-model.use-case';
import { SetFleetReliability } from './use-cases/set-fleet-reliability.use-case';
import { UpdateFleetSelectionModel } from './use-cases/update-fleet-selection-model.use-case';
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

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!SHIPPING_AUDIT_ACTIONS.some((definition) => definition.action === entry.action)) {
      throw new Error(`audit: unknown action ${entry.action}`);
    }
    this.entries.push(entry);
    return Promise.resolve();
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
      ActivateFleetSelectionModel,
      SetFleetReliability,
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
  let clock: FixedClock;
  let deps: ShippingDependencies;
  let drive: ScriptedFleet;

  beforeEach(() => {
    selection = new MemorySelection();
    audit = new RecordingAudit();
    clock = new FixedClock(T0);
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
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees: undefined as never,
      policy: undefined as never,
      sellers: undefined as never,
      stores: undefined as never,
      audit,
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: undefined as never,
      bookings: undefined as never,
      fleets: new ListRegistry([drive]),
      selection,
      deliverySettings: undefined as never,
      carrierPolicy: new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} }),
      pickups: undefined as never,
      webhookSignature: undefined as never,
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
  const activate = (method: unknown, modelId: unknown) =>
    new ActivateFleetSelectionModel(gate, deps).execute(admin, { method, modelId });
  const reliability = (fleet: unknown, score: unknown) =>
    new SetFleetReliability(gate, deps).execute(admin, { fleet, score });
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
      err({ code: 'shipping.fleet-model-conflict' }),
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

  it('picks the active model per method, audits each pick, and puts the default back with null', async () => {
    const model = await created('Cheapest wins');
    const picked = await activate('instant', model.id);
    expect(picked).toMatchObject({
      ok: true,
      value: { active: { instant: model.id, same_day: null, scheduled: null } },
    });
    await activate('scheduled', model.id);
    const cleared = await activate('instant', null);
    expect(cleared).toMatchObject({
      ok: true,
      value: { active: { instant: null, same_day: null, scheduled: model.id } },
    });
    expect(audit.entries.slice(1).map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      ['shipping.fleet-model.activated', 'instant', { modelId: null }, { modelId: model.id }],
      ['shipping.fleet-model.activated', 'scheduled', { modelId: null }, { modelId: model.id }],
      ['shipping.fleet-model.activated', 'instant', { modelId: model.id }, { modelId: null }],
    ]);
  });

  it('refuses a method it does not know, a model that does not exist, and a bad id', async () => {
    expect(await activate('pickup', null)).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'method', code: 'value' }] }),
    );
    expect(await activate('instant', id<'FleetSelectionModel'>(0x999))).toEqual(
      err({ code: 'shipping.fleet-model-not-found' }),
    );
    expect(await activate('instant', 'nope')).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'modelId', code: 'format' }] }),
    );
    expect(await activate('instant', undefined)).toMatchObject({ ok: false });
    expect(audit.entries).toEqual([]);
  });

  it('sets the reliability of a fleet, audits old and new, and shows it with the fleets of the Market', async () => {
    expect(await reliability('uber_direct', 80)).toMatchObject({ ok: true });
    await reliability('uber_direct', 90);
    expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      ['shipping.fleet-reliability.set', 'uber-direct', { score: null }, { score: 80 }],
      ['shipping.fleet-reliability.set', 'uber-direct', { score: 80 }, { score: 90 }],
    ]);
    const shown = await view();
    expect(
      shown.ok &&
        shown.value.fleets.map((f) => [f.fleet, f.enabled, f.reliability, f.effectiveReliability]),
    ).toEqual([
      ['mondapac_drive', true, null, 50],
      ['uber_direct', false, 90, 90],
      ['zoom2u', false, null, 50],
      ['auspost', false, null, 50],
      ['fake_test', false, null, 50],
    ]);
    expect(shown.ok && shown.value.fleets[0]!.methods).toEqual(['instant', 'scheduled']);
    expect(shown.ok && shown.value.defaultOrder).toEqual([
      'mondapac_drive',
      'uber_direct',
      'zoom2u',
      'auspost',
      'fake_test',
    ]);
  });

  it('refuses a score out of range and a fleet it does not know', async () => {
    expect(await reliability('fedex', 101)).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'fleet', code: 'value' },
          { path: 'score', code: 'range' },
        ],
      }),
    );
    expect(await reliability('zoom2u', 50.5)).toMatchObject({ ok: false });
    expect(audit.entries).toEqual([]);
  });

  it('answers only to an admin: a seller, a customer, an anonymous caller and the system are refused', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'fleet-anon-abcd');
    const system = testCallContext(market, 'system', 'fleet-system-abcd');
    for (const context of [actor('seller'), actor('customer'), anonymous, system]) {
      expect((await create('X', { kind: 'cheapest' }, context)).ok).toBe(false);
      expect((await view(context)).ok).toBe(false);
    }
    expect(selection.models.size).toBe(0);
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
