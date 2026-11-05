import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ChangeScope, LastChanged } from '../../../platform/audit/change-trail';
import { CARRIER_METHODS, type CarrierMethod } from '../domain/booking-service';
import {
  auditCode,
  FleetModelActivated,
  FleetModelCreated,
  FleetModelEdited,
  FleetReliabilitySet,
} from '../domain/audit';
import { DEFAULT_FLEET_ORDER, FLEET_CODES, isFleetCode, type FleetCode } from '../domain/fleet';
import {
  DEFAULT_RELIABILITY,
  parseMethod,
  parseModelName,
  parseReliability,
  parseSelectionRule,
  type Field,
  type FleetSelectionModel,
  type FleetSelectionView,
  type FleetStatusView,
  type SelectionRule,
} from '../domain/fleet-selection';

export type { FleetSelectionView, FleetStatusView } from '../domain/fleet-selection';
import type { ActorId } from './ports/fleet-selection.repository';
import type { ShippingDependencies } from './shipping-dependencies';

// The admin side of fleet selection (delivery models, package 3): define named models, pick the
// active model per delivery method in the Market and set each fleet's reliability score (both in
// one batch save guarded by a page version, settings S4). Every
// change is audited in the same unit. Authorization is the use case's access declaration; these
// functions only re-check that the actor is an admin account (defence in depth).

type AuditFleet =
  'mondapac-drive' | 'uber-direct' | 'zoom2u' | 'doordash-drive' | 'auspost' | 'fake-test';

export type FleetSelectionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly Field[] }
  | { readonly code: 'shipping.fleet-model-not-found' }
  | { readonly code: 'shipping.fleet-model-name-taken' }
  /**
   * The model changed since the admin read it: read again and retry. `lastChanged` is the
   * winning save, null when it cannot be read.
   */
  | { readonly code: 'shipping.fleet-model-conflict'; readonly lastChanged?: LastChanged | null }
  /** The page changed since the admin read it: read again and retry. As above. */
  | {
      readonly code: 'shipping.fleet-selection-conflict';
      readonly lastChanged?: LastChanged | null;
    };

/** The fleets page's read model: the view and the latest change. */
export interface FleetSelectionPage extends FleetSelectionView {
  /** Null while no model was made, no model made active and no score set. */
  readonly lastChanged: LastChanged | null;
}

/**
 * The audit rows of the fleets page: the models, the active model per method and the reliability
 * scores. All are Market-wide admin settings, so every target is read. A created model, an
 * activation and a score name one field each; an edit names the model fields that changed.
 */
export const FLEET_SELECTION_CHANGES: ChangeScope = {
  actions: [
    FleetModelCreated.action,
    FleetModelEdited.action,
    FleetModelActivated.action,
    FleetReliabilitySet.action,
  ],
  targetId: null,
  fixedFields: {
    [FleetModelCreated.action]: ['model'],
    [FleetModelActivated.action]: ['activeModel'],
    [FleetReliabilitySet.action]: ['reliability'],
  },
};

/** The conflict codes of the fleets page and its models. */
export const FLEET_SELECTION_CONFLICTS = [
  'shipping.fleet-model-conflict',
  'shipping.fleet-selection-conflict',
] as const;

const adminOf = (context: CallContext): ActorId | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor.accountId : null;
};

const modelIdOf = (value: unknown): Id<'FleetSelectionModel'> | null => {
  const parsed = typeof value === 'string' ? parseId<'FleetSelectionModel'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** What an audit row records of a model. */
function shapeOf(model: { readonly rule: SelectionRule; readonly version: number }) {
  const { rule } = model;
  return {
    kind: auditCode<'cheapest' | 'weighted' | 'fixed-priority'>(rule.kind),
    version: model.version,
    weightPrice: rule.kind === 'weighted' ? rule.weights.price : null,
    weightEta: rule.kind === 'weighted' ? rule.weights.eta : null,
    weightReliability: rule.kind === 'weighted' ? rule.weights.reliability : null,
    order:
      rule.kind === 'fixed_priority' ? rule.order.map((fleet) => auditCode<AuditFleet>(fleet)) : [],
  };
}

async function readView(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<FleetSelectionView> {
  const { market } = context;
  const [models, assigned, scores, version] = await Promise.all([
    deps.selection.listModels(market),
    deps.selection.assignments(market),
    deps.selection.reliabilities(market),
    deps.selection.selectionVersion(market),
  ]);
  const known = new Set(models.map((model) => model.id));
  const active = Object.fromEntries(
    CARRIER_METHODS.map((method) => {
      const id = assigned.get(method) ?? null;
      return [method, id !== null && known.has(id) ? id : null];
    }),
  ) as FleetSelectionView['active'];
  const fleets = FLEET_CODES.map((fleet): FleetStatusView => {
    const capabilities = deps.fleets.get(fleet)?.capabilities(market) ?? null;
    return {
      fleet,
      displayName: deps.carrierPolicy.fleetDisplayName(market, fleet),
      enabled: capabilities !== null,
      methods: capabilities?.methods ?? [],
      reliability: scores.get(fleet) ?? null,
      effectiveReliability: scores.get(fleet) ?? DEFAULT_RELIABILITY,
    };
  });
  return { version, models, active, defaultOrder: DEFAULT_FLEET_ORDER, fleets };
}

/** `view-fleet-selection`: the models, the active model per method and the fleets of the Market. */
export function viewFleetSelection(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<Result<FleetSelectionView, FleetSelectionFailure>> {
  if (adminOf(context) === null) return Promise.resolve(err({ code: 'access.denied' }));
  return deps.unitOfWork.run<FleetSelectionView, FleetSelectionFailure>(
    context.market,
    async () => ok(await readView(deps, context)),
    { readOnly: true },
  );
}

function parseModelInput(input: {
  readonly name: unknown;
  readonly rule: unknown;
}):
  | { readonly ok: true; readonly name: string; readonly rule: SelectionRule }
  | { readonly ok: false; readonly fields: readonly Field[] } {
  const name = parseModelName(input?.name);
  const rule = parseSelectionRule(input?.rule);
  const fields = [...(name.ok ? [] : [name.field]), ...(rule.ok ? [] : rule.fields)];
  return name.ok && rule.ok
    ? { ok: true, name: name.name, rule: rule.rule }
    : { ok: false, fields };
}

/** `create-fleet-selection-model`: a new named model, version 1; the name is unique in the Market. */
export async function createFleetSelectionModel(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly name: unknown; readonly rule: unknown },
): Promise<Result<FleetSelectionModel, FleetSelectionFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parseModelInput(input);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.fields });
  const now: Temporal.Instant = deps.clock.now();
  const model: FleetSelectionModel = {
    id: deps.ids.next<'FleetSelectionModel'>(),
    name: parsed.name,
    rule: parsed.rule,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  return deps.unitOfWork.run<FleetSelectionModel, FleetSelectionFailure>(
    context.market,
    async () => {
      if ((await deps.selection.insertModel(context.market, model, admin)) === 'name-taken') {
        return err({ code: 'shipping.fleet-model-name-taken' });
      }
      await deps.audit.record(
        context,
        FleetModelCreated.entry(model.id, { after: shapeOf(model) }),
      );
      return ok(model);
    },
  );
}

/** `update-fleet-selection-model`: renames or reshapes a model; `expectedVersion` guards a stale page. */
export async function updateFleetSelectionModel(
  deps: ShippingDependencies,
  context: CallContext,
  input: {
    readonly modelId: unknown;
    readonly name: unknown;
    readonly rule: unknown;
    readonly expectedVersion: unknown;
  },
): Promise<Result<FleetSelectionModel, FleetSelectionFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const modelId = modelIdOf(input?.modelId);
  const parsed = parseModelInput(input);
  const version = input?.expectedVersion;
  const fields: Field[] = [
    ...(modelId === null ? [{ path: 'modelId', code: 'format' }] : []),
    ...(parsed.ok ? [] : parsed.fields),
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 1
      ? []
      : [{ path: 'expectedVersion', code: 'range' }]),
  ];
  if (modelId === null || !parsed.ok || typeof version !== 'number' || fields.length > 0) {
    return err({ code: 'validation.failed', fields });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<FleetSelectionModel, FleetSelectionFailure>(
    context.market,
    async () => {
      const before = await deps.selection.findModel(context.market, modelId);
      if (before === null) return err({ code: 'shipping.fleet-model-not-found' });
      if (before.version !== version) return err({ code: 'shipping.fleet-model-conflict' });
      const after: FleetSelectionModel = {
        ...before,
        name: parsed.name,
        rule: parsed.rule,
        version: before.version + 1,
        updatedAt: now,
      };
      const saved = await deps.selection.saveModel(context.market, after, version, admin);
      if (saved === 'name-taken') return err({ code: 'shipping.fleet-model-name-taken' });
      if (saved === 'conflict') return err({ code: 'shipping.fleet-model-conflict' });
      await deps.audit.record(
        context,
        FleetModelEdited.entry(modelId, { before: shapeOf(before), after: shapeOf(after) }),
      );
      return ok(after);
    },
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `set-fleet-selection`: saves the whole fleet-selection page in one unit: the active model per
 * delivery method (`modelId` or null for the built-in default order; every method present) and
 * the reliability score per fleet (0 to 100; null or absent leaves the fleet as it is). The page
 * version is compared and raised first, so a stale page is `shipping.fleet-selection-conflict`
 * and nothing is written. Only the items that changed are written and audited. A model is never
 * deleted, so an assignment never dangles; a model id of another Market is not found.
 */
export async function setFleetSelection(
  deps: ShippingDependencies,
  context: CallContext,
  input: {
    readonly expectedVersion: unknown;
    readonly active: unknown;
    readonly reliability: unknown;
  },
): Promise<Result<FleetSelectionView, FleetSelectionFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: Field[] = [];
  const version = input?.expectedVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    fields.push({ path: 'expectedVersion', code: 'range' });
  }

  const active = new Map<CarrierMethod, Id<'FleetSelectionModel'> | null>();
  if (!isRecord(input?.active)) {
    fields.push({ path: 'active', code: 'format' });
  } else {
    for (const key of Object.keys(input.active)) {
      if (parseMethod(key) === null) fields.push({ path: `active.${key}`, code: 'unknown-field' });
    }
    for (const method of CARRIER_METHODS) {
      const value = input.active[method];
      if (value === null) active.set(method, null);
      else if (value === undefined) fields.push({ path: `active.${method}`, code: 'required' });
      else {
        const modelId = modelIdOf(value);
        if (modelId === null) fields.push({ path: `active.${method}`, code: 'format' });
        else active.set(method, modelId);
      }
    }
  }

  const scores = new Map<FleetCode, number>();
  if (!isRecord(input?.reliability)) {
    fields.push({ path: 'reliability', code: 'format' });
  } else {
    for (const [key, value] of Object.entries(input.reliability)) {
      if (!isFleetCode(key)) {
        fields.push({ path: `reliability.${key}`, code: 'unknown-field' });
      } else if (value !== null) {
        const score = parseReliability(value);
        if (score === null) fields.push({ path: `reliability.${key}`, code: 'range' });
        else scores.set(key, score);
      }
    }
  }
  if (fields.length > 0 || typeof version !== 'number') {
    return err({ code: 'validation.failed', fields });
  }

  const now = deps.clock.now();
  return deps.unitOfWork.run<FleetSelectionView, FleetSelectionFailure>(
    context.market,
    async () => {
      for (const modelId of new Set(active.values())) {
        if (
          modelId !== null &&
          (await deps.selection.findModel(context.market, modelId)) === null
        ) {
          return err({ code: 'shipping.fleet-model-not-found' });
        }
      }
      // The compare-and-bump is the first write: a stale page writes nothing at all.
      if (
        (await deps.selection.bumpSelectionVersion(context.market, version, admin, now)) ===
        'conflict'
      ) {
        return err({ code: 'shipping.fleet-selection-conflict' });
      }
      const assigned = await deps.selection.assignments(context.market);
      for (const [method, modelId] of active) {
        const before = assigned.get(method) ?? null;
        if (before === modelId) continue;
        await deps.selection.assign(context.market, method, modelId, admin, now);
        await deps.audit.record(
          context,
          FleetModelActivated.entry(auditCode<'instant' | 'same-day' | 'scheduled'>(method), {
            before: { modelId: before },
            after: { modelId },
          }),
        );
      }
      const stored = await deps.selection.reliabilities(context.market);
      for (const [fleet, score] of scores) {
        const before = stored.get(fleet) ?? null;
        if (before === score) continue;
        await deps.selection.setReliability(context.market, fleet, score, admin, now);
        await deps.audit.record(
          context,
          FleetReliabilitySet.entry(auditCode<AuditFleet>(fleet), {
            before: { score: before },
            after: { score },
          }),
        );
      }
      return ok(await readView(deps, context));
    },
  );
}
