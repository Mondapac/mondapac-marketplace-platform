import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer, StepUpRefusal } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { ORDERING_SHIP_TO_RETENTION_STEP_UP } from '../contracts/step-up';
import { ShipToPurged, ShipToRetentionChanged } from '../domain/audit';
import {
  DEFAULT_SHIP_TO_RETENTION,
  parseShipToRetentionInput,
  SHIP_TO_PURGE_BATCH,
  shipToRetentionCutoff,
  type ShipToRetention,
} from '../domain/ship-to-retention';
import { isActingAsSession } from './acting-as';
import type {
  MarketZones,
  ShipToPurgeBatch,
  ShipToPurgeCursor,
  ShipToRetentionRepository,
} from './ports/ship-to-retention.repository';

// How long the sealed ship-to of a delivered order is kept (owner decision 2026-11-15). An admin
// reads the Market's setting with `ordering.ship-to-retention.view` and changes it with
// `ordering.ship-to-retention.manage` (protected) and a fresh two-step code, spent in the same unit;
// each change is audited before and after, and a stale edit is refused. With the setting on, the
// daily job (system actor) clears the sealed ship-to of every order whose seller orders were all
// delivered at least `months` months ago in the Market's zone, one bounded batch per unit, and
// writes one audit row per run with the count. Off, or never set, the job does nothing.

export interface ShipToRetentionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly retention: ShipToRetentionRepository;
  readonly zones: MarketZones;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The setting as the admin panel shows it; `version` 0 and no author while never set. */
export interface ShipToRetentionView {
  readonly enabled: boolean;
  readonly months: number;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: Id<'Account'> | null;
}

export type ShipToRetentionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** Another admin changed the setting since it was read: read again. */
  | { readonly code: 'conflict.retry' }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string };

/** What one run of the purge did in a Market. */
export interface ShipToPurgeRun {
  /**
   * `disabled`: off or never set, nothing looked at. `partial`: stopped at the batch bound, or
   * because the setting changed during the run; the next run goes on.
   */
  readonly outcome: 'disabled' | 'complete' | 'partial';
  readonly cleared: number;
}

/** The most batches one run clears; the rest waits for the next day's run. */
export const SHIP_TO_PURGE_MAX_BATCHES = 100;

function view(setting: ShipToRetention | null): ShipToRetentionView {
  return setting === null
    ? { ...DEFAULT_SHIP_TO_RETENTION, version: 0, updatedAt: null, updatedBy: null }
    : {
        enabled: setting.enabled,
        months: setting.months,
        version: setting.version,
        updatedAt: setting.updatedAt.toString(),
        updatedBy: setting.updatedBy,
      };
}

/** identity's refusal of the step-up, as an ordering admin action answers it; anything else stays closed. */
function stepUpFailure(refusal: StepUpRefusal): ShipToRetentionFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

export async function viewShipToRetention(
  deps: ShipToRetentionDependencies,
  context: CallContext,
): Promise<Result<ShipToRetentionView, ShipToRetentionFailure>> {
  return deps.unitOfWork.run<ShipToRetentionView, ShipToRetentionFailure>(
    context.market,
    async () => ok(view(await deps.retention.find(context.market))),
    { readOnly: true },
  );
}

/**
 * Sets the Market's ship-to retention. `expectedVersion` is the version the admin read, 0 while it
 * was never set. Refused for anyone but an admin session of their own (never acting-as).
 */
export async function setShipToRetention(
  deps: ShipToRetentionDependencies,
  context: CallContext,
  input: {
    readonly enabled: unknown;
    readonly months: unknown;
    readonly expectedVersion: unknown;
  },
): Promise<Result<ShipToRetentionView, ShipToRetentionFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAsSession(actor)) {
    return err({ code: 'access.denied' });
  }
  const parsed = parseShipToRetentionInput({
    enabled: input?.enabled,
    months: input?.months,
    expectedVersion: input?.expectedVersion,
  });
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.fields });
  const { enabled, months, expectedVersion } = parsed.value;

  return deps.unitOfWork.run<ShipToRetentionView, ShipToRetentionFailure>(
    context.market,
    async () => {
      const current = await deps.retention.find(context.market);
      if ((current?.version ?? 0) !== expectedVersion) return err({ code: 'conflict.retry' });
      const spent = await deps.stepUp.consume(context, ORDERING_SHIP_TO_RETENTION_STEP_UP);
      if (!spent.ok) return err(stepUpFailure(spent.error));
      const setting: ShipToRetention = {
        id: current?.id ?? deps.ids.next<'ShipToRetentionSetting'>(),
        enabled,
        months,
        version: expectedVersion + 1,
        updatedAt: deps.clock.now(),
        updatedBy: actor.accountId,
      };
      if ((await deps.retention.save(context.market, setting, expectedVersion)) === 'stale') {
        return err({ code: 'conflict.retry' });
      }
      await deps.audit.record(
        context,
        ShipToRetentionChanged.entry(setting.id, {
          before: { enabled: current?.enabled ?? null, months: current?.months ?? null },
          after: {
            enabled,
            months,
            version: setting.version,
            stepUpSessionId: spent.value.sessionId,
            stepUpVerifiedAt: spent.value.verifiedAt,
          },
        }),
      );
      return ok(view(setting));
    },
  );
}

/**
 * One run of the purge in the context's Market (the system actor's). Reads the setting; off or
 * never set, does nothing. On, clears batch after batch, each in its own unit, until a batch is
 * the last or the bound is reached, then writes one audit row with the count. Safe to run twice
 * and concurrently: an order already cleared is not looked at again, and clearing is the same
 * write whoever does it.
 */
export async function purgeDeliveredShipTo(
  deps: ShipToRetentionDependencies,
  context: CallContext,
): Promise<Result<ShipToPurgeRun, never>> {
  const read = await deps.unitOfWork.run<ShipToRetention | null, never>(
    context.market,
    async () => ok(await deps.retention.find(context.market)),
    { readOnly: true },
  );
  const setting = read.ok ? read.value : null;
  if (setting === null || !setting.enabled) return ok({ outcome: 'disabled', cleared: 0 });

  const cutoff = shipToRetentionCutoff(
    deps.clock.now(),
    deps.zones.zoneOf(context.market),
    setting.months,
  );
  let cleared = 0;
  let after: ShipToPurgeCursor | null = null;
  let complete = false;
  for (let batch = 0; batch < SHIP_TO_PURGE_MAX_BATCHES; batch += 1) {
    const cursor: ShipToPurgeCursor | null = after;
    // The setting is read again in each batch's unit: an admin who switches it off or changes the
    // months mid-run stops the deletion at the next batch.
    const done: Result<ShipToPurgeBatch | null, never> = await deps.unitOfWork.run<
      ShipToPurgeBatch | null,
      never
    >(context.market, async () => {
      const current = await deps.retention.find(context.market);
      if (current === null || !current.enabled || current.months !== setting.months) {
        return ok(null);
      }
      return ok(
        await deps.retention.clearDeliveredShipTo(
          context.market,
          cutoff,
          cursor,
          SHIP_TO_PURGE_BATCH,
        ),
      );
    });
    if (!done.ok || done.value === null) break;
    cleared += done.value.cleared;
    after = done.value.next;
    if (after === null) {
      complete = true;
      break;
    }
  }
  await deps.unitOfWork.run<void, never>(context.market, async () => {
    await deps.audit.record(
      context,
      ShipToPurged.entry(setting.id, {
        after: { months: setting.months, cutoff, cleared, complete },
      }),
    );
    return ok(undefined);
  });
  return ok({ outcome: complete ? 'complete' : 'partial', cleared });
}
