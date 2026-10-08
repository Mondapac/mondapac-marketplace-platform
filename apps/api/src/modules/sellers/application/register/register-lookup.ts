import { Logger } from '@nestjs/common';
import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { addressFromJson } from '../../domain/address';
import type { IdentifierIndexKey, NormalisedIdentifier } from '../../domain/business-identifier';
import {
  draftChangedSince,
  isFresh,
  registerStateOf,
  sellerRegisterResultOf,
  type RegisterCheck,
  type RegisterChecker,
  type RegisterMismatch,
  type SellerRegisterResult,
} from '../../domain/register-check';
import { compareWithRegister, type DraftValues } from '../../domain/register-comparison';
import {
  budgetAlertCount,
  lookupAccountLimits,
  lookupMarketLimits,
  lookupOriginLimits,
  rateVerdict,
  type RateLimit,
} from '../../domain/rate-limits';
import type { Sealed, SealedField } from '../../domain/sealed';
import type { SellerFile } from '../../domain/seller-file';
import type { AccessUnavailable, RequestThrottled } from '../draft/draft-support';
import type {
  BusinessRegisterLookup,
  BusinessRegisterLookups,
  RegisterAnswer,
} from '../ports/business-register-lookup';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { RegisterCheckRepository } from '../ports/register-check.repository';
import type { RegisterLookupPolicy, RegisterLookupSettings } from '../ports/register-lookup-policy';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { AddressFormats } from '../ports/seller-market-formats';
import type { TaxProfileRepository } from '../ports/tax-profile.repository';

// The register lookup of a seller file (sellers design 7.7; slice 4a), shared by the use cases
// that ask the register: the seller's `my-file.save-identifier` now, a reviewer's re-lookup in
// slice 7a-read and the periodic job in slice 11. The call is made outside any unit of work, the
// quotas are reserved before it, and no identifier or register value reaches a log.

const logger = new Logger('SellersRegisterLookup');

/** The per-account limit of new identifier values is reached: the save is refused (brief s5). */
export type LookupLimitReached = {
  readonly code: 'lookup.limit';
  readonly retryAfterSeconds: number;
};

export type ConfiguredLookup = Extract<RegisterLookupSettings, { kind: 'configured' }>;

/** A Market whose register lookup is configured and reaches a register. */
export interface LookupPlan {
  readonly adapter: BusinessRegisterLookup;
  readonly settings: ConfiguredLookup;
}

export interface RegisterLookupDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly registerChecks: RegisterCheckRepository;
  readonly registerLookups: BusinessRegisterLookups;
  readonly registerPolicy: RegisterLookupPolicy;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly taxProfiles: TaxProfileRepository;
  readonly addressFormats: AddressFormats;
  readonly cipher: SellerFileCipher;
  readonly clock: Clock;
}

/**
 * The lookup the Market has, or null when it has none (`none`: no call, no quota, no result;
 * AC 34). Throws when configuration names an adapter nobody implements: the caller answers
 * `sellers.unavailable`, it never uses another adapter.
 */
export function lookupPlanOf(
  deps: Pick<RegisterLookupDependencies, 'registerLookups' | 'registerPolicy'>,
  market: MarketContext,
): LookupPlan | null {
  const settings = deps.registerPolicy.settingsOf(market);
  if (settings.kind === 'none') return null;
  const adapter = deps.registerLookups.of(market);
  return adapter.performsLookups ? { adapter, settings } : null;
}

/**
 * Whether the value must be asked of the register (design 7.7 "When"): it has no result yet, its
 * result is older than the maximum age, or an `active` result was checked before the draft last
 * changed (`fileChangedAt`; Hassan M1). A definite negative is never asked again by the seller
 * (it is sticky; only a reviewer's re-lookup or a new value moves it). Every call still reserves
 * the same three quotas.
 */
export function lookupDue(
  existing: RegisterCheck | null,
  now: Temporal.Instant,
  settings: ConfiguredLookup,
  fileChangedAt: Temporal.Instant,
): boolean {
  if (existing === null) return true;
  if (existing.definiteNegativeAt !== null) return false;
  if (existing.outcome === 'active' && draftChangedSince(existing, fileChangedAt)) return true;
  return !isFresh(existing, now, settings.maxResultAgeDays);
}

/** The result of the file's current value as the seller may see it, from one stored row. */
export function sellerResultOf(
  existing: RegisterCheck | null,
  now: Temporal.Instant,
  settings: ConfiguredLookup,
  fileChangedAt: Temporal.Instant,
): SellerRegisterResult | null {
  return sellerRegisterResultOf(
    registerStateOf(existing, now, settings.maxResultAgeDays, fileChangedAt),
  );
}

/**
 * Whether the stored result is one the submission (slice 5) and the approval may rely on: an
 * `active` result that is fresh and was made on the draft as it now stands, or a definite
 * negative. False for no result, `unavailable`, and a stale result (aged, or the draft changed
 * since the check); the caller then asks again (`lookupDue`) or leaves it to a manual check.
 */
export function registerCheckIsCurrent(
  file: SellerFile,
  existing: RegisterCheck | null,
  now: Temporal.Instant,
  settings: ConfiguredLookup,
): boolean {
  const state = registerStateOf(existing, now, settings.maxResultAgeDays, file.state.lastChangedAt);
  return state === 'active' || state === 'negative';
}

type Reserved = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly count: number;
};

/**
 * Reserves one attempt on one counter in a read-write unit of its own (data design 3.11), before
 * the work. A store that cannot answer fails closed (Hassan L10).
 */
async function reserveOne(
  deps: Pick<RegisterLookupDependencies, 'unitOfWork' | 'counters' | 'counterKeys' | 'clock'>,
  context: CallContext,
  limit: RateLimit,
  subject: string,
): Promise<Result<Reserved, AccessUnavailable>> {
  const { market } = context;
  try {
    const counters = [{ limit, keyHash: deps.counterKeys.keyOf(market, limit.kind, subject) }];
    const now = deps.clock.now();
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(await deps.counters.reserve(market, counters, now)),
    );
    if (!reserved.ok) return err({ code: 'access.unavailable' });
    const verdict = rateVerdict([limit], reserved.value, now);
    return ok({
      allowed: verdict.allowed,
      retryAfterSeconds: verdict.allowed ? 0 : verdict.retryAfterSeconds,
      count: reserved.value[0]!.count,
    });
  } catch {
    logger.error({
      msg: 'sellers.register-lookup.counters-unavailable',
      kind: limit.kind,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}

/** The verdict of the quotas before one call. */
export type QuotaVerdict = 'go' | 'budget-exhausted';

/**
 * Reserves the quotas of one call, each before the work and each in a unit of its own that holds
 * one counter, in this order, stopping at the first refusal so a refused attempt does not spend
 * the next counter: the account's new values (`lookup.limit`; nothing is created, brief s5), the
 * origin's calls (`request.throttled`), the Market's budget (`budget-exhausted`, which the caller
 * records as `unavailable`; the 80% alert is logged when this call reaches it). A counter store
 * that cannot answer, or an origin that cannot be read, is `access.unavailable`.
 */
export async function reserveLookupQuota(
  deps: RegisterLookupDependencies,
  context: CallContext,
  who: { readonly accountId: Id<'Account'>; readonly origin: string | null },
  settings: ConfiguredLookup,
): Promise<Result<QuotaVerdict, LookupLimitReached | RequestThrottled | AccessUnavailable>> {
  const { market } = context;
  if (who.origin === null) return err({ code: 'access.unavailable' });

  const account = await reserveOne(
    deps,
    context,
    lookupAccountLimits(settings.perAccountLimit)[0]!,
    who.accountId,
  );
  if (!account.ok) return account;
  if (!account.value.allowed) {
    logger.warn({
      msg: 'sellers.register-lookup.account-limit',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'lookup.limit', retryAfterSeconds: account.value.retryAfterSeconds });
  }

  const origin = await reserveOne(
    deps,
    context,
    lookupOriginLimits(settings.perOriginLimit)[0]!,
    who.origin,
  );
  if (!origin.ok) return origin;
  if (!origin.value.allowed) {
    logger.warn({
      msg: 'sellers.register-lookup.origin-limit',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'request.throttled', retryAfterSeconds: origin.value.retryAfterSeconds });
  }

  const budget = await reserveOne(
    deps,
    context,
    lookupMarketLimits(settings.marketDailyBudget)[0]!,
    market.marketId,
  );
  if (!budget.ok) return budget;
  if (budget.value.count === budgetAlertCount(settings.marketDailyBudget)) {
    logger.warn({
      msg: 'sellers.register-lookup.market-budget-80-percent',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
  }
  return ok(budget.value.allowed ? 'go' : 'budget-exhausted');
}

/** What the draft says that the register can be compared with; null parts are not compared. */
async function draftValuesOf(
  deps: RegisterLookupDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  file: SellerFile,
): Promise<DraftValues> {
  const { market } = context;
  const { draft } = file.state;
  const format = deps.addressFormats.formatOf(market);
  const open = async <F extends SealedField>(
    field: F,
    sealed: Sealed<F> | null,
  ): Promise<string | null> => {
    if (sealed === null) return null;
    try {
      const opened = await deps.cipher.open(market, sellerId, field, sealed);
      return opened.ok ? opened.value : null;
    } catch {
      return null;
    }
  };
  const businessName = await open('business-name', draft.businessName);
  // The registered address's postcode when the draft has one, otherwise the operating one (7.7).
  const addressJson =
    (await open('registered-address', draft.registeredAddress)) ??
    (await open('address', draft.address));
  let postcode: string | null = null;
  if (addressJson !== null && format !== null) {
    try {
      postcode = addressFromJson(addressJson, format).postcode;
    } catch {
      postcode = null;
    }
  }
  let registeredForIndirectTax: boolean | null = null;
  try {
    const now = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.taxProfiles.findBySellerId(market, sellerId)),
      { readOnly: true },
    );
    if (read.ok && read.value !== null) {
      registeredForIndirectTax = read.value.asOf(now)?.registeredForIndirectTax ?? null;
    }
  } catch {
    registeredForIndirectTax = null;
  }
  return { businessName, registeredForIndirectTax, postcode };
}

export interface LookupRun {
  readonly sellerId: Id<'Seller'>;
  readonly scheme: string;
  readonly identifier: NormalisedIdentifier;
  readonly index: IdentifierIndexKey;
  /**
   * The snapshot the comparison reads the draft from: the file as it stands after the caller's own
   * save committed, read in that unit. A result is current only for this snapshot (Hassan M1).
   */
  readonly file: SellerFile;
  /** The instant of that read; an `active` result is stamped with it, never with a later time. */
  readonly snapshotAt: Temporal.Instant;
  readonly by: RegisterChecker;
}

async function askRegister(
  plan: LookupPlan,
  context: CallContext,
  run: LookupRun,
): Promise<RegisterAnswer> {
  try {
    const answer = await plan.adapter.lookup({
      market: context.market,
      scheme: run.scheme,
      identifier: run.identifier,
    });
    return answer;
  } catch (error) {
    // The adapter's name and the error's class, never its message: it may quote the request.
    logger.error({
      msg: 'sellers.register-lookup.adapter-failed',
      adapter: plan.adapter.code,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return { outcome: 'unavailable' };
  }
}

/**
 * Asks the register (outside any unit), compares an `active` answer with the draft and records
 * the result in a unit of its own. Answers the stored row, or null when it could not be stored
 * (then the file stays "not performed" and a reviewer checks it; nothing is claimed). Logs the
 * adapter code, the outcome code, the Market and the correlation id; never the value.
 */
export async function runLookup(
  deps: RegisterLookupDependencies,
  context: CallContext,
  plan: LookupPlan,
  run: LookupRun,
): Promise<RegisterCheck | null> {
  const answer = await askRegister(plan, context, run);
  let mismatches: readonly RegisterMismatch[] = [];
  if (answer.outcome === 'active') {
    const draft = await draftValuesOf(deps, context, run.sellerId, run.file);
    mismatches = compareWithRegister(answer.values, draft, plan.settings.legalSuffixes);
  }
  return recordResult(deps, context, run, answer.outcome, mismatches);
}

/**
 * Records an outcome that needed no call (the Market budget is spent: `unavailable`), or the
 * answer of a call. An `active` answer is stamped with the instant of the draft snapshot it was
 * compared against (`run.snapshotAt`, the later of the snapshot's last change and its read), not
 * with the time the register answered, so any edit saved afterwards is later than the result and
 * makes it stale. In the same unit the file is read again: if its version is no longer the
 * snapshot's, an edit slipped in during the call and the result is stored already stale (stamped
 * one nanosecond before that edit), never as a clean `active` (Hassan M1, race).
 */
export async function recordResult(
  deps: RegisterLookupDependencies,
  context: CallContext,
  run: Pick<LookupRun, 'sellerId' | 'index' | 'by'> &
    Partial<Pick<LookupRun, 'file' | 'snapshotAt'>>,
  outcome: RegisterAnswer['outcome'],
  mismatches: readonly RegisterMismatch[],
): Promise<RegisterCheck | null> {
  const { market } = context;
  try {
    const now = deps.clock.now();
    const stored = await deps.unitOfWork.run(market, async () => {
      let checkedAt = now;
      if (outcome === 'active' && run.file !== undefined && run.snapshotAt !== undefined) {
        checkedAt = run.snapshotAt;
        const latest = await deps.files.findById(market, run.sellerId);
        if (latest === null || latest.state.version !== run.file.state.version) {
          const changed = latest?.state.lastChangedAt ?? run.snapshotAt;
          checkedAt = changed.subtract({ nanoseconds: 1 });
          if (Temporal.Instant.compare(checkedAt, run.snapshotAt) > 0) checkedAt = run.snapshotAt;
        }
      }
      return ok(
        await deps.registerChecks.record(market, run.sellerId, run.index, {
          outcome,
          mismatches,
          checkedAt,
          checkedBy: run.by,
        }),
      );
    });
    if (!stored.ok) return null;
    logger.log({
      msg: 'sellers.register-lookup',
      outcome,
      mismatchCount: mismatches.length,
      by: run.by.kind,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return stored.value;
  } catch (error) {
    logger.error({
      msg: 'sellers.register-lookup.not-stored',
      error: error instanceof Error ? error.name : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return null;
  }
}
