import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readSlideImage,
  type SlideImageBytes,
  type SlideImageFailure,
} from '../slide-images/slide-image-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/**
 * `storefront.view-slide-image` (file storage pilot F9): the bytes of one rendition of a slide
 * image of the request's Market, with no session (the buyer site shows them). The id is unguessable
 * and the key is read from the stored rendition row, never built from the request. An unknown id,
 * a size that does not exist and an image of another Market all answer one not-found.
 */
export class ViewStorefrontSlideImage extends UseCase<
  { readonly imageId: unknown; readonly size: unknown },
  SlideImageBytes,
  SlideImageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-slide-image',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly imageId: unknown; readonly size: unknown },
  ) {
    return readSlideImage(this.deps, context, input);
  }
}
