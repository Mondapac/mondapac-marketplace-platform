import type { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { StepUpProofConsumer, StepUpRefusal } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  flagReasonOf,
  type CategoryOfferReviewFlag,
} from '../../domain/category-offer-review-flags';
import { isActingAsSession } from '../acting-as';
import type { CategoryOfferReviewFlagsStore } from '../ports/category-offer-review-flags.store';

/** The category from the path and the body as it came: `{ on, reason, expectedVersion }`. */
export interface ChangeCategoryOfferReviewFlagInput {
  readonly categoryId?: unknown;
  readonly body?: unknown;
}

export interface ChangeCategoryOfferReviewFlagResult {
  readonly on: boolean;
  /** False when the flag already held the value: nothing written, no audit row, no proof spent. */
  readonly changed: boolean;
  /** The flags row's version after the change (0 while the category has none). */
  readonly version: number;
}

export type ChangeCategoryOfferReviewFlagFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'second-factor.required' | 'second-factor.enrolment-required';
      readonly actionKey: string;
    }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ChangeCategoryOfferReviewFlagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryFlags: CategoryOfferReviewFlagsStore;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** How one flag's use case differs: the flag, its log name, step-up action and audit row. */
export interface CategoryOfferReviewFlagSpec {
  readonly flag: CategoryOfferReviewFlag;
  readonly name: string;
  readonly stepUpAction: string;
  readonly auditEntry: (
    categoryId: Id<'Category'>,
    change: {
      readonly before: boolean;
      readonly after: boolean;
      readonly verifiedAt: Temporal.Instant;
    },
  ) => AuditEntry;
}

const BODY_KEYS = ['on', 'reason', 'expectedVersion'] as const;

function stepUpFailure(refusal: StepUpRefusal): ChangeCategoryOfferReviewFlagFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/**
 * The one flow of the two Offer review flags of a platform category (risk-based Offer approval
 * slice 4; ADR-0051 decision 4): "always review" (R7) and the category stop (R0), both inherited
 * by sub-categories when the facts are read. Admin population only; an acting-as session is
 * refused before anything is read. The body is closed: `on` (boolean), `reason` (1 to 500
 * characters after trimming, always required) and `expectedVersion` (the flags' version the admin
 * saw; 0 while the category has no flags row). In one read-write unit: an unknown category (or
 * another Market's) is `category.not-found`; a version other than the one seen is
 * `conflict.stale`; a value already held is `changed: false` with nothing written. Otherwise the
 * admin's fresh two-step proof is spent (a refusal commits nothing), the flags row is created at
 * version 1 or updated on the version seen (no row matched: `conflict.stale`), the reason goes to
 * the insert-only change log and the audit row (booleans only) is written. The flags row has its
 * own version, so a flag change never conflicts with a category edit. No outbox event: the facts
 * are read at decision time. The reason is never logged.
 */
export async function changeCategoryOfferReviewFlag(
  deps: ChangeCategoryOfferReviewFlagDependencies,
  spec: CategoryOfferReviewFlagSpec,
  logger: Logger,
  context: CallContext,
  input: ChangeCategoryOfferReviewFlagInput,
): Promise<Result<ChangeCategoryOfferReviewFlagResult, ChangeCategoryOfferReviewFlagFailure>> {
  const result = await change(deps, spec, context, input ?? {});
  logger.log({
    msg: spec.name,
    code: result.ok ? (result.value.changed ? 'changed' : 'unchanged') : result.error.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}

async function change(
  deps: ChangeCategoryOfferReviewFlagDependencies,
  spec: CategoryOfferReviewFlagSpec,
  context: CallContext,
  input: ChangeCategoryOfferReviewFlagInput,
): Promise<Result<ChangeCategoryOfferReviewFlagResult, ChangeCategoryOfferReviewFlagFailure>> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAsSession(actor)) {
    return err({ code: 'access.denied' });
  }
  const parsed =
    typeof input.categoryId === 'string' ? parseId<'Category'>(input.categoryId) : null;
  if (parsed === null || !parsed.ok) return err({ code: 'category.not-found' });
  const categoryId = parsed.value;

  const body = input.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
  }
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(body).sort()) {
    if (!(BODY_KEYS as readonly string[]).includes(key)) {
      fields.push({ path: key.slice(0, 64), code: 'unknown-field' });
    }
  }
  const { on, reason: rawReason, expectedVersion } = body as Record<string, unknown>;
  if (typeof on !== 'boolean') {
    fields.push({ path: 'on', code: on === undefined ? 'required' : 'type' });
  }
  const reason = flagReasonOf(rawReason);
  if (!reason.ok) fields.push({ path: 'reason', code: reason.code });
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    fields.push({
      path: 'expectedVersion',
      code: expectedVersion === undefined ? 'required' : 'type',
    });
  }
  if (fields.length > 0 || typeof on !== 'boolean' || !reason.ok) {
    return err({ code: 'validation.failed', fields });
  }
  const seen = expectedVersion as number;

  const { unitOfWork, categoryFlags, audit, stepUp, clock, ids } = deps;
  return unitOfWork.run<ChangeCategoryOfferReviewFlagResult, ChangeCategoryOfferReviewFlagFailure>(
    market,
    async () => {
      if (!(await categoryFlags.categoryExists(market, categoryId))) {
        return err({ code: 'category.not-found' });
      }
      const flags = await categoryFlags.find(market, categoryId);
      if (flags.state.version !== seen) return err({ code: 'conflict.stale' });
      const now = clock.now();
      const switched = flags.set({ flag: spec.flag, on, by: actor.accountId, now });
      if (switched === null) return ok({ on, changed: false, version: seen });
      // The proof is spent only for a change that is saved; a refusal commits nothing.
      const spent = await stepUp.consume(context, spec.stepUpAction);
      if (!spent.ok) return err(stepUpFailure(spent.error));
      if (!(await categoryFlags.save(market, flags, seen))) return err({ code: 'conflict.stale' });
      await categoryFlags.appendChange(market, {
        id: ids.next<'CategoryOfferReviewChange'>(),
        categoryId,
        flag: spec.flag,
        previous: switched.previous,
        next: on,
        reason: reason.reason,
        by: actor.accountId,
        at: now,
      });
      await audit.record(
        context,
        spec.auditEntry(categoryId, {
          before: switched.previous,
          after: on,
          verifiedAt: spent.value.verifiedAt,
        }),
      );
      return ok({ on, changed: true, version: seen + 1 });
    },
  );
}
