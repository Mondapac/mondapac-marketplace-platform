// The seller setup steps S2 to S5 in order (sellers ux 1.1) and the routes of IA section 5.

export type SetupStepKey = 'business' | 'address' | 'number' | 'slug';

export const SETUP_ROOT = '/account-setup';

export const SETUP_STEPS: readonly { key: SetupStepKey; href: string }[] = [
  { key: 'business', href: `${SETUP_ROOT}/business-details` },
  { key: 'address', href: `${SETUP_ROOT}/address` },
  { key: 'number', href: `${SETUP_ROOT}/business-number` },
  { key: 'slug', href: `${SETUP_ROOT}/web-address` },
];

/** Where "Save and continue" goes: the next step, or the account page after the last one. */
export function nextHref(key: SetupStepKey): string {
  const index = SETUP_STEPS.findIndex((step) => step.key === key);
  return SETUP_STEPS[index + 1]?.href ?? SETUP_ROOT;
}

export function stepNumber(key: SetupStepKey): number {
  return SETUP_STEPS.findIndex((step) => step.key === key) + 1;
}

export const REVIEW_HREF = `${SETUP_ROOT}/review`;
