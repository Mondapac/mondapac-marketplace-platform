import { err, ok, parseId, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  auditCode,
  CoFundingOptInChanged,
  PromotionBudgetChanged,
  PromotionCreated,
  PromotionEdited,
  PromotionPaused,
  PromotionResumed,
} from '../domain/audit';
import {
  approvalReason,
  checkDraft,
  countsTowardSellerCap,
  needsFreshSecondFactor,
  parseDraft,
  type ApprovalReason,
  type Owner,
  type PromotionRecord,
} from '../domain/promotion';
import { adminAccountId, sellerCaller } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings, isStillActive } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';
import { auditMoney, auditTerms, spendPlatformFundingProof } from './shared';

// Create, edit, pause, resume and budget change of promotions (promotions package T1). An admin
// works on the platform's promotions (and may pause any); a seller works on its own. Every write
// refuses an acting-as session, needs the Market switch on, and is audited. A fresh two-step proof
// is spent inside the unit that saves the change, so it serves that one change only.

export type Actor = 'admin' | 'seller';

const DAY_MS = 86_400_000;

interface Caller {
  readonly accountId: Id<'Account'>;
  readonly owner: Owner;
}

function callerOf(context: CallContext, as: Actor): Caller | null {
  if (as === 'admin') {
    const accountId = adminAccountId(context);
    return accountId === null ? null : { accountId, owner: { kind: 'platform' } };
  }
  const seller = sellerCaller(context);
  return seller === null
    ? null
    : { accountId: seller.accountId, owner: { kind: 'seller', sellerId: seller.sellerId } };
}

const ownerSellerOf = (owner: Owner): Id<'Seller'> | null =>
  owner.kind === 'seller' ? owner.sellerId : null;

/** Whether an edit changes what a seller agreed to when it opted in to a co-funded campaign. */
function sellerTermsChanged(before: PromotionRecord, after: PromotionRecord): boolean {
  if (before.funding !== 'CO_FUNDED') return false;
  const sameReward =
    before.reward.kind === after.reward.kind &&
    (before.reward.kind === 'PERCENT'
      ? before.reward.bps === (after.reward as { bps: number }).bps
      : before.reward.amount === (after.reward as { amount: bigint }).amount);
  const sameIds = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));
  return (
    !sameReward ||
    before.platformSplitBps !== after.platformSplitBps ||
    !sameIds(before.productIds, after.productIds) ||
    !sameIds(before.sellerIds, after.sellerIds)
  );
}

const invalid = (fields: readonly { path: string; code: string }[]): PromotionsFailure => ({
  code: 'validation.failed',
  fields,
});

/** Whole days since the seller became active, or null when that is not known. */
async function sellerActiveDays(
  deps: PromotionsDependencies,
  context: CallContext,
  owner: Owner,
  now: Temporal.Instant,
): Promise<number | null | 'platform'> {
  if (owner.kind !== 'seller') return 'platform';
  const since = await deps.sellerActivity.activeSince(context, owner.sellerId);
  if (since === null) return null;
  return Math.max(0, Math.floor((now.epochMilliseconds - since.epochMilliseconds) / DAY_MS));
}

/** An id from a request; a malformed one is a validation failure, never an unknown. */
function promotionIdOf(raw: unknown): Id<'Promotion'> | null {
  const parsed = typeof raw === 'string' ? parseId<'Promotion'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

export async function createPromotion(
  deps: PromotionsDependencies,
  context: CallContext,
  input: unknown,
  as: Actor,
): Promise<Result<PromotionRecord, PromotionsFailure>> {
  const caller = callerOf(context, as);
  if (caller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const parsed = parseDraft(input);
  if (!parsed.ok) return err(invalid(parsed.error));
  const draft = parsed.value;
  const issues = checkDraft(draft, caller.owner, settings.rules);
  if (issues.length > 0) return err(invalid(issues));

  const now = deps.clock.now();
  // Asked of sellers before any unit opens (no outside call inside a unit).
  const days = await sellerActiveDays(deps, context, caller.owner, now);
  const reason: ApprovalReason | null =
    days === 'platform'
      ? null
      : approvalReason({ sellerActiveDays: days, reward: draft.reward }, settings.rules);

  return deps.unitOfWork.run<PromotionRecord, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const sellerOwner = ownerSellerOf(caller.owner);
    // A new promotion counts from the day it is made (it is pending or live).
    if (
      sellerOwner !== null &&
      (await deps.promotions.countCounting(context.market, sellerOwner, now)) >=
        settings.maxActivePromotionsPerSeller
    ) {
      return err({ code: 'promotions.too-many-active' });
    }
    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    if (as === 'admin' && needsFreshSecondFactor(null, draft, settings.rules)) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }
    const record: PromotionRecord = {
      ...draft,
      id: deps.ids.next<'Promotion'>(),
      status: reason === null ? 'ACTIVE' : 'PENDING_APPROVAL',
      ownerSellerId: ownerSellerOf(caller.owner),
      currency: settings.currency,
      // An admin made the platform's promotion; a seller's waits for (or gets) a review.
      priorApproved: as === 'admin',
      pausedBy: null,
      createdByAccountId: caller.accountId,
      createdAt: now,
      updatedAt: now,
    };
    if ((await deps.promotions.insert(context.market, record)) === 'duplicate-code') {
      return err({ code: 'promotions.code-taken' });
    }
    const sellerId = ownerSellerOf(caller.owner);
    if (sellerId !== null) {
      // Every seller promotion enters the admin review queue: before it goes live when it needs
      // approval, afterwards when it went live at once.
      await deps.reviews.open(context.market, {
        id: deps.ids.next<'PromotionReview'>(),
        promotionId: record.id,
        sellerId,
        reason: reason ?? 'POST_REVIEW',
        status: 'OPEN',
        openedAt: now,
        decidedAt: null,
      });
    }
    await deps.audit.record(
      context,
      PromotionCreated.entry(record.id, {
        after: {
          ...auditTerms(record),
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok(record);
  });
}

export async function editPromotion(
  deps: PromotionsDependencies,
  context: CallContext,
  input: unknown,
  as: Actor,
): Promise<Result<PromotionRecord, PromotionsFailure>> {
  const caller = callerOf(context, as);
  if (caller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const id = promotionIdOf(body.promotionId);
  if (id === null) return err(invalid([{ path: 'promotionId', code: 'value' }]));
  const draftInput: Record<string, unknown> = { ...body };
  delete draftInput.promotionId;
  const parsed = parseDraft(draftInput);
  if (!parsed.ok) return err(invalid(parsed.error));
  const draft = parsed.value;
  const issues = checkDraft(draft, caller.owner, settings.rules);
  if (issues.length > 0) return err(invalid(issues));

  const now = deps.clock.now();
  const days = await sellerActiveDays(deps, context, caller.owner, now);
  const reason: ApprovalReason | null =
    days === 'platform'
      ? null
      : approvalReason({ sellerActiveDays: days, reward: draft.reward }, settings.rules);

  return deps.unitOfWork.run<PromotionRecord, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const before = await deps.promotions.findForUpdate(context.market, id);
    // Unknown and someone else's seller promotion are one answer.
    if (before === null) return err({ code: 'promotions.not-found' });
    if (caller.owner.kind === 'seller' && before.ownerSellerId !== caller.owner.sellerId) {
      return err({ code: 'promotions.not-found' });
    }
    // An admin edits the platform's promotions; a seller's are the seller's (an admin pauses or
    // rejects them, never rewrites them).
    if (caller.owner.kind === 'platform' && before.ownerSellerId !== null) {
      return err({ code: 'promotions.not-editable' });
    }
    if (before.status === 'REJECTED') return err({ code: 'promotions.not-editable' });
    // What a promotion is, who pays and its code never change.
    const frozen: { path: string; code: string }[] = [];
    if (draft.type !== before.type) frozen.push({ path: 'type', code: 'immutable' });
    if (draft.funding !== before.funding) frozen.push({ path: 'funding', code: 'immutable' });
    if (draft.code !== before.code) frozen.push({ path: 'code', code: 'immutable' });
    if (frozen.length > 0) return err(invalid(frozen));

    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    if (as === 'admin' && needsFreshSecondFactor(before, draft, settings.rules)) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }
    const status =
      as === 'seller'
        ? reason !== null
          ? 'PENDING_APPROVAL'
          : before.status === 'PENDING_APPROVAL'
            ? 'ACTIVE'
            : before.status
        : before.status;
    const after: PromotionRecord = {
      ...before,
      ...draft,
      status,
      pausedBy: status === 'PAUSED' ? before.pausedBy : null,
      // A seller's change is a new thing to review; an admin's is already an admin's.
      priorApproved: as === 'admin' ? before.priorApproved : false,
      updatedAt: now,
    };
    // A promotion that goes (back) to counting against the seller's maximum must fit under it.
    if (
      before.ownerSellerId !== null &&
      !countsTowardSellerCap(before, now) &&
      countsTowardSellerCap(after, now) &&
      (await deps.promotions.countCounting(context.market, before.ownerSellerId, now)) >=
        settings.maxActivePromotionsPerSeller
    ) {
      return err({ code: 'promotions.too-many-active' });
    }
    await deps.promotions.update(context.market, after);
    if (sellerTermsChanged(before, after)) {
      // The sellers agreed to other terms: each must opt in again, and the withdrawal is audited.
      const withdrawn = await deps.optIns.withdrawAll(context.market, id, now, caller.accountId);
      for (const sellerId of withdrawn) {
        await deps.audit.record(
          context,
          CoFundingOptInChanged.entry(id, {
            before: { optedIn: true },
            after: { optedIn: false, sellerId },
          }),
        );
      }
    }
    if (as === 'seller') {
      await deps.reviews.open(context.market, {
        id: deps.ids.next<'PromotionReview'>(),
        promotionId: id,
        sellerId: before.ownerSellerId!,
        reason: reason ?? 'POST_REVIEW',
        status: 'OPEN',
        openedAt: now,
        decidedAt: null,
      });
    }
    await deps.audit.record(
      context,
      PromotionEdited.entry(id, {
        before: auditTerms(before),
        after: {
          ...auditTerms(after),
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok(after);
  });
}

/** Pause or resume: ACTIVE to PAUSED and back. Asking for the state a promotion is in changes nothing. */
export async function changePause(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown },
  as: Actor,
  pause: boolean,
): Promise<Result<PromotionRecord, PromotionsFailure>> {
  const caller = callerOf(context, as);
  if (caller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const id = promotionIdOf(input?.promotionId);
  if (id === null) return err(invalid([{ path: 'promotionId', code: 'value' }]));
  const now = deps.clock.now();

  return deps.unitOfWork.run<PromotionRecord, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const before = await deps.promotions.findForUpdate(context.market, id);
    if (before === null) return err({ code: 'promotions.not-found' });
    // An admin may pause any promotion; a seller only its own, and resume only what it paused.
    if (caller.owner.kind === 'seller' && before.ownerSellerId !== caller.owner.sellerId) {
      return err({ code: 'promotions.not-found' });
    }
    if (pause) {
      if (before.status === 'PAUSED') return ok(before);
      if (before.status !== 'ACTIVE') return err({ code: 'promotions.invalid-state' });
    } else {
      if (before.status === 'ACTIVE') return ok(before);
      if (before.status !== 'PAUSED') return err({ code: 'promotions.invalid-state' });
      // What an admin paused, a seller cannot lift.
      if (as === 'seller' && before.pausedBy !== 'SELLER') {
        return err({ code: 'promotions.invalid-state' });
      }
    }
    if (
      !pause &&
      before.ownerSellerId !== null &&
      countsTowardSellerCap({ ...before, status: 'ACTIVE' }, now) &&
      (await deps.promotions.countCounting(context.market, before.ownerSellerId, now)) >=
        settings.maxActivePromotionsPerSeller
    ) {
      return err({ code: 'promotions.too-many-active' });
    }
    const after: PromotionRecord = {
      ...before,
      status: pause ? 'PAUSED' : 'ACTIVE',
      pausedBy: pause ? (as === 'admin' ? 'ADMIN' : 'SELLER') : null,
      updatedAt: now,
    };
    await deps.promotions.update(context.market, after);
    await deps.audit.record(
      context,
      pause
        ? PromotionPaused.entry(id, {
            before: { status: auditCode(before.status) },
            after: { status: 'paused', pausedBy: auditCode(after.pausedBy!) },
          })
        : PromotionResumed.entry(id, {
            before: { status: auditCode(before.status) },
            after: { status: 'active' },
          }),
    );
    return ok(after);
  });
}

/** An admin sets the total budget of a platform promotion; above the threshold it needs a fresh code. */
export async function setBudget(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown; readonly budgetMinor?: unknown },
): Promise<Result<PromotionRecord, PromotionsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const id = promotionIdOf(input?.promotionId);
  const fields: { path: string; code: string }[] = [];
  if (id === null) fields.push({ path: 'promotionId', code: 'value' });
  const budget = parseMinorUnits(input?.budgetMinor);
  if (!budget.ok || budget.value < 1n) fields.push({ path: 'budgetMinor', code: 'value' });
  if (fields.length > 0 || id === null || !budget.ok) return err(invalid(fields));
  const now = deps.clock.now();

  return deps.unitOfWork.run<PromotionRecord, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const before = await deps.promotions.findForUpdate(context.market, id);
    if (before === null) return err({ code: 'promotions.not-found' });
    // A seller-funded promotion's budget is the seller's own to set.
    if (before.ownerSellerId !== null || before.status === 'REJECTED') {
      return err({ code: 'promotions.not-editable' });
    }
    if (before.budgetMinor === budget.value) return ok(before);
    const usage = (await deps.promotions.usageOf(context.market, [id])).get(id);
    if (usage !== undefined && budget.value < usage.spentMinor) {
      return err(invalid([{ path: 'budgetMinor', code: 'below-spent' }]));
    }
    const after: PromotionRecord = { ...before, budgetMinor: budget.value, updatedAt: now };
    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    if (needsFreshSecondFactor(before, after, settings.rules)) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }
    await deps.promotions.update(context.market, after);
    await deps.audit.record(
      context,
      PromotionBudgetChanged.entry(id, {
        before: { budget: auditMoney(before.budgetMinor, before.currency) },
        after: {
          budget: auditMoney(after.budgetMinor, after.currency),
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok(after);
  });
}
