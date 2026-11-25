/**
 * The Offer review policy (risk-based Offer approval, design section 6; ADR-0051): which reasons
 * send an Offer to the review queue instead of publishing it at once. Pure: the use case reads the
 * Market's settings and the facts, and this decides. R4 (price against the reference) is not here:
 * pricing holds a first price outside the band (ADR-0024), so an Offer goes live only when both are
 * green.
 *
 * The policy is versioned: every stored referral and every audit row carries
 * {@link OFFER_REVIEW_POLICY_VERSION}, so a decision can be explained against the rules of its day.
 * Change the rules, change the version.
 */
import type { OfferHandling } from './offer-handling';

/** Raise this whenever a rule below changes meaning. */
export const OFFER_REVIEW_POLICY_VERSION = 1;

/**
 * The reasons, in the order the queue shows them. Each maps to a rule of the design:
 * `emergency-stop` R0, `probation` R1, `certificate-badge` R2, `handling` R3, `contact-text` R5,
 * `full-review` R6, `sensitive-category` R7. `review-all` is the Market's "All" mode with no other
 * reason.
 */
export const OFFER_REVIEW_REASONS = [
  'emergency-stop',
  'probation',
  'certificate-badge',
  'handling',
  'contact-text',
  'full-review',
  'sensitive-category',
  'review-all',
] as const;
export type OfferReviewReason = (typeof OFFER_REVIEW_REASONS)[number];

/** The Market's review mode (settings `catalog.offer-review.mode`). */
export type OfferReviewMode = 'all' | 'risk-based' | 'off';

/** The facts about the seller, the product and the Market that are not on the Offer. */
export interface OfferReviewFacts {
  /** R0: the emergency stop is on for the Market, a category of the product or the seller. */
  readonly emergencyStop: boolean;
  /** R1: the seller is still in probation (fewer than N approved Offers, not Trusted). */
  readonly probation: boolean;
  /** R6: an admin marked the seller for full review, or took an Offer down for misconduct. */
  readonly fullReview: boolean;
  /** R7: a category of the product is marked "always review". */
  readonly sensitiveCategory: boolean;
}

export interface OfferReviewInput {
  readonly mode: OfferReviewMode;
  /** `review` sends every Offer that carries a certificate badge to the queue (R2). */
  readonly certificateBadges: 'review' | 'automatic';
  readonly facts: OfferReviewFacts;
  readonly handling: OfferHandling;
  /** The badge types the Offer will carry after this change (kept and requested). */
  readonly badgeTypes: readonly string[];
  /** Locale to text. */
  readonly description: Readonly<Record<string, string>>;
}

/**
 * The reasons this Offer goes to the queue; empty means publish at once. Mode `off` publishes
 * everything except during an emergency stop (R0 runs before every other rule, design 9.5 b).
 * Mode `all` queues everything, with its own reasons when it has them.
 */
export function offerReviewReasons(input: OfferReviewInput): readonly OfferReviewReason[] {
  const { facts } = input;
  if (input.mode === 'off') return facts.emergencyStop ? ['emergency-stop'] : [];
  const found = new Set<OfferReviewReason>();
  if (facts.emergencyStop) found.add('emergency-stop');
  if (facts.probation) found.add('probation');
  if (input.badgeTypes.length > 0 && input.certificateBadges === 'review') {
    found.add('certificate-badge');
  }
  if (input.handling !== 'SEALED_ORIGINAL') found.add('handling');
  if (Object.values(input.description).some(hasContactText)) found.add('contact-text');
  if (facts.fullReview) found.add('full-review');
  if (facts.sensitiveCategory) found.add('sensitive-category');
  if (input.mode === 'all' && found.size === 0) found.add('review-all');
  return OFFER_REVIEW_REASONS.filter((reason) => found.has(reason));
}

// R5: text that sends a buyer off the platform. A false positive only means a human looks, so the
// patterns lean wide; none of them is ever shown to the seller as "the" rule.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
/** A bare domain such as `shop.example.com.au`: a label, a dot and a known top-level domain. */
const DOMAIN_PATTERN =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|au|nz|io|co|shop|store|biz|info|me|app|online|site)\b/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
/** Eight or more digits, allowing spaces, dots, dashes, brackets and a leading plus between them. */
const PHONE_PATTERN = /(?:\+|\b)\d(?:[\s.()-]{0,2}\d){7,}/;
/** A handle such as `@kedron_meats` (not an e-mail: no word character before the at sign). */
const HANDLE_PATTERN = /(?:^|[^\w@.])@[a-z0-9_.]{3,30}\b/i;
const CHANNEL_PATTERN =
  /\b(?:whats\s?app|telegram|wechat|viber|signal|instagram|insta|facebook|fb|tiktok|snapchat|messenger|dm\s+me|text\s+me|call\s+me)\b/i;

/** Dates such as `2027-03-01` or `01.03.2027`, removed before the phone test. */
const DATE_PATTERN = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[.-]\d{1,2}[.-]\d{4})\b/g;

/** True when the text holds a link, an e-mail, a phone number or a social handle (R5). */
export function hasContactText(text: string): boolean {
  if (PHONE_PATTERN.test(text.replace(DATE_PATTERN, ' '))) return true;
  return [URL_PATTERN, DOMAIN_PATTERN, EMAIL_PATTERN, HANDLE_PATTERN, CHANNEL_PATTERN].some(
    (pattern) => pattern.test(text),
  );
}
