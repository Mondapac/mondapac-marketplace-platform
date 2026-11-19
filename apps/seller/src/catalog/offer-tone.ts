import type { BadgeTone } from '@mondapac/ui';

export const OFFER_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  'pending-first-publish': 'attention',
  'changes-needed': 'critical',
  published: 'success',
  unknown: 'neutral',
};
