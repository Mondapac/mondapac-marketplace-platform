import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { updateDraft } from '../edit-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.update-draft`: Saves the draft of a platform post; a returned, approved or live post gets a new draft. */
export class UpdateBlogPostDraft extends UseCase<
  FlowInput<typeof updateDraft>,
  FlowValue<typeof updateDraft>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.update-draft',
    rule: { kind: 'permissions', allOf: [BLOG_POST_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof updateDraft>) {
    return updateDraft(this.deps, context, input, 'admin');
  }
}
