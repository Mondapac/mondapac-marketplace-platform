import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SEO_MANAGE } from '../../contracts/permissions';
import {
  SEO_SETTINGS_CHANGES,
  setSeoPart,
  type SeoFailure,
  type SeoSettingsPage,
} from '../seo-flow';
import type { SeoDependencies } from '../storefront-dependencies';

interface Input {
  readonly settings: unknown;
  readonly expectedVersion: unknown;
}

/** `storefront.set-protected-seo-settings`: an admin replaces the indexing switch, logo, business details and tool codes (protected key, fresh second factor, not in an acting-as session). */
export class SetStorefrontProtectedSeoSettings extends UseCase<Input, SeoSettingsPage, SeoFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.set-protected-seo-settings',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SEO_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeoDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<SeoSettingsPage, SeoFailure>> {
    const result = await setSeoPart(this.deps, context, 'manage', input);
    // The latest change is the save just made or, on a conflict, the winning one.
    if (result.ok || result.error.code === 'storefront.conflict') {
      const lastChanged = await this.deps.trail.lastChanged(context, SEO_SETTINGS_CHANGES);
      return result.ok
        ? ok({ ...result.value, lastChanged })
        : err({ code: 'storefront.conflict', lastChanged });
    }
    return result;
  }
}
