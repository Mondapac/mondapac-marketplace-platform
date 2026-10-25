import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_READ } from '../../contracts/permissions';
import { type SlideCopyPackage, type SlideFailure, prepareSlideCopy } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.prepare-slide-copy`: An admin reads a slide out as a package that an editor of another Market creates a draft from. */
export class PrepareStorefrontSlideCopy extends UseCase<
  { readonly slide: unknown },
  SlideCopyPackage,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.prepare-slide-copy',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return prepareSlideCopy(this.deps, context, input);
  }
}

export type { SlideCopyPackage } from '../slide-flow';
