import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { viewPublicSeo } from '../seo-flow';
import type { PublicSeo } from '../../domain/seo-settings';
import type { SeoDependencies } from '../storefront-dependencies';

/** `storefront.view-public-seo`: the buyer site reads the Market's SEO settings with no session: the public fields only. */
export class ViewPublicStorefrontSeo extends UseCase<Record<string, never>, PublicSeo, never> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-public-seo',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeoDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<PublicSeo, never>> {
    return viewPublicSeo(this.deps, context);
  }
}
