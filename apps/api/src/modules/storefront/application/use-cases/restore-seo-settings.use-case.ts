import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SEO_EDIT } from '../../contracts/permissions';
import {
  SEO_SETTINGS_CHANGES,
  restoreSeoVersion,
  type SeoFailure,
  type SeoSettingsPage,
} from '../seo-flow';
import type { SeoDependencies } from '../storefront-dependencies';

interface Input {
  readonly version: unknown;
  readonly expectedVersion: unknown;
}

/** `storefront.restore-seo-settings`: an admin brings an older version back as a new one (edit key; also the manage key and a fresh second factor when the version changes a manage field). */
export class RestoreStorefrontSeoSettings extends UseCase<Input, SeoSettingsPage, SeoFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.restore-seo-settings',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SEO_EDIT.key] },
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
    const result = await restoreSeoVersion(this.deps, context, input);
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
