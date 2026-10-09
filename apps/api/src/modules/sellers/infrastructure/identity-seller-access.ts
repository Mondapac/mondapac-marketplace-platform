import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAccessContract } from '../../identity/contracts/seller-access.contract';
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
