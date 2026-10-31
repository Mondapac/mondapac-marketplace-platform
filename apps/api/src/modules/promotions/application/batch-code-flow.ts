import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { BatchCodesGenerated } from '../domain/audit';
import { normaliseCode, platformExposure } from '../domain/promotion';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings, isStillActive } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';
import { locked, spendPlatformFundingProof } from './shared';

// Batches of unique single-use codes for a BATCH_CODE promotion (promotions phase 2). An admin
// generates N codes in one call; the plain codes exist in that call's answer only (the CSV the
// route returns) and only their HMAC-SHA256 hashes (keyed by PROMOTIONS_CODE_PEPPER) are stored. A code is redeemed once (package T2
// marks it used); the quote treats a used code as not applicable.

/** The most attempts to draw `count` distinct new codes before the call gives up (never reached in practice). */
const MAX_ROUNDS = 10;

export interface GeneratedBatch {
  readonly promotionId: Id<'Promotion'>;
  readonly batchId: Id<'PromotionBatch'>;
  /** The plain codes, sorted; shown once. Never logged and never audited. */
  readonly codes: readonly string[];
}

export interface BatchCodeSummary {
  readonly promotionId: Id<'Promotion'>;
  readonly total: number;
  readonly used: number;
  /** The most codes the Market lets one promotion hold. */
  readonly maxPerPromotion: number;
}

const invalid = (path: string, code: string): PromotionsFailure => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

function promotionIdOf(raw: unknown): Id<'Promotion'> | null {
  const parsed = typeof raw === 'string' ? parseId<'Promotion'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * Generates `count` unique codes for a batch-code promotion. The promotion is locked for the unit,
 * so two calls cannot together pass the Market's limit. A promotion whose platform budget is above
 * the Market threshold needs a fresh two-step code for each call (the codes are the way that
 * budget is spent).
 */
export async function generateBatchCodes(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown; readonly count?: unknown },
): Promise<Result<GeneratedBatch, PromotionsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const limits = settings.batchCodes;
  // A Market that configures no batches cannot make any: fail closed.
  // So does one without the pepper that keys the stored hashes.
  if (limits === null || !deps.codeCrypto.available) return err({ code: 'promotions.unavailable' });

  const id = promotionIdOf(input?.promotionId);
  if (id === null) return err(invalid('promotionId', 'value'));
  const count = input?.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    return err(invalid('count', 'value'));
  }
  if (count > limits.maxPerBatch) return err(invalid('count', 'too-many'));
  const now = deps.clock.now();

  return deps.unitOfWork.run<GeneratedBatch, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const lock = await locked(() => deps.promotions.findForUpdate(context.market, id));
    if (!lock.ok) return lock;
    const promotion = lock.value;
    if (promotion === null) return err({ code: 'promotions.not-found' });
    if (promotion.type !== 'BATCH_CODE' || promotion.status === 'REJECTED') {
      return err({ code: 'promotions.invalid-state' });
    }
    const held = await deps.batchCodes.count(context.market, id);
    if (held.total + count > limits.maxPerPromotion) return err(invalid('count', 'too-many'));

    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    const exposure = platformExposure(
      promotion.funding,
      promotion.platformSplitBps,
      promotion.budgetMinor,
    );
    if (exposure > settings.rules.platformBudgetStepUpMinor) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }

    // Draw until there are `count` distinct codes that no stored code shares a hash with.
    const fresh = new Map<string, string>();
    for (let round = 0; round < MAX_ROUNDS && fresh.size < count; round++) {
      const drawn = new Map<string, string>();
      // A bounded number of draws, so a broken random source ends in a refusal, not a loop.
      for (let draw = 0; draw < count * 4 + 16 && fresh.size + drawn.size < count; draw++) {
        const code = normaliseCode(deps.codeCrypto.generate(limits.alphabet, limits.codeLength));
        const hash = deps.codeCrypto.hash(code);
        if (!fresh.has(hash)) drawn.set(hash, code);
      }
      const taken = await deps.batchCodes.existing(context.market, [...drawn.keys()]);
      // One code per order: never a code that a public (CART_CODE) promotion already has.
      const publicCodes = await deps.promotions.existingCodes(context.market, [...drawn.values()]);
      for (const [hash, code] of drawn) {
        if (taken.has(hash) || publicCodes.has(code)) continue;
        fresh.set(hash, code);
      }
    }
    if (fresh.size < count) return err({ code: 'promotions.unavailable' });

    const batchId = deps.ids.next<'PromotionBatch'>();
    await deps.batchCodes.insertMany(context.market, id, batchId, [...fresh.keys()], now);
    await deps.audit.record(
      context,
      BatchCodesGenerated.entry(id, {
        after: {
          batchId,
          count,
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok({ promotionId: id, batchId, codes: [...fresh.values()].sort() });
  });
}

/** How many codes a batch-code promotion holds and how many were used. */
export async function batchCodeSummary(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown },
): Promise<Result<BatchCodeSummary, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const id = promotionIdOf(input?.promotionId);
  if (id === null) return err(invalid('promotionId', 'value'));
  const maxPerPromotion = switched.value.batchCodes?.maxPerPromotion ?? 0;
  return deps.unitOfWork.run<BatchCodeSummary, PromotionsFailure>(
    context.market,
    async () => {
      const promotion = await deps.promotions.find(context.market, id);
      if (promotion === null || promotion.type !== 'BATCH_CODE') {
        return err({ code: 'promotions.not-found' });
      }
      const held = await deps.batchCodes.count(context.market, id);
      return ok({ promotionId: id, total: held.total, used: held.used, maxPerPromotion });
    },
    { readOnly: true },
  );
}
