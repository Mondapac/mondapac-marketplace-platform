import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SEO_VIEW } from '../../contracts/permissions';
import {
  SEO_SETTINGS_CHANGES,
  viewSeoSettings,
  type SeoFailure,
  type SeoSettingsPage,
} from '../seo-flow';
import type { SeoDependencies } from '../storefront-dependencies';

export type { SeoSettingsPage };

/** `storefront.view-seo-settings`: an admin reads the Market's SEO settings, with who changed them last. */
export class ViewStorefrontSeoSettings extends UseCase<
  Record<string, never>,
  SeoSettingsPage,
  SeoFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-seo-settings',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SEO_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeoDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SeoSettingsPage, SeoFailure>> {
    const view = await viewSeoSettings(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, SEO_SETTINGS_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}
