import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SEO_VIEW } from '../../contracts/permissions';
import { SEO_SETTINGS_CHANGES } from '../seo-flow';
import type { SeoDependencies } from '../storefront-dependencies';

/**
 * `storefront.view-seo-settings-history`: the versions of the Market's SEO settings, newest first,
 * from the `storefront.seo-settings.changed` audit rows: the version, when, who (a display name)
 * and the names of the fields that changed (never a value). Same gate as the page.
 */
export class ViewStorefrontSeoSettingsHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-seo-settings-history',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SEO_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeoDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.trail.history(context, SEO_SETTINGS_CHANGES, input ?? {});
  }
}
