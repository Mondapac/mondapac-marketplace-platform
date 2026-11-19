import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PAUSE } from '../../contracts/permissions';

/**
 * `blog.post-pause-probe`: asks the gate whether the caller holds the key of BLOG_POST_PAUSE. It reads
 * and writes nothing. The admin Blog posts list calls it to name the row actions the caller may
 * run (Pause); `access.denied` means "no". Each action checks its key, the lifecycle and the
 * two-step rules again when it runs.
 */
export class BlogPostPauseProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.post-pause-probe',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PAUSE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    void context;
    return Promise.resolve(ok({ held: true }));
  }
}
