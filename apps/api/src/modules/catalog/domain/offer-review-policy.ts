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

/**
 * Raise this whenever a rule below changes meaning. 2: the edit rules of a live Offer (slice 2c,
 * {@link offerEditReviewReasons}).
 */
export const OFFER_REVIEW_POLICY_VERSION = 2;

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

/**
 * One edit of a live (`published`) Offer, as the edit rules read it (slice 2c). Each field is given
 * only when the edit changes it: `newHandling` when the handling changes, `newDescription` when
 * the description changes, `addedBadgeTypes` the badge types the edit adds (types with no open
 * tag). These three are the watched fields; every other field of an Offer is never held.
 */
export interface OfferEditReviewInput {
  readonly mode: OfferReviewMode;
  readonly certificateBadges: 'review' | 'automatic';
  readonly addedBadgeTypes: readonly string[];
  readonly newHandling?: OfferHandling;
  /** Locale to text: the whole new description. */
  readonly newDescription?: Readonly<Record<string, string>>;
}

/**
 * The reasons an edit of a live Offer is held for review; empty means it applies at once. Only R2
 * (a new badge type while badges are reviewed), R3 (handling changed to anything but
 * `SEALED_ORIGINAL`) and R5 (contact text in any locale of a changed description) run on edits:
 * R0, R1 and R6 judge a seller's first publication, and R7 is a no-op because a category change is
 * a product revision (VER-02). Mode `off` holds nothing; mode `all` holds every change of a watched
 * field, with `review-all` when no rule applies.
 */
export function offerEditReviewReasons(input: OfferEditReviewInput): readonly OfferReviewReason[] {
  if (input.mode === 'off') return [];
  const found = new Set<OfferReviewReason>();
  if (input.addedBadgeTypes.length > 0 && input.certificateBadges === 'review') {
    found.add('certificate-badge');
  }
  if (input.newHandling !== undefined && input.newHandling !== 'SEALED_ORIGINAL') {
    found.add('handling');
  }
  if (
    input.newDescription !== undefined &&
    Object.values(input.newDescription).some(hasContactText)
  ) {
    found.add('contact-text');
  }
  const watched =
    input.addedBadgeTypes.length > 0 ||
    // Handling back to sealed original lowers the risk: instant in every mode (Hadi, 2026-11-25).
    (input.newHandling !== undefined && input.newHandling !== 'SEALED_ORIGINAL') ||
    input.newDescription !== undefined;
  if (input.mode === 'all' && found.size === 0 && watched) found.add('review-all');
  return OFFER_REVIEW_REASONS.filter((reason) => found.has(reason));
}

// R5: text that sends a buyer off the platform. A false positive only means a human looks, so the
// patterns lean wide; none of them is ever shown to the seller as "the" rule.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
/** A bare domain such as `shop.example.com.au`: a label, a dot and a known top-level domain. */
const DOMAIN_PATTERN =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|au|nz|io|co|shop|store|biz|info|me|app|online|site)\b/i;
/**
 * The local part starts where no local-part character precedes it and is capped at 64, so a long
 * run of those characters with no at sign fails in linear time (Hassan S1, ReDoS).
 */
const EMAIL_PATTERN =
  /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}\s?(?:@|\(at\)|\[at\])\s?[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,4}/i;
/** Eight or more digits, allowing spaces, dots, dashes, brackets and a leading plus between them. */
const PHONE_PATTERN = /(?:\+|\b)\d(?:[\s.()-]{0,2}\d){7,}/;
/** A handle such as `@kedron_meats` (not an e-mail: no word character before the at sign). */
const HANDLE_PATTERN = /(?:^|[^\w@.])@[a-z0-9_.]{3,30}\b/i;
const CHANNEL_PATTERN =
  /\b(?:whats\s?app|telegram|wechat|viber|instagram|insta|facebook|fb|tiktok|snapchat|messenger|dm\s+me|text\s+me|call\s+me)\b/i;

/** Dates such as `2027-03-01` or `01.03.2027`, removed before the phone test. */
const DATE_PATTERN = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[.-]\d{1,2}[.-]\d{4})\b/g;
/** A number named as a product or business identifier (barcode, SKU, ABN...), removed likewise. */
const LABELLED_NUMBER_PATTERN =
  /\b(?:barcode|ean|upc|gtin|sku|abn|acn|batch|lot)\s*[:#]?\s*\d[\d\s-]*/gi;
/** A barcode: 12 to 14 digits with no separator (EAN-13, UPC-A, GTIN-14), removed likewise. */
const BARCODE_PATTERN = /\b\d{12,14}\b/g;

/** The text with dates, labelled identifiers and barcodes taken out, for the phone test. */
const withoutNumbersThatAreNotPhones = (text: string): string =>
  text
    .replace(DATE_PATTERN, ' ')
    .replace(LABELLED_NUMBER_PATTERN, ' ')
    .replace(BARCODE_PATTERN, ' ');

/** Zero-width characters a seller can hide between digits or letters. */
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/** Arabic-Indic and Eastern Arabic-Indic digits, which NFKC leaves as they are. */
const ARABIC_DIGIT_PATTERN = /[\u0660-\u0669\u06F0-\u06F9]/g;

/**
 * The text as the patterns read it: compatibility forms folded (full-width `＠` and digits), hidden
 * characters removed and Arabic-Indic digits as ASCII digits (Hassan, R5 bypass notes).
 */
function normalised(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_PATTERN, '')
    .replace(ARABIC_DIGIT_PATTERN, (digit) => String((digit.charCodeAt(0) - 0x0660) % 0x90));
}

/** True when the text holds a link, an e-mail, a phone number or a social handle (R5). */
export function hasContactText(raw: string): boolean {
  const text = normalised(raw);
  if (PHONE_PATTERN.test(withoutNumbersThatAreNotPhones(text))) return true;
  return [URL_PATTERN, DOMAIN_PATTERN, EMAIL_PATTERN, HANDLE_PATTERN, CHANNEL_PATTERN].some(
    (pattern) => pattern.test(text),
  );
}
