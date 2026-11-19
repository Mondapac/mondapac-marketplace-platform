import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ChangeScope, LastChanged } from '../../../platform/audit/change-trail';
import { CARRIER_METHODS, type CarrierMethod } from '../domain/booking-service';
import {
  auditCode,
  FleetActivationReverted,
  FleetModelActivated,
  FleetModelCreated,
  FleetModelEdited,
  FleetModelReverted,
  FleetReliabilityReverted,
  FleetReliabilitySet,
} from '../domain/audit';
import type {
  ApplyOutcome,
  ChangeValues,
  RevertOutcome,
  RevertRequest,
} from '../../system-requests';
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
import type { FleetModelCreateDependencies, ShippingDependencies } from './shipping-dependencies';
import {
  DELIVERY_REVIEW_AREA,
  FLEET_MODEL_CREATE_SUBJECT_KIND,
  FLEET_MODEL_SUBJECT_KIND,
  FLEET_SELECTION_SUBJECT_KIND,
  FLEET_SELECTION_SUBJECT_REF,
  deliveryReview,
  fleetModelNameRef,
  isActingAs,
  requestRef,
  reverterOf,
  type ShippingProposal,
  type ShippingRequestRef,
  type ShippingReview,
} from './shipping-review';

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

/** The fleets page with whether a change is reviewed and the review a save opened. */
export interface FleetSelectionReviewedView extends FleetSelectionView {
  /** Whether a change is reviewed in Admin Inbox › System requests: the page then asks for a note. */
  readonly review: ShippingReview;
  /** The review the save opened; null on a read, when delivery is not reviewed or nothing changed. */
  readonly request: ShippingRequestRef;
}

/** An edited model and the review the edit opened (null when none). */
export type FleetModelChange = FleetSelectionModel & { readonly request: ShippingRequestRef };

/** The fleets page's read model: the view and the latest change. */
export interface FleetSelectionPage extends FleetSelectionReviewedView {
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
    FleetModelReverted.action,
    FleetActivationReverted.action,
    FleetReliabilityReverted.action,
  ],
  targetId: null,
  fixedFields: {
    [FleetModelCreated.action]: ['model'],
    [FleetModelActivated.action]: ['activeModel'],
    [FleetReliabilitySet.action]: ['reliability'],
    [FleetActivationReverted.action]: ['activeModel'],
    [FleetReliabilityReverted.action]: ['reliability'],
  },
  ignoreKeys: ['requestId'],
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
): Promise<Result<FleetSelectionReviewedView, FleetSelectionFailure>> {
  if (adminOf(context) === null) return Promise.resolve(err({ code: 'access.denied' }));
  return viewReviewed(deps, context);
}

async function viewReviewed(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<Result<FleetSelectionReviewedView, FleetSelectionFailure>> {
  // Its own read-only unit, before this one (units do not nest).
  const review = await deliveryReview(deps, context);
  return deps.unitOfWork.run<FleetSelectionReviewedView, FleetSelectionFailure>(
    context.market,
    async () => ok({ ...(await readView(deps, context)), review, request: null }),
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

/** A created model, or the proposal filed where its create waits for a second admin's approval. */
export type FleetModelCreateAnswer = FleetSelectionModel | ShippingProposal;

export type FleetModelCreateFailure =
  | FleetSelectionFailure
  /** Another proposal of a model with this name waits for approval (its number). */
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

/**
 * `create-fleet-selection-model`: a new named model, version 1; the name is unique in the Market.
 *
 * A model has no delete, so a reviewer could not undo its create: where the Market reviews area
 * delivery the create waits for a second admin's approval instead (owner decision of 18 Nov 2026,
 * "mixed"). After the same checks (the input, then the name in the open unit) the proposal is
 * filed with the admin's `note` and nothing is written in shipping; the answer is only
 * `{request}`. The approval creates the model through {@link createModelInUnit}
 * (shipping-appliers.ts). Where the area is not reviewed the model is created at once, as before.
 */
export async function createFleetSelectionModel(
  deps: FleetModelCreateDependencies,
  context: CallContext,
  input: { readonly name: unknown; readonly rule: unknown; readonly note?: unknown },
): Promise<Result<FleetModelCreateAnswer, FleetModelCreateFailure>> {
  const admin = adminOf(context);
  // Never in an acting-as session, reviewed or not (the proposer refuses one too).
  if (admin === null || isActingAs(context)) return err({ code: 'access.denied' });
  const parsed = parseModelInput(input);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.fields });
  const asked = { name: parsed.name, rule: parsed.rule };
  return deps.unitOfWork.run<FleetModelCreateAnswer, FleetModelCreateFailure>(
    context.market,
    async () => {
      if (await deps.selection.nameTaken(context.market, asked.name)) {
        return err({ code: 'shipping.fleet-model-name-taken' });
      }
      const proposed = await deps.proposer.proposeChange(context, {
        area: DELIVERY_REVIEW_AREA,
        subjectKind: FLEET_MODEL_CREATE_SUBJECT_KIND,
        subjectRef: fleetModelNameRef(asked.name),
        before: NO_MODEL_BEFORE,
        after: modelProposalValues(asked),
        note: input?.note,
      });
      if (!proposed.ok) return err(proposed.error);
      const request = requestRef(proposed.value);
      if (request !== null) return ok({ request });
      return createModelInUnit(deps, context, admin, asked, null);
    },
  );
}

/**
 * Writes a new model inside the open unit: version 1, the name checked against the Market's
 * models, and its audit row naming the request whose approval created it (null for an admin's
 * own create). Shared by the route and the approval of a proposed create.
 */
export async function createModelInUnit(
  deps: ShippingDependencies,
  context: CallContext,
  admin: ActorId,
  asked: { readonly name: string; readonly rule: SelectionRule },
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<FleetSelectionModel, FleetSelectionFailure>> {
  const now: Temporal.Instant = deps.clock.now();
  const model: FleetSelectionModel = {
    id: deps.ids.next<'FleetSelectionModel'>(),
    name: asked.name,
    rule: asked.rule,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  if ((await deps.selection.insertModel(context.market, model, admin)) === 'name-taken') {
    return err({ code: 'shipping.fleet-model-name-taken' });
  }
  await deps.audit.record(
    context,
    FleetModelCreated.entry(model.id, { after: { ...shapeOf(model), requestId } }),
  );
  return ok(model);
}

/** What a proposed model holds before its create: nothing. */
const NO_MODEL_BEFORE: ChangeValues = { exists: false };

/** A proposed model as the values of a request: the action, the name and the rule. */
function modelProposalValues(asked: {
  readonly name: string;
  readonly rule: SelectionRule;
}): ChangeValues {
  return { action: 'create', ...modelValues(asked) };
}

/**
 * The model a proposal's values ask for, checked as the route checks it; null when they are not
 * a proposed create of this module or no longer validate (a fleet code that was retired, ...).
 */
export function modelProposalOf(
  values: unknown,
): { readonly name: string; readonly rule: SelectionRule } | null {
  if (!isRecord(values) || values.action !== 'create') return null;
  const keys = Object.keys(values).sort();
  if (keys.length !== 3 || keys[0] !== 'action' || keys[1] !== 'name' || keys[2] !== 'rule') {
    return null;
  }
  const parsed = parseModelInput({ name: values.name, rule: values.rule });
  return parsed.ok ? { name: parsed.name, rule: parsed.rule } : null;
}

/**
 * Applies an approved proposal of a new model, in the open unit of the approval, as the approving
 * admin: the values are checked again as the route checks them, a name another model took
 * meanwhile is `changed-since`, and the model is written through {@link createModelInUnit}, its
 * audit row naming the request. Nothing is written on any other answer.
 */
export async function applyFleetModelCreate(
  deps: ShippingDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<ApplyOutcome> {
  const admin = reverterOf(context);
  const asked = modelProposalOf(request.after);
  if (asked === null || request.before.exists !== false) return 'gone';
  // The subject is the name: values that name another subject are not this request's.
  if (request.subjectRef !== fleetModelNameRef(asked.name)) return 'gone';
  if (await deps.selection.nameTaken(context.market, asked.name)) return 'changed-since';
  const created = await createModelInUnit(deps, context, admin, asked, request.requestId);
  if (created.ok) return 'applied';
  return created.error.code === 'shipping.fleet-model-name-taken'
    ? 'changed-since'
    : 'not-permitted';
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
    readonly note?: unknown;
  },
): Promise<Result<FleetModelChange, FleetSelectionFailure>> {
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
  return deps.unitOfWork.run<FleetModelChange, FleetSelectionFailure>(context.market, async () => {
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
    // The edit is live; its review opens in the same unit (a refusal rolls it back).
    const review = await deps.review.openReview(context, {
      area: DELIVERY_REVIEW_AREA,
      subjectKind: FLEET_MODEL_SUBJECT_KIND,
      subjectRef: modelId,
      before: modelValues(before),
      after: modelValues(after),
      note: input.note,
    });
    if (!review.ok) return err(review.error);
    return ok({ ...after, request: requestRef(review.value) });
  });
}

/** A model's name and rule as the values of a request. */
function modelValues(model: { readonly name: string; readonly rule: SelectionRule }): ChangeValues {
  const { rule } = model;
  return {
    name: model.name,
    rule:
      rule.kind === 'cheapest'
        ? { kind: rule.kind }
        : rule.kind === 'weighted'
          ? { kind: rule.kind, weights: { ...rule.weights } }
          : { kind: rule.kind, order: [...rule.order] },
  };
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
    readonly note?: unknown;
  },
): Promise<Result<FleetSelectionReviewedView, FleetSelectionFailure>> {
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
  const reviewPolicy = await deliveryReview(deps, context);
  return deps.unitOfWork.run<FleetSelectionReviewedView, FleetSelectionFailure>(
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
      // What changed, for the review: only the items that did.
      const activeBefore: Record<string, string | null> = {};
      const activeAfter: Record<string, string | null> = {};
      const scoresBefore: Record<string, number | null> = {};
      const scoresAfter: Record<string, number | null> = {};
      for (const [method, modelId] of active) {
        const before = assigned.get(method) ?? null;
        if (before === modelId) continue;
        activeBefore[method] = before;
        activeAfter[method] = modelId;
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
        scoresBefore[fleet] = before;
        scoresAfter[fleet] = score;
        await deps.selection.setReliability(context.market, fleet, score, admin, now);
        await deps.audit.record(
          context,
          FleetReliabilitySet.entry(auditCode<AuditFleet>(fleet), {
            before: { score: before },
            after: { score },
          }),
        );
      }
      // The change is live; its review opens in the same unit (a refusal rolls it back). The page
      // version bump above is the row lock; nothing changed opens nothing.
      const review = await deps.review.openReview(context, {
        area: DELIVERY_REVIEW_AREA,
        subjectKind: FLEET_SELECTION_SUBJECT_KIND,
        subjectRef: FLEET_SELECTION_SUBJECT_REF,
        before: { active: activeBefore, reliability: scoresBefore },
        after: { active: activeAfter, reliability: scoresAfter },
        note: input.note,
      });
      if (!review.ok) return err(review.error);
      return ok({
        ...(await readView(deps, context)),
        review: reviewPolicy,
        request: requestRef(review.value),
      });
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Reverts (Admin Inbox › System requests): run in the open unit of a reviewer's decision

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `{method: modelId | null}` of a request's values, or null when it is not that. */
function activeOfValues(
  value: unknown,
): Map<CarrierMethod, Id<'FleetSelectionModel'> | null> | null {
  if (!isRecord(value)) return null;
  const out = new Map<CarrierMethod, Id<'FleetSelectionModel'> | null>();
  for (const [key, item] of Object.entries(value)) {
    const method = parseMethod(key);
    if (method === null) return null;
    if (item === null) out.set(method, null);
    else {
      const id = modelIdOf(item);
      if (id === null) return null;
      out.set(method, id);
    }
  }
  return out;
}

/** `{fleet: score | null}` of a request's values, or null when it is not that. */
function scoresOfValues(value: unknown): Map<FleetCode, number | null> | null {
  if (!isRecord(value)) return null;
  const out = new Map<FleetCode, number | null>();
  for (const [key, item] of Object.entries(value)) {
    if (!isFleetCode(key)) return null;
    if (item === null) out.set(key, null);
    else {
      const score = parseReliability(item);
      if (score === null) return null;
      out.set(key, score);
    }
  }
  return out;
}

const sameKeys = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean =>
  a.size === b.size && [...a.keys()].every((key) => b.has(key));

/**
 * Restores the active model per method and the reliability scores a rejected or withdrawn save of
 * the fleets page changed, only while each of them still holds the value after the save. The page
 * version is compared and raised first, as an admin's save does. A model that no longer exists is
 * gone. A fleet that had no score gets the neutral default back, which routes the same (the
 * table has no delete).
 */
export async function revertFleetSelection(
  deps: ShippingDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  const admin = reverterOf(context);
  const restoreActive = activeOfValues(request.before.active);
  const expectedActive = activeOfValues(request.after.active);
  const restoreScores = scoresOfValues(request.before.reliability);
  const expectedScores = scoresOfValues(request.after.reliability);
  if (
    restoreActive === null ||
    expectedActive === null ||
    restoreScores === null ||
    expectedScores === null ||
    !sameKeys(restoreActive, expectedActive) ||
    !sameKeys(restoreScores, expectedScores)
  ) {
    return 'gone';
  }
  // The version compare-and-bump comes first: it is the row lock, so a save that commits after it
  // waits for this decision and one that committed before it is seen by the compare below.
  const now = deps.clock.now();
  const version = await deps.selection.selectionVersion(context.market);
  if (
    (await deps.selection.bumpSelectionVersion(context.market, version, admin, now)) === 'conflict'
  ) {
    return 'changed-since';
  }
  const assigned = await deps.selection.assignments(context.market);
  for (const [method, modelId] of expectedActive) {
    if ((assigned.get(method) ?? null) !== modelId) return 'changed-since';
  }
  const stored = await deps.selection.reliabilities(context.market);
  for (const [fleet, score] of expectedScores) {
    if ((stored.get(fleet) ?? null) !== score) return 'changed-since';
  }
  for (const modelId of new Set(restoreActive.values())) {
    if (modelId !== null && (await deps.selection.findModel(context.market, modelId)) === null) {
      return 'gone';
    }
  }
  for (const [method, modelId] of restoreActive) {
    const current = assigned.get(method) ?? null;
    await deps.selection.assign(context.market, method, modelId, admin, now);
    await deps.audit.record(
      context,
      FleetActivationReverted.entry(auditCode<'instant' | 'same-day' | 'scheduled'>(method), {
        before: { modelId: current },
        after: { modelId, requestId: request.requestId },
      }),
    );
  }
  for (const [fleet, score] of restoreScores) {
    const current = stored.get(fleet) ?? null;
    const restored = score ?? DEFAULT_RELIABILITY;
    await deps.selection.setReliability(context.market, fleet, restored, admin, now);
    await deps.audit.record(
      context,
      FleetReliabilityReverted.entry(auditCode<AuditFleet>(fleet), {
        before: { score: current },
        after: { score: restored, requestId: request.requestId },
      }),
    );
  }
  return 'reverted';
}

/**
 * Restores the name and rule of a model before a rejected or withdrawn edit, as a new version,
 * only while the model still holds the name and rule after it. A name another model took since is
 * `changed-since`; a model that does not exist is gone.
 */
export async function revertFleetSelectionModel(
  deps: ShippingDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  const admin = reverterOf(context);
  const modelId = modelIdOf(request.subjectRef);
  if (modelId === null) return 'gone';
  const restore = parseModelInput(request.before as { name: unknown; rule: unknown });
  const expected = parseModelInput(request.after as { name: unknown; rule: unknown });
  if (!restore.ok || !expected.ok) return 'gone';
  const current = await deps.selection.findModel(context.market, modelId);
  if (current === null) return 'gone';
  if (!sameJson(modelValues(current), modelValues(expected))) return 'changed-since';
  const restored: FleetSelectionModel = {
    ...current,
    name: restore.name,
    rule: restore.rule,
    version: current.version + 1,
    updatedAt: deps.clock.now(),
  };
  const saved = await deps.selection.saveModel(context.market, restored, current.version, admin);
  if (saved !== 'saved') return 'changed-since';
  await deps.audit.record(
    context,
    FleetModelReverted.entry(modelId, {
      before: shapeOf(current),
      after: { ...shapeOf(restored), requestId: request.requestId },
    }),
  );
  return 'reverted';
}
