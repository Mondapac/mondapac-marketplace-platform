import type { DraftPart } from './seller-file';

// What the seller sees (sellers design 3.3; ux 3.3) and the steps card of S1 (identity design
// 8.5; `onboardingSteps`, design 7.1). Pure rules: the access state arrives from `identity` as a
// code, and every Market-specific fact (the area, whether an identifier is required) arrives as
// an input already resolved from configuration.

/** The access states `identity` reports (identity design 3.3); the codes never change. */
export type AccessState = 'pending' | 'approved' | 'rejected' | 'suspended';

/**
 * The status codes of design 3.3 that slice 5b can tell. `not-approved` (the re-apply limit,
 * which only `identity` knows) joins with slice 7b: until then a rejected seller reads
 * `changes-needed`.
 */
export const SELLER_STATUSES = [
  'details-incomplete',
  'outside-service-area',
  'ready-to-submit',
  'awaiting-review',
  'changes-needed',
  'approved',
  'suspended',
  'file-check-needed',
] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export interface StatusInput {
  readonly access: AccessState;
  readonly hasApprovedRevision: boolean;
  /** A pending revision of kind `onboarding` exists. */
  readonly hasPendingOnboardingRevision: boolean;
  /** The mandatory parts the draft lacks against the Market's current rule. */
  readonly missing: readonly DraftPart[];
  /** True when the saved address is outside every area that takes new sellers; null: no address. */
  readonly outsideServiceArea: boolean | null;
  /** A definite negative of the register for the saved identifier (never a value). */
  readonly registerNegative: boolean;
}

/**
 * The one status of design 3.3. A suspended seller has no panel session; the code is for the
 * admin view. An approved seller with no approved revision is Phase 2 data and stays
 * `file-check-needed` (design 3.1, Ali change 1). For a seller still to be decided on, a pending
 * submission is `awaiting-review` whatever else; otherwise an address outside the areas is shown
 * first, because completing the other parts does not help; a rejected seller then reads
 * `changes-needed`, and a pending one `details-incomplete` or `ready-to-submit`.
 */
export function sellerStatusOf(input: StatusInput): SellerStatus {
  if (input.access === 'suspended') return 'suspended';
  if (input.access === 'approved') {
    return input.hasApprovedRevision ? 'approved' : 'file-check-needed';
  }
  if (input.hasPendingOnboardingRevision) return 'awaiting-review';
  if (input.outsideServiceArea === true) return 'outside-service-area';
  if (input.access === 'rejected') return 'changes-needed';
  return input.missing.length > 0 ? 'details-incomplete' : 'ready-to-submit';
}

export type StepState = 'done' | 'to-do' | 'waiting' | 'needs-attention';

/** One step of S1's card (identity design 8.5: owner, title key, state, route). */
export interface OnboardingStep {
  readonly owningModule: 'sellers';
  readonly titleKey: string;
  readonly state: StepState;
  /** How many mandatory parts of the step are missing, or null when the step has none to count. */
  readonly fieldsLeft: number | null;
  // No route: the pages belong to the frontend (ux 8.2); the client maps the title key to its page.
}

const BUSINESS_PARTS: readonly DraftPart[] = ['storeName', 'businessName', 'phone'];
const ADDRESS_PARTS: readonly DraftPart[] = ['address', 'timezone'];

/**
 * The steps of design 7.1 `onboardingSteps`, in the order of the form (ux S1). Each step is
 * `done` when none of its parts is missing; `to-do` otherwise; the address is `needs-attention`
 * while it is outside the areas, and the number while the register's answer is a definite
 * negative (no value, no reason: "not matched" is the one message). The last step is `waiting`
 * until everything before it is done and nothing blocks, then `to-do` (the one action), and
 * `done` once a submission exists or the file is decided. A suspended seller has nothing to do.
 */
export function onboardingStepsOf(
  input: StatusInput,
  status: SellerStatus,
): readonly OnboardingStep[] {
  const left = (parts: readonly DraftPart[]) =>
    parts.filter((part) => input.missing.includes(part)).length;
  const step = (
    titleKey: string,
    parts: readonly DraftPart[],
    blocked: boolean,
  ): OnboardingStep => {
    const count = left(parts);
    return {
      owningModule: 'sellers',
      titleKey: `sellers.steps.${titleKey}`,
      state: blocked ? 'needs-attention' : count === 0 ? 'done' : 'to-do',
      fieldsLeft: count === 0 ? null : count,
    };
  };
  const steps = [
    step('business', BUSINESS_PARTS, false),
    step('address', ADDRESS_PARTS, input.outsideServiceArea === true),
    step('number', ['identifier'], input.registerNegative),
    step('slug', ['slug'], false),
  ];
  const finished =
    status === 'awaiting-review' || status === 'approved' || status === 'file-check-needed';
  const ready = steps.every((candidate) => candidate.state === 'done');
  const submitState: StepState = finished
    ? 'done'
    : status === 'suspended' || !ready
      ? 'waiting'
      : 'to-do';
  // After a submission every step reads done, whatever the draft says now.
  const shown =
    status === 'awaiting-review'
      ? steps.map((candidate): OnboardingStep => ({
          ...candidate,
          state: 'done',
          fieldsLeft: null,
        }))
      : steps;
  return [
    ...shown,
    {
      owningModule: 'sellers',
      titleKey: 'sellers.steps.submit',
      state: submitState,
      fieldsLeft: null,
    },
  ];
}
