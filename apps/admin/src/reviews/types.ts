// Answers of GET reviews/admin/moderation[/:id] and the action routes (buyer reviews, package 2).

export const VIEW_PERMISSION = 'reviews.moderation.queue';
export const MODERATE_PERMISSION = 'reviews.moderation.moderate';
export const REMOVE_PERMISSION = 'reviews.moderation.remove';
export const PAGE_SIZE = 25;

export const TABS = ['held', 'reported', 'actioned'] as const;
export type Tab = (typeof TABS)[number];

export const ACTIONS = ['publish', 'hide', 'restore', 'remove', 'dismiss-reports'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The reason codes of each action (the API's closed lists). There is no reason for a negative
 * review or a seller request: a true negative review is never hidden for being negative.
 */
export const REASONS: Readonly<Record<Action, readonly string[]>> = {
  publish: ['checked-ok'],
  hide: [
    'personal-information',
    'abusive',
    'irrelevant',
    'not-a-purchase',
    'incentivised',
    'spam',
    'other',
  ],
  restore: ['reinstated', 'hidden-in-error'],
  remove: ['illegal', 'defamatory', 'personal-information', 'abusive'],
  'dismiss-reports': ['not-against-policy', 'duplicate'],
};

export interface ReviewRow {
  readonly id: string;
  readonly productId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly status: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly openReports: number;
  readonly signalCodes: readonly string[];
}

export interface HistoryRow {
  readonly action: string;
  readonly reasonCode: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly byModerator: boolean;
  readonly at: string;
}

export interface ReviewDetail extends ReviewRow {
  readonly reportReasons: readonly { readonly reasonCode: string; readonly count: number }[];
  readonly history: readonly HistoryRow[];
  readonly allowedActions: readonly string[];
}

export interface QueuePage {
  readonly tab: Tab;
  readonly items: readonly ReviewRow[];
  readonly nextCursor: string | null;
  readonly counts: Readonly<Record<Tab, number>>;
}
