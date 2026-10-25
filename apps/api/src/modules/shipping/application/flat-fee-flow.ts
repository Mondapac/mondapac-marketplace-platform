import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import { FlatFeeSet } from '../domain/audit';
import { parseFlatFee } from '../domain/flat-fee';
import type { ShippingDependencies } from './shipping-dependencies';

export type FlatFeeFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'shipping.seller-not-found' }
  /** `currency` is the Market's, so a screen can parse the amount it is about to set. */
  | { readonly code: 'shipping.fee-not-set'; readonly currency: string }
  | { readonly code: 'shipping.unavailable' };

/** What the system read of several fees can refuse. */
export type FlatFeesFailure = Extract<
  FlatFeeFailure,
  { code: 'access.denied' | 'validation.failed' }
>;

export interface FlatFeeView {
  readonly sellerId: Id<'Seller'>;
  readonly fee: Money;
}

const MAX_IDS = 100;

const sellerIdOf = (value: unknown): Id<'Seller'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** The seller of an authenticated seller session; null for any other actor (fail closed). */
export const actingSellerId = (context: CallContext): Id<'Seller'> | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'seller'
    ? sellerIdOf(actor.sellerId)
    : null;
};

/** An admin sets the flat fee of an existing seller; every change is audited with the old value. */
export async function setFlatFee(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly amount: unknown },
): Promise<Result<FlatFeeView, FlatFeeFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const fields: { path: string; code: string }[] = [];
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) fields.push({ path: 'sellerId', code: 'format' });
  const fee = parseFlatFee(input?.amount, deps.policy.currency(context.market));
  if (!fee.ok) fields.push({ path: fee.error.path, code: 'range' });
  if (sellerId === null || !fee.ok) return err({ code: 'validation.failed', fields });

  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'shipping.unavailable' });
  if (!known) return err({ code: 'shipping.seller-not-found' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<FlatFeeView, FlatFeeFailure>(context.market, async () => {
    const before = await deps.fees.find(context.market, sellerId);
    await deps.fees.save(context.market, {
      sellerId,
      fee: fee.value,
      updatedAt: now,
      updatedBy: actor.accountId,
    });
    await deps.audit.record(
      context,
      FlatFeeSet.entry(sellerId, {
        before: { feeMinor: before === null ? null : Number(before.fee.amount) },
        after: { feeMinor: Number(fee.value.amount) },
      }),
    );
    return ok({ sellerId, fee: fee.value });
  });
}

/** One seller's fee for an admin; `shipping.fee-not-set` when none was set. */
export async function viewFlatFee(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<FlatFeeView, FlatFeeFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  return readOne(deps, context, sellerId);
}

/** The acting seller's own fee. */
export async function viewOwnFlatFee(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<Result<FlatFeeView, FlatFeeFailure>> {
  const sellerId = actingSellerId(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  return readOne(deps, context, sellerId);
}

function readOne(
  deps: ShippingDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<FlatFeeView, FlatFeeFailure>> {
  return deps.unitOfWork.run<FlatFeeView, FlatFeeFailure>(
    context.market,
    async () => {
      const record = await deps.fees.find(context.market, sellerId);
      return record === null
        ? err({
            code: 'shipping.fee-not-set',
            currency: deps.policy.currency(context.market),
          } as const)
        : ok({ sellerId, fee: record.fee });
    },
    { readOnly: true },
  );
}

/** Up to 100 seller ids, parsed, distinct, in first-occurrence order. */
export function sellerIdsOf(raw: unknown): Result<readonly Id<'Seller'>[], FlatFeesFailure> {
  if (!Array.isArray(raw) || raw.length > MAX_IDS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
  }
  const ids: Id<'Seller'>[] = [];
  for (const value of raw as unknown[]) {
    const id = sellerIdOf(value);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ok(ids);
}

/** The system read behind the facade: the fees of up to 100 distinct sellers. */
export async function readFlatFees(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerIds: unknown },
): Promise<Result<ReadonlyMap<Id<'Seller'>, Money>, FlatFeesFailure>> {
  const parsed = sellerIdsOf(input?.sellerIds);
  if (!parsed.ok) return parsed;
  const ids = parsed.value;
  return deps.unitOfWork.run<ReadonlyMap<Id<'Seller'>, Money>, FlatFeesFailure>(
    context.market,
    async () => {
      const rows = ids.length === 0 ? [] : await deps.fees.findMany(context.market, ids);
      return ok(new Map(rows.map((row) => [row.sellerId, row.fee])));
    },
    { readOnly: true },
  );
}
