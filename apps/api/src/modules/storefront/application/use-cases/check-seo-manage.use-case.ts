import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SEO_MANAGE } from '../../contracts/permissions';

/**
 * `storefront.check-seo-manage`: answers whether the calling admin holds `storefront.seo.manage`.
 * A probe for the restore, which needs the key only when the version it brings back changes a
 * protected field. It reads and changes nothing.
 */
export class CheckStorefrontSeoManage extends UseCase<
  Record<string, never>,
  true,
  { readonly code: string }
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.check-seo-manage',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SEO_MANAGE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<true, { readonly code: string }>> {
    return Promise.resolve(ok(true as const));
  }
}
