import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions the storefront owns (issue #491). `storefront.seo.change-protected`: a platform
 * admin presents a fresh two-step code (`POST identity/admin/step-up/verify`) before changing the
 * fields of the SEO settings that need `storefront.seo.manage` (indexing, logo, business details,
 * verification codes, analytics id). Guarded on `PUT storefront/admin/seo/protected` with
 * `@RequiresStepUp`; the same proof is spent in the unit of the change, also when a restore
 * brings back such a field.
 */
export const STOREFRONT_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'storefront.seo.change-protected',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const STOREFRONT_SEO_PROTECTED_STEP_UP = 'storefront.seo.change-protected';
