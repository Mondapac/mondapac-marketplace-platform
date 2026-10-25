import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  eligibleOnly,
  failClosed,
  MAX_PUBLISHED_STORES,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';

export interface PublishedStoreSlugsInput {
  readonly sellerIds: readonly Id<'Seller'>[];
}

/** At most this many ids per call; a larger call is cut to the first ones (callers send few). */
export const MAX_SLUG_IDS = 100;

/**
 * `sellers.published-store-slugs` (the facade's `publishedStoreSlugs`): the store address of each
 * requested seller, for the storefront's links to a store. Rule `anonymous`, in-process only. The
 * same published-store rules as `sellers.published-store-read`: a `held` slug of a seller with an
 * approved revision who may sell now. A seller that is unknown, in another Market, not approved or
 * not selling (suspended) is absent from the answer, byte-identical. A fault is
 * `sellers.unavailable`: the caller fails closed. Ids and slugs only.
 */
export class PublishedStoreSlugs extends UseCase<
  PublishedStoreSlugsInput,
  ReadonlyMap<Id<'Seller'>, string>,
  PublishedStoresUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-slugs',
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
    input: PublishedStoreSlugsInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, PublishedStoresUnavailable>> {
    const wanted = new Set(input.sellerIds.slice(0, MAX_SLUG_IDS));
    if (wanted.size === 0) return ok(new Map());
    const read = await failClosed(context, 'published-store-slugs', async () => {
      const stores = await readApproved(this.deps, context, (repository) =>
        repository.approvedStores(context.market, MAX_PUBLISHED_STORES),
      );
      const eligible = await eligibleOnly(
        this.deps,
        context,
        stores.filter((store) => wanted.has(store.sellerId)),
      );
      return new Map(eligible.map((store) => [store.sellerId, store.slug] as const));
    });
    return read.ok ? ok(read.value) : err(read.error);
  }
}
