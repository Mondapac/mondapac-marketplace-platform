import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PublishedStoreCard } from '../../domain/published-store';
import {
  eligibleOnly,
  failClosed,
  MAX_PUBLISHED_STORES,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';
import { MAX_SLUG_IDS } from './published-store-slugs.use-case';

export interface PublishedStoreCardsInput {
  readonly sellerIds: readonly Id<'Seller'>[];
}

/**
 * `sellers.published-store-cards` (the facade's `publishedStoreCards`): the store address, public
 * name and current logo of each requested seller, for a buyer's "My stores". Rule `anonymous`,
 * in-process only. The same published-store rules as `sellers.published-store-slugs`: a `held`
 * slug of a seller with an approved revision who may sell now. A seller that is unknown, in another
 * Market, not approved or not selling is absent from the answer, byte-identical, so the caller can
 * tell "not public" and nothing more. A fault is `sellers.unavailable`: the caller fails closed.
 * Public fields only (AC 25): the logo is a ref (`id`, `width`, `height`), never a URL or a key.
 */
export class PublishedStoreCards extends UseCase<
  PublishedStoreCardsInput,
  ReadonlyMap<Id<'Seller'>, PublishedStoreCard>,
  PublishedStoresUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-cards',
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
    input: PublishedStoreCardsInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, PublishedStoreCard>, PublishedStoresUnavailable>> {
    const wanted = new Set(input.sellerIds.slice(0, MAX_SLUG_IDS));
    if (wanted.size === 0) return ok(new Map());
    const read = await failClosed(context, 'published-store-cards', async () => {
      const stores = await readApproved(this.deps, context, (repository) =>
        repository.approvedStores(context.market, MAX_PUBLISHED_STORES),
      );
      const eligible = await eligibleOnly(
        this.deps,
        context,
        stores.filter((store) => wanted.has(store.sellerId)),
      );
      // Clear data: one read for the logos of the stores that may sell, nothing decrypted.
      const logos = await this.deps.publishedContent.logosOf(
        context,
        eligible.map((store) => store.sellerId),
      );
      return new Map(
        eligible.map(
          (store) =>
            [
              store.sellerId,
              { slug: store.slug, name: store.name, logo: logos.get(store.sellerId) ?? null },
            ] as const,
        ),
      );
    });
    return read.ok ? ok(read.value) : err(read.error);
  }
}
