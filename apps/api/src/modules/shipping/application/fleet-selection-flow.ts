import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { CarrierMethod } from '../domain/booking-service';
import { CARRIER_METHODS } from '../domain/booking-service';
import {
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
  type SelectionRule,
} from '../domain/fleet-selection';
import type { ActorId } from './ports/fleet-selection.repository';
import type { ShippingDependencies } from './shipping-dependencies';

// The admin side of fleet selection (delivery models, package 3): define named models, pick the
// active model per delivery method in the Market, set each fleet's reliability score. Every
// change is audited in the same unit. Authorization is the use case's access declaration; these
// functions only re-check that the actor is an admin account (defence in depth).

export type FleetSelectionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly Field[] }
  | { readonly code: 'shipping.fleet-model-not-found' }
  | { readonly code: 'shipping.fleet-model-name-taken' }
  /** The model changed since the admin read it: read again and retry. */
  | { readonly code: 'shipping.fleet-model-conflict' };

/** One fleet as the admin page shows it for the Market. */
export interface FleetStatusView {
  readonly fleet: FleetCode;
  readonly displayName: string;
  /** False when no adapter is installed or the Market switched it off (it is never a candidate). */
  readonly enabled: boolean;
  readonly methods: readonly CarrierMethod[];
  /** The admin-set score, or null when none was set (the router then uses the neutral default). */
  readonly reliability: number | null;
  readonly effectiveReliability: number;
}

export interface FleetSelectionView {
  readonly models: readonly FleetSelectionModel[];
  /** The active model id per method, or null for the built-in default order. */
  readonly active: Readonly<Record<CarrierMethod, Id<'FleetSelectionModel'> | null>>;
  readonly defaultOrder: readonly FleetCode[];
  readonly fleets: readonly FleetStatusView[];
}

const adminOf = (context: CallContext): ActorId | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin'
    ? (actor.accountId as ActorId)
    : null;
};

const modelIdOf = (value: unknown): Id<'FleetSelectionModel'> | null => {
  const parsed = typeof value === 'string' ? parseId<'FleetSelectionModel'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** What an audit row records of a model. */
function shapeOf(model: { readonly rule: SelectionRule; readonly version: number }) {
  const { rule } = model;
  return {
    kind: rule.kind,
    version: model.version,
    weightPrice: rule.kind === 'weighted' ? rule.weights.price : null,
    weightEta: rule.kind === 'weighted' ? rule.weights.eta : null,
    weightReliability: rule.kind === 'weighted' ? rule.weights.reliability : null,
    order: rule.kind === 'fixed_priority' ? rule.order : [],
  };
}

async function readView(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<FleetSelectionView> {
  const { market } = context;
  const [models, assigned, scores] = await Promise.all([
    deps.selection.listModels(market),
    deps.selection.assignments(market),
    deps.selection.reliabilities(market),
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
  return { models, active, defaultOrder: DEFAULT_FLEET_ORDER, fleets };
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

/**
 * `activate-fleet-selection-model`: makes a model the active one for a delivery method in the
 * Market, or (`modelId` null) puts the built-in default order back. A model is never deleted, so
 * an assignment never dangles.
 */
export async function activateFleetSelectionModel(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly method: unknown; readonly modelId: unknown },
): Promise<Result<FleetSelectionView, FleetSelectionFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const method = parseMethod(input?.method);
  const modelId = input?.modelId === null ? null : modelIdOf(input?.modelId);
  const fields: Field[] = [
    ...(method === null ? [{ path: 'method', code: 'value' }] : []),
    ...(input?.modelId !== null && modelId === null ? [{ path: 'modelId', code: 'format' }] : []),
  ];
  if (method === null || fields.length > 0) return err({ code: 'validation.failed', fields });
  const now = deps.clock.now();
  return deps.unitOfWork.run<FleetSelectionView, FleetSelectionFailure>(
    context.market,
    async () => {
      if (modelId !== null && (await deps.selection.findModel(context.market, modelId)) === null) {
        return err({ code: 'shipping.fleet-model-not-found' });
      }
      const before = (await deps.selection.assignments(context.market)).get(method) ?? null;
      await deps.selection.assign(context.market, method, modelId, admin, now);
      await deps.audit.record(
        context,
        FleetModelActivated.entry(method, { before: { modelId: before }, after: { modelId } }),
      );
      return ok(await readView(deps, context));
    },
  );
}

/** `set-fleet-reliability`: the admin-set score (0 to 100) of a fleet in the Market. */
export async function setFleetReliability(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly fleet: unknown; readonly score: unknown },
): Promise<Result<FleetSelectionView, FleetSelectionFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fleet = isFleetCode(input?.fleet) ? input.fleet : null;
  const score = parseReliability(input?.score);
  const fields: Field[] = [
    ...(fleet === null ? [{ path: 'fleet', code: 'value' }] : []),
    ...(score === null ? [{ path: 'score', code: 'range' }] : []),
  ];
  if (fleet === null || score === null) return err({ code: 'validation.failed', fields });
  const now = deps.clock.now();
  return deps.unitOfWork.run<FleetSelectionView, FleetSelectionFailure>(
    context.market,
    async () => {
      const before = (await deps.selection.reliabilities(context.market)).get(fleet) ?? null;
      await deps.selection.setReliability(context.market, fleet, score, admin, now);
      await deps.audit.record(
        context,
        FleetReliabilitySet.entry(fleet, { before: { score: before }, after: { score } }),
      );
      return ok(await readView(deps, context));
    },
  );
}
