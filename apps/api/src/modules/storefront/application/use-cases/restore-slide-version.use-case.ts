import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { type SlideDetailView, type SlideFailure, restoreSlideVersion } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.restore-slide-version`: An editor copies an earlier version into a new draft. */
export class RestoreStorefrontSlideVersion extends UseCase<
  { readonly slide: unknown; readonly versionId: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.restore-slide-version',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly slide: unknown; readonly versionId: unknown },
  ) {
    return restoreSlideVersion(this.deps, context, input);
  }
}
