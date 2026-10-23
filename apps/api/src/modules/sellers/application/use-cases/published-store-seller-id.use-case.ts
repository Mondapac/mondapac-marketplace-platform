import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { storedShopSlug } from '../../domain/shop-slug';
import {
  eligibleOnly,
  failClosed,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';

export interface PublishedStoreSellerIdInput {
  readonly slug: string;
}

/**
 * `sellers.published-store-seller-id` (the facade's `publishedStoreSellerId`): which seller holds
 * a store address, for the storefront's product list of one store. Rule `anonymous`, in-process
 * only. The same published-store rules as `sellers.published-store-read`: a `held` slug (never a
 * retired one) of a seller with an approved revision who may sell now. An unknown, malformed,
 * retired or not-selling slug all answer `null`, byte-identical; the caller reveals no more than
 * the store page does. A fault is `sellers.unavailable` and never a guess. Ids only: no field of
 * the store leaves.
 */
export class PublishedStoreSellerId extends UseCase<
  PublishedStoreSellerIdInput,
  Id<'Seller'> | null,
  PublishedStoresUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-seller-id',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedStoresDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedStoreSellerIdInput,
  ): Promise<Result<Id<'Seller'> | null, PublishedStoresUnavailable>> {
    const slug = storedShopSlug(input.slug);
    if (slug === null) return ok(null);
    const read = await failClosed(context, 'published-store-seller-id', async () => {
      const store = await readApproved(this.deps, context, (repository) =>
        repository.approvedStoreBySlug(context.market, slug),
      );
      if (store === null) return null;
      const [eligible] = await eligibleOnly(this.deps, context, [store]);
      return eligible?.sellerId ?? null;
    });
    return read.ok ? ok(read.value) : err(read.error);
  }
}
