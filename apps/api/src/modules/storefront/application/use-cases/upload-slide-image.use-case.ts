import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import {
  uploadSlideImage,
  type SlideImageFailure,
  type SlideImageView,
} from '../slide-images/slide-image-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/**
 * `storefront.upload-slide-image` (file storage pilot F9): an editor uploads a slide picture for
 * desktop and, if wanted, a separate one for mobile. Both go through the shared image pipeline
 * (decoded, cropped to the slide shape, written again as metadata-free JPEG renditions; the upload
 * itself is never stored). The answer names the image; a slide's draft then uses it as
 * `image.ref`. Rule: the key `storefront.slide.edit`, admin population.
 */
export class UploadStorefrontSlideImage extends UseCase<
  unknown,
  SlideImageView,
  SlideImageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.upload-slide-image',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return uploadSlideImage(this.deps, context, input);
  }
}
