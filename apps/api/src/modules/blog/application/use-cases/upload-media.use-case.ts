import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_MEDIA_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { uploadMedia } from '../media-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.upload-media`: An admin adds a picture to the media library of the Market (decoded and written again as metadata-free JPEG renditions; the upload is not kept). Audited. */
export class UploadBlogMedia extends UseCase<
  FlowInput<typeof uploadMedia>,
  FlowValue<typeof uploadMedia>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.upload-media',
    rule: { kind: 'permissions', allOf: [BLOG_MEDIA_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof uploadMedia>) {
    return uploadMedia(this.deps, context, input);
  }
}
