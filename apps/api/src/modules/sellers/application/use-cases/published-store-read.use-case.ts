import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { storedShopSlug } from '../../domain/shop-slug';
import type { PublishedStore } from '../../domain/published-store';
import {
  eligibleOnly,
  failClosed,
  publishedStoresOf,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';

export interface PublishedStoreReadInput {
  readonly slug: string;
}

export type PublishedStoreReadFailure =
  { readonly code: 'sellers.store-not-found' } | PublishedStoresUnavailable;

/**
 * `sellers.published-store-read` (slice 12; sellers design 7.1 `publishedStoreProfile`): the
 * buyer site's store page. Rule `anonymous`. Resolves only a `held` slug, never a retired one,
 * and answers `sellers.store-not-found` unless the seller may sell now (Hassan M5): an unknown
 * slug, a malformed one, a retired one and a seller that may not sell answer alike. Allow-listed
 * public fields only (AC 25); clear columns, no key unwrapped.
 */
export class PublishedStoreRead extends UseCase<
  PublishedStoreReadInput,
  PublishedStore,
  PublishedStoreReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-read',
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
    input: PublishedStoreReadInput,
  ): Promise<Result<PublishedStore, PublishedStoreReadFailure>> {
    const slug = storedShopSlug(input.slug);
    if (slug === null) return err({ code: 'sellers.store-not-found' });
    const read = await failClosed(context, 'published-store-read', async () => {
      const store = await readApproved(this.deps, context, (repository) =>
        repository.approvedStoreBySlug(context.market, slug),
      );
      if (store === null) return null;
      const [eligible] = await eligibleOnly(this.deps, context, [store]);
      if (eligible === undefined) return null;
      const [published] = await publishedStoresOf(this.deps, context, [eligible]);
      return published ?? null;
    });
    if (!read.ok) return read;
    return read.value === null ? err({ code: 'sellers.store-not-found' }) : ok(read.value);
  }
}
