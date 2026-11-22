import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  PublishedStoresDependencies,
  PublishedStoresUnavailable,
} from '../published/read-published-stores';
import {
  readPublishedStoreSlugs,
  type PublishedStoreSlugsInput,
} from './published-store-slugs.use-case';

/**
 * `sellers.published-store-slugs-system`: `publishedStoreSlugs` for event handlers and jobs, rule
 * `system`, the pair of `PublishedStoreSlugs` behind the same facade method, which picks this one
 * for the system actor (search's offer index sync and rebuild; identity design 6.2 row 1: the
 * `anonymous` rule never admits the system actor). The same read and the same answer: published
 * stores only, ids and slugs only. In-process only, never over HTTP.
 */
export class PublishedStoreSlugsSystem extends UseCase<
  PublishedStoreSlugsInput,
  ReadonlyMap<Id<'Seller'>, string>,
  PublishedStoresUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-slugs-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedStoresDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: PublishedStoreSlugsInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, PublishedStoresUnavailable>> {
    return readPublishedStoreSlugs(this.deps, context, input);
  }
}
