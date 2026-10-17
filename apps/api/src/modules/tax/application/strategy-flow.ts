import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  TaxStrategyActivated,
  TaxStrategyCreated,
  TaxStrategyDeactivated,
  TaxStrategyDeleted,
  TaxStrategyUpdated,
} from '../domain/audit';
import { parseStrategyDraft, type TaxStrategyParams } from '../domain/strategy';
import type { StrategyRecord } from './ports/strategy.repository';
import type { TaxDependencies } from './tax-dependencies';

// Tax strategies (admin settings): an admin defines how tax is worked out for the Market, and
// picks the one in force. A change applies to orders placed after it; the module that placed an
// order freezes the answer it was given. With no active strategy the Market's built-in flat
// strategy (Market config) applies. Each change is audited.

export type StrategyFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'tax.strategy-not-found' }
  /** The active strategy cannot be deleted; switch to another one first. */
  | { readonly code: 'tax.strategy-active' }
  | { readonly code: 'tax.unavailable' };

export interface StrategyView {
  readonly id: Id<'TaxStrategy'>;
  readonly name: string;
  readonly params: TaxStrategyParams;
  readonly active: boolean;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface StrategyListView {
  /** The Market's built-in strategy, in force while no strategy is active. */
  readonly builtInRateBps: number;
  readonly activeStrategyId: Id<'TaxStrategy'> | null;
  /** The tax category codes a by-category strategy may name. */
  readonly categoryCodes: readonly string[];
  readonly strategies: readonly StrategyView[];
}

const view = (record: StrategyRecord): StrategyView => ({ ...record });

const summary = (params: TaxStrategyParams) => ({
  kind: params.kind,
  rateBps: params.kind === 'flat-rate' ? params.rateBps : params.defaultRateBps,
  categoryCount: params.kind === 'flat-rate' ? 0 : Object.keys(params.categoryRatesBps).length,
});

const strategyIdOf = (value: unknown): Id<'TaxStrategy'> | null => {
  const parsed = typeof value === 'string' ? parseId<'TaxStrategy'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const invalidId = (path: string): StrategyFailure => ({
  code: 'validation.failed',
  fields: [{ path, code: 'format' }],
});

function admin(context: CallContext) {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor : null;
}

/** An admin reads the Market's strategies, the active one and the built-in rate. */
export async function listStrategies(
  deps: TaxDependencies,
  context: CallContext,
): Promise<Result<StrategyListView, StrategyFailure>> {
  if (admin(context) === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'tax.unavailable' });
  return deps.unitOfWork.run<StrategyListView, StrategyFailure>(
    context.market,
    async () => {
      const records = await deps.strategies.list(context.market);
      return ok({
        builtInRateBps: settings.defaultRateBps,
        activeStrategyId: records.find((record) => record.active)?.id ?? null,
        categoryCodes: settings.categoryCodes,
        strategies: records.map(view),
      });
    },
    { readOnly: true },
  );
}

/** An admin defines a new strategy (inactive until activated). */
export async function createStrategy(
  deps: TaxDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<StrategyView, StrategyFailure>> {
  const actor = admin(context);
  if (actor === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'tax.unavailable' });
  const draft = parseStrategyDraft(input, settings.categoryCodes);
  if (!draft.ok) return err({ code: 'validation.failed', fields: draft.error });

  const now = deps.clock.now();
  const id = deps.ids.next<'TaxStrategy'>();
  return deps.unitOfWork.run<StrategyView, StrategyFailure>(context.market, async () => {
    await deps.strategies.insert(context.market, {
      id,
      name: draft.value.name,
      params: draft.value.params,
      createdAt: now,
      updatedBy: actor.accountId,
    });
    await deps.audit.record(
      context,
      TaxStrategyCreated.entry(id, { after: summary(draft.value.params) }),
    );
    return ok({
      id,
      name: draft.value.name,
      params: draft.value.params,
      active: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** An admin changes a strategy's name or parameters (also while it is active). */
export async function updateStrategy(
  deps: TaxDependencies,
  context: CallContext,
  input: { readonly strategyId: unknown; readonly body: unknown },
): Promise<Result<StrategyView, StrategyFailure>> {
  const actor = admin(context);
  if (actor === null) return err({ code: 'access.denied' });
  const id = strategyIdOf(input?.strategyId);
  if (id === null) return err(invalidId('strategyId'));
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'tax.unavailable' });
  const draft = parseStrategyDraft(input.body, settings.categoryCodes);
  if (!draft.ok) return err({ code: 'validation.failed', fields: draft.error });

  const now = deps.clock.now();
  return deps.unitOfWork.run<StrategyView, StrategyFailure>(context.market, async () => {
    const before = await deps.strategies.findForUpdate(context.market, id);
    if (before === null) return err({ code: 'tax.strategy-not-found' } as const);
    await deps.strategies.update(context.market, {
      id,
      name: draft.value.name,
      params: draft.value.params,
      updatedAt: now,
      updatedBy: actor.accountId,
    });
    await deps.audit.record(
      context,
      TaxStrategyUpdated.entry(id, {
        before: summary(before.params),
        after: summary(draft.value.params),
      }),
    );
    return ok({
      ...before,
      name: draft.value.name,
      params: draft.value.params,
      updatedAt: now,
    });
  });
}

/** An admin removes a strategy that is not active. */
export async function deleteStrategy(
  deps: TaxDependencies,
  context: CallContext,
  input: { readonly strategyId: unknown },
): Promise<Result<{ readonly deleted: true }, StrategyFailure>> {
  if (admin(context) === null) return err({ code: 'access.denied' });
  const id = strategyIdOf(input?.strategyId);
  if (id === null) return err(invalidId('strategyId'));
  return deps.unitOfWork.run<{ readonly deleted: true }, StrategyFailure>(
    context.market,
    async () => {
      const before = await deps.strategies.findForUpdate(context.market, id);
      if (before === null) return err({ code: 'tax.strategy-not-found' } as const);
      if (before.active) return err({ code: 'tax.strategy-active' } as const);
      await deps.strategies.remove(context.market, id);
      await deps.audit.record(
        context,
        TaxStrategyDeleted.entry(id, { before: summary(before.params) }),
      );
      return ok({ deleted: true } as const);
    },
  );
}

/**
 * An admin makes one strategy the Market's active one, or (`strategyId` null) puts the Market
 * back on the built-in strategy. Answers the list as it now stands.
 */
export async function activateStrategy(
  deps: TaxDependencies,
  context: CallContext,
  input: { readonly strategyId: unknown },
): Promise<Result<StrategyListView, StrategyFailure>> {
  const actor = admin(context);
  if (actor === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'tax.unavailable' });
  const requested = input?.strategyId;
  const id = requested === null ? null : strategyIdOf(requested);
  if (requested !== null && id === null) return err(invalidId('strategyId'));

  const stamp = { updatedAt: deps.clock.now(), updatedBy: actor.accountId };
  return deps.unitOfWork.run<StrategyListView, StrategyFailure>(context.market, async () => {
    const target = id === null ? null : await deps.strategies.findForUpdate(context.market, id);
    if (id !== null && target === null) return err({ code: 'tax.strategy-not-found' } as const);
    const current = await deps.strategies.findActive(context.market);
    if (current?.id !== id) {
      if (current !== null) {
        await deps.strategies.deactivateAll(context.market, stamp);
        await deps.audit.record(
          context,
          TaxStrategyDeactivated.entry(current.id, { before: summary(current.params) }),
        );
      }
      if (id !== null) {
        await deps.strategies.activate(context.market, id, stamp);
        await deps.audit.record(
          context,
          TaxStrategyActivated.entry(id, { before: { replacedActive: current !== null } }),
        );
      }
    }
    const records = await deps.strategies.list(context.market);
    return ok({
      builtInRateBps: settings.defaultRateBps,
      activeStrategyId: records.find((record) => record.active)?.id ?? null,
      categoryCodes: settings.categoryCodes,
      strategies: records.map(view),
    });
  });
}
