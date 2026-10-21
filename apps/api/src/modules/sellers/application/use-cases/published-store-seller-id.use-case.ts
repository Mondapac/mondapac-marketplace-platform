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
 * `sellers.published-store-seller-id`: the seller that holds `slug` as a store address, for a
 * module that serves a per-store public read (the flat shipping fee). Rule `anonymous`, in-process
 * only (the facade; no route). The same rules as the public store page: a held slug of a store
 * with an approved revision whose seller may sell now. An unknown, malformed, retired or
 * not-selling slug is `null`, alike. Ids only, never a store field. A fault is
 * `sellers.unavailable`: the caller fails closed.
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
