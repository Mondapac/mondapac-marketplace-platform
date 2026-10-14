import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAccessContract } from '../../identity/contracts/seller-access.contract';
import {
  SellerAccountAccessRefused,
  type SellerAccountDirectory,
  type SellerAccountEntry,
  type SellerStateCounts,
} from '../application/ports/seller-account-directory';
import type { SellerAccessReader } from '../application/ports/seller-access-reader';
import type { AccessState } from '../domain/seller-status';

/**
 * {@link SellerAccessReader} on `identity`'s seller-access contract (ADR-0022 decision 2): one
 * id per call, the state code only (the instant of the change is dropped here). An id absent
 * from the answer is unknown. A refusal throws, so the caller fails closed.
 */
export class IdentitySellerAccess implements SellerAccessReader {
  constructor(private readonly identity: SellerAccessContract) {}

  async accessOf(context: CallContext, sellerId: Id<'Seller'>): Promise<AccessState | null> {
    const result = await this.identity.sellerAccessOf(context, [sellerId]);
    if (!result.ok) throw new Error(`identity.sellerAccessOf refused: ${result.error.code}`);
    const found = result.value.find((summary) => summary.sellerId === sellerId);
    return found === undefined ? null : found.state;
  }

  async accessOfMany(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, AccessState>> {
    if (sellerIds.length === 0) return new Map();
    const result = await this.identity.sellerAccessOf(context, sellerIds);
    if (!result.ok) throw new Error(`identity.sellerAccessOf refused: ${result.error.code}`);
    return new Map(result.value.map((summary) => [summary.sellerId, summary.state]));
  }
}

/**
 * {@link SellerAccountDirectory} on `identity`'s seller-access contract (`sellerAccountSummaries`
 * and `sellerIdsByState`; slice 6b). The owner's account id is dropped here: the list shows the
 * name and the address only. A refusal throws, so the caller fails closed.
 */
export class IdentitySellerAccountDirectory implements SellerAccountDirectory {
  constructor(private readonly identity: SellerAccessContract) {}

  async accountsOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerAccountEntry>> {
    if (sellerIds.length === 0) return new Map();
    const result = await this.identity.sellerAccountSummaries(context, sellerIds);
    if (!result.ok) throw refusal('sellerAccountSummaries', result.error.code);
    return new Map(
      result.value.map((summary): [Id<'Seller'>, SellerAccountEntry] => [
        summary.sellerId,
        {
          state: summary.state,
          owner:
            summary.owner === null
              ? null
              : { displayName: summary.owner.displayName, email: summary.owner.email },
        },
      ]),
    );
  }

  async idsByState(
    context: CallContext,
    query: {
      readonly state: AccessState | null;
      readonly before: Id<'Seller'> | null;
      readonly limit: number;
    },
  ): Promise<{
    readonly sellerIds: readonly Id<'Seller'>[];
    readonly next: Id<'Seller'> | null;
    readonly counts: SellerStateCounts;
  }> {
    const result = await this.identity.sellerIdsByState(context, query);
    if (!result.ok) throw refusal('sellerIdsByState', result.error.code);
    return result.value;
  }
}

/** A refusal of the actor is told apart from a failure, so the list answers 403, not 503. */
function refusal(call: string, code: string): Error {
  const message = `identity.${call} refused: ${code}`;
  return code === 'access.denied' ? new SellerAccountAccessRefused(message) : new Error(message);
}
