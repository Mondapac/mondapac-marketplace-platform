import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { servedPlacementIds } from '../public-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/**
 * `storefront.view-served-placements`: the ids of the placements buyers are served now on one
 * page (rule `anonymous`: the answer is what the public page route already shows, ids only).
 */
export class ViewServedPlacements extends UseCase<
  { readonly pageId: Id<'StorefrontPage'> },
  ReadonlySet<string>,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-served-placements',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly pageId: Id<'StorefrontPage'> }) {
    return servedPlacementIds(this.deps, context, input);
  }
}
