import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { PayoutTermsCleared, PayoutTermsSet } from '../domain/audit';
import {
  localTimeToMinute,
  parsePayoutTermsOverride,
  weekdaysToMask,
  type PayoutTermsOverride,
} from '../domain/payout-terms';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import type { PayoutTermsOverrideRecord } from './ports/payout-terms.repository';
import type { EffectivePayoutTerms } from './payout-terms-resolver';
import { sellerIdOf } from './rate-flow';

// Payout terms per seller (package 6b; G2 4.4): an admin reads, sets and removes one seller's own
// terms. The set and the removal are protected keys (recent second factor, refused in acting-as,
// checked by the gate), carry the version they expect (optimistic concurrency) and are audited with
// before and after.

export type TermsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** Unknown, or another Market's, seller: byte-identical. */
  | { readonly code: 'commission-payouts.seller-not-found' }
  /** Removing an override the seller does not have. */
  | { readonly code: 'commission-payouts.terms-not-set' }
  /** No Market terms, or a stored value outside its bounds: nothing is anchored or paid. */
  | { readonly code: 'commission-payouts.terms-unavailable' }
  /** The version the admin saw is not the stored one (or the seller has no override yet). */
  | { readonly code: 'commission-payouts.version-conflict' }
  | { readonly code: 'commission-payouts.unavailable' };

export interface PayoutTermsView {
  readonly sellerId: Id<'Seller'>;
  /** The terms in force. */
  readonly effective: EffectivePayoutTerms['terms'];
  readonly source: 'seller' | 'market';
  /** The seller's own values (null fields = the Market's), or null when it has no override. */
  readonly override: PayoutTermsOverride | null;
  /** The override's version, null while the seller has none. */
  readonly version: number | null;
}

const adminOf = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin'
    ? context.actor
    : null;

const toView = (sellerId: Id<'Seller'>, effective: EffectivePayoutTerms): PayoutTermsView => ({
  sellerId,
  effective: effective.terms,
  source: effective.source,
  override: effective.override?.override ?? null,
  version: effective.override?.version ?? null,
});

const auditValues = (record: PayoutTermsOverrideRecord | null) => ({
  weekdaysMask: record?.override.weekdays == null ? null : weekdaysToMask(record.override.weekdays),
  localMinute:
    record?.override.localTime == null ? null : localTimeToMinute(record.override.localTime),
  holdDaysCarrier: record?.override.holdDaysCarrier ?? null,
  holdDaysSellerClick: record?.override.holdDaysSellerClick ?? null,
  minimumMinor: record?.override.minimumMinor == null ? null : Number(record.override.minimumMinor),
  approvalMode:
    record?.override.approvalMode == null
      ? null
      : (record.override.approvalMode.toLowerCase() as 'auto' | 'manual'),
  version: record?.version ?? null,
});

const invalidSeller = (): TermsFailure => ({
  code: 'validation.failed',
  fields: [{ path: 'sellerId', code: 'format' }],
});

/** The seller must exist in the context's Market (sellers' summaries, fail closed). */
async function sellerCheck(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<TermsFailure | null> {
  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return { code: 'commission-payouts.unavailable' };
  return known ? null : { code: 'commission-payouts.seller-not-found' };
}

/** An admin reads a seller's effective payout terms. */
export async function viewPayoutTerms(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<PayoutTermsView, TermsFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return err(invalidSeller());
  const refused = await sellerCheck(deps, context, sellerId);
  if (refused !== null) return err(refused);
  return deps.unitOfWork.run<PayoutTermsView, TermsFailure>(
    context.market,
    async () => {
      const effective = await deps.terms.resolve(context.market, sellerId);
      return effective.ok ? ok(toView(sellerId, effective.value)) : effective;
    },
    { readOnly: true },
  );
}

/**
 * An admin sets a seller's override, replacing any earlier one. `expectedVersion` is the version
 * the admin saw (null when the seller had no override).
 */
export async function setPayoutTerms(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly terms: unknown; readonly expectedVersion: unknown },
): Promise<Result<PayoutTermsView, TermsFailure>> {
  const actor = adminOf(context);
  if (actor === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  const parsed = parsePayoutTermsOverride(input?.terms);
  const expected = input?.expectedVersion;
  const expectedOk =
    expected === null ||
    expected === undefined ||
    (typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1);
  const fields: { path: string; code: string }[] = [];
  if (sellerId === null) fields.push({ path: 'sellerId', code: 'format' });
  if (!parsed.ok) fields.push(...parsed.error);
  if (!expectedOk) fields.push({ path: 'expectedVersion', code: 'range' });
  if (sellerId === null || !parsed.ok || !expectedOk) {
    return err({ code: 'validation.failed', fields });
  }
  const refused = await sellerCheck(deps, context, sellerId);
  if (refused !== null) return err(refused);

  const expectedVersion = expected ?? null;
  const now = deps.clock.now();
  return deps.unitOfWork.run<PayoutTermsView, TermsFailure>(context.market, async () => {
    const before = await deps.termsOverrides.find(context.market, sellerId);
    if ((before?.version ?? null) !== expectedVersion) {
      return err({ code: 'commission-payouts.version-conflict' } as const);
    }
    const record: PayoutTermsOverrideRecord = {
      sellerId,
      override: parsed.value,
      version: (before?.version ?? 0) + 1,
      updatedAt: now,
      updatedBy: actor.accountId,
    };
    const written =
      before === null
        ? await deps.termsOverrides.insert(context.market, record)
        : await deps.termsOverrides.replace(context.market, record, before.version);
    if (!written) return err({ code: 'commission-payouts.version-conflict' } as const);
    // The terms that will be in force must be usable (the Market has terms, nothing out of
    // bounds); otherwise the write is rolled back.
    const effective = await deps.terms.resolve(context.market, sellerId);
    if (!effective.ok) return effective;
    await deps.audit.record(
      context,
      PayoutTermsSet.entry(sellerId, { before: auditValues(before), after: auditValues(record) }),
    );
    return ok(toView(sellerId, effective.value));
  });
}

/** An admin removes a seller's override: the seller is back on the Market's terms. */
export async function clearPayoutTerms(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly expectedVersion: unknown },
): Promise<Result<PayoutTermsView, TermsFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  const expected = input?.expectedVersion;
  const expectedOk =
    typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1;
  const fields: { path: string; code: string }[] = [];
  if (sellerId === null) fields.push({ path: 'sellerId', code: 'format' });
  if (!expectedOk) fields.push({ path: 'expectedVersion', code: 'range' });
  if (sellerId === null || !expectedOk) return err({ code: 'validation.failed', fields });
  const refused = await sellerCheck(deps, context, sellerId);
  if (refused !== null) return err(refused);

  return deps.unitOfWork.run<PayoutTermsView, TermsFailure>(context.market, async () => {
    const before = await deps.termsOverrides.find(context.market, sellerId);
    if (before === null) return err({ code: 'commission-payouts.terms-not-set' } as const);
    if (before.version !== expected) {
      return err({ code: 'commission-payouts.version-conflict' } as const);
    }
    if (!(await deps.termsOverrides.remove(context.market, sellerId, before.version))) {
      return err({ code: 'commission-payouts.version-conflict' } as const);
    }
    const effective = await deps.terms.resolve(context.market, sellerId);
    if (!effective.ok) return effective;
    await deps.audit.record(
      context,
      PayoutTermsCleared.entry(sellerId, {
        before: auditValues(before),
        after: { version: null },
      }),
    );
    return ok(toView(sellerId, effective.value));
  });
}
