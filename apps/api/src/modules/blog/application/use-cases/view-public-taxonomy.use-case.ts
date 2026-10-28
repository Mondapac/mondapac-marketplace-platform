import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { viewPublicTaxonomy } from '../public-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.view-public-taxonomy`: The categories and tags of the Market. */
export class ViewPublicBlogTaxonomy extends UseCase<
  FlowInput<typeof viewPublicTaxonomy>,
  FlowValue<typeof viewPublicTaxonomy>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-public-taxonomy',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof viewPublicTaxonomy>) {
    return viewPublicTaxonomy(this.deps, context, input);
  }
}
