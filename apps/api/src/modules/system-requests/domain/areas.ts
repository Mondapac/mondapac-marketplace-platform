// The reviewed areas and their defaults (owner decisions of 15 Nov 2026): the high-risk areas
// (people, money, delivery, catalogue structure, certification) are reviewed from the start;
// marketplace settings and content are not. The review policy itself is always reviewed, as high
// risk, by the people reviewers, so nobody can turn review off quietly.

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/** The areas whose review an admin can turn on or off on the Review policy page. */
export const POLICY_AREAS = [
  'people',
  'money',
  'delivery',
  'catalogue',
  'certification',
  'marketplace',
  'content',
] as const;
export type PolicyArea = (typeof POLICY_AREAS)[number];

/** Every area a request can belong to: the policy areas and the review policy itself. */
export const REVIEW_AREAS = [...POLICY_AREAS, 'review-policy'] as const;
export type ReviewArea = (typeof REVIEW_AREAS)[number];

export interface AreaPolicy {
  readonly enabled: boolean;
  readonly risk: Risk;
}

/** What a Market has while no admin changed the area's policy. */
export const AREA_DEFAULTS: Readonly<Record<PolicyArea, AreaPolicy>> = Object.freeze({
  people: { enabled: true, risk: 'high' },
  money: { enabled: true, risk: 'high' },
  delivery: { enabled: true, risk: 'medium' },
  catalogue: { enabled: true, risk: 'medium' },
  certification: { enabled: true, risk: 'medium' },
  marketplace: { enabled: false, risk: 'low' },
  content: { enabled: false, risk: 'low' },
});

/** The policy of the review policy: always reviewed, always high risk. */
export const REVIEW_POLICY_POLICY: AreaPolicy = Object.freeze({ enabled: true, risk: 'high' });

/** Days after which an open request is overdue, while no admin changed it; 1 to 90. */
export const DEFAULT_REVIEW_DUE_DAYS = 7;
export const MIN_REVIEW_DUE_DAYS = 1;
export const MAX_REVIEW_DUE_DAYS = 90;

export const isRisk = (value: unknown): value is Risk =>
  typeof value === 'string' && (RISKS as readonly string[]).includes(value);

export const isPolicyArea = (value: unknown): value is PolicyArea =>
  typeof value === 'string' && (POLICY_AREAS as readonly string[]).includes(value);

export const isReviewArea = (value: unknown): value is ReviewArea =>
  typeof value === 'string' && (REVIEW_AREAS as readonly string[]).includes(value);

const RANK: Readonly<Record<Risk, number>> = { low: 0, medium: 1, high: 2 };

/** The higher of two risks: a module may raise a change's risk above the area's, never lower it. */
export const higherRisk = (a: Risk, b: Risk): Risk => (RANK[a] >= RANK[b] ? a : b);
