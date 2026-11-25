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
  offerReviewReasonOf,
  switchOf,
  type OfferReviewFlag,
} from '../../domain/offer-review-flags';
import type { OfferReviewFlagsRepository } from '../ports/offer-review-flags.repository';

/** The seller from the path and the body as it came: `{ on, reason, expectedVersion }`. */
export interface ChangeOfferReviewFlagInput {
  readonly sellerId?: unknown;
  readonly body?: unknown;
}

export interface ChangeOfferReviewFlagResult {
  readonly on: boolean;
  /** False when the flag already held the value: nothing written, no audit row, no proof spent. */
  readonly changed: boolean;
  /** The admin settings row's version after the change (the one to send next time). */
  readonly version: number;
}

export type ChangeOfferReviewFlagFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'second-factor.required' | 'second-factor.enrolment-required';
      readonly actionKey: string;
    }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ChangeOfferReviewFlagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offerReviewFlags: OfferReviewFlagsRepository;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** How one flag's use case differs: the flag, its audit row and its step-up action (if any). */
export interface OfferReviewFlagSpec {
  readonly flag: OfferReviewFlag;
  /** The log line's `msg` (the use case name). */
  readonly name: string;
  readonly stepUpAction: string | null;
  readonly auditEntry: (
    sellerId: Id<'Seller'>,
    change: {
      readonly before: boolean;
      readonly after: boolean;
      readonly verifiedAt?: Temporal.Instant;
    },
  ) => AuditEntry;
}

const BODY_KEYS = ['on', 'reason', 'expectedVersion'] as const;

/** True for an acting-as (Login as Seller) session: the reserved marker (identity design 3.4). */
function isActingAs(actor: CallContext['actor']): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

function stepUpFailure(refusal: StepUpRefusal): ChangeOfferReviewFlagFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/**
 * The one flow of the three Offer review flag changes of a seller (SEL-25; slice 4, ADR-0051
 * decision 4). Admin population only; an acting-as session is refused before anything is read.
 * The body is closed: `on` (boolean), `reason` (1 to 500 characters after trimming, always
 * required) and `expectedVersion` (the admin settings row's version the admin saw). In one
 * read-write unit: the row is read (an unknown seller and another Market's seller are both
 * `file.not-found`), a version other than the one seen is `conflict.stale`, a value already held
 * is `changed: false` with nothing written. Otherwise the admin's fresh two-step proof is spent
 * (protected flags only; a refusal commits nothing), the flag is set with who and when by a
 * conditional UPDATE on the version (0 rows: `conflict.stale`), the reason goes to the insert-only
 * change log and the audit row (booleans only) is written. No outbox event: catalog reads the
 * flags at decision time. The reason is never logged.
 */
export async function changeOfferReviewFlag(
  deps: ChangeOfferReviewFlagDependencies,
  spec: OfferReviewFlagSpec,
  logger: Logger,
  context: CallContext,
  input: ChangeOfferReviewFlagInput,
): Promise<Result<ChangeOfferReviewFlagResult, ChangeOfferReviewFlagFailure>> {
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
  deps: ChangeOfferReviewFlagDependencies,
  spec: OfferReviewFlagSpec,
  context: CallContext,
  input: ChangeOfferReviewFlagInput,
): Promise<Result<ChangeOfferReviewFlagResult, ChangeOfferReviewFlagFailure>> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(actor)) {
    return err({ code: 'access.denied' });
  }
  const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
  const sellerId = seller.value;

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
  const reason = offerReviewReasonOf(rawReason);
  if (!reason.ok) fields.push({ path: 'reason', code: reason.code });
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
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

  const { unitOfWork, offerReviewFlags, audit, stepUp, clock, ids } = deps;
  return unitOfWork.run<ChangeOfferReviewFlagResult, ChangeOfferReviewFlagFailure>(
    market,
    async () => {
      const state = await offerReviewFlags.read(market, sellerId);
      if (state === null) return err({ code: 'file.not-found' });
      if (state.version !== seen) return err({ code: 'conflict.stale' });
      const before = switchOf(state, spec.flag).on;
      if (before === on) return ok({ on, changed: false, version: state.version });
      // The proof is spent only for a change that is saved; a refusal commits nothing.
      let verifiedAt: Temporal.Instant | undefined;
      if (spec.stepUpAction !== null) {
        const spent = await stepUp.consume(context, spec.stepUpAction);
        if (!spent.ok) return err(stepUpFailure(spent.error));
        verifiedAt = spent.value.verifiedAt;
      }
      const now = clock.now();
      const saved = await offerReviewFlags.set(market, sellerId, {
        flag: spec.flag,
        on,
        by: actor.accountId,
        at: now,
        expectedVersion: seen,
      });
      if (!saved) return err({ code: 'conflict.stale' });
      await offerReviewFlags.appendChange(market, {
        id: ids.next<'OfferReviewFlagChange'>(),
        sellerId,
        flag: spec.flag,
        previous: before,
        next: on,
        reason: reason.reason,
        by: actor.accountId,
        at: now,
      });
      await audit.record(
        context,
        spec.auditEntry(sellerId, {
          before,
          after: on,
          ...(verifiedAt === undefined ? {} : { verifiedAt }),
        }),
      );
      return ok({ on, changed: true, version: seen + 1 });
    },
  );
}
