import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { readMedia } from '../media-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.view-media-file`: The bytes of one rendition (`large` or `thumb`) of a picture of the media library. */
export class ViewBlogMediaFile extends UseCase<
  FlowInput<typeof readMedia>,
  FlowValue<typeof readMedia>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-media-file',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof readMedia>) {
    return readMedia(this.deps, context, input);
  }
}
