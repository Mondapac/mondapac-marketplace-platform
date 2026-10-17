import type { ReviewPolicy } from '../../domain/review';

/**
 * The synthetic Market's review policy (design 5.1): a shorter list of checks and its own
 * reasons, so tests prove the review generic. The words are made up.
 */
export const ZZ_REVIEW_POLICY: ReviewPolicy = {
  checks: [
    { code: 'seal-read', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'validity-read', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'registry-lookup', required: false, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'statement-read', required: true, modes: ['SELF_DECLARATION'] },
  ],
  reasons: [
    {
      code: 'seal-blurred',
      check: 'seal-read',
      nextStep: 'send-sharper-scan',
      label: 'The seal is blurred.',
      outcomes: ['changes-requested'],
    },
    {
      code: 'validity-wrong',
      check: 'validity-read',
      nextStep: 'fix-validity',
      label: 'The validity dates are wrong.',
      outcomes: ['changes-requested', 'declined'],
    },
    {
      code: 'forged',
      check: 'seal-read',
      nextStep: 'ask-support',
      label: 'The certificate is not genuine.',
      outcomes: ['declined'],
    },
  ],
};
