import { bodyTexts, imagesOf, productsOf } from './body';
import { linksOf } from './content';
import type { OwnerType, PostContent, PostKind } from './content';
import { Temporal } from '@mondapac/shared-kernel';

// The automatic checks run when a post is sent for review and again when it is approved. They are
// pure: the facts that need other modules (which products are on sale, which ones a seller sells,
// which texts make a certification claim) are passed in, and an answer that could not be had is
// `null`, which counts against the post (fail closed). An `error` blocks the submit and the
// approval; a `warning` and a `notice` are shown to the reviewer and block nothing.

export type Severity = 'error' | 'warning' | 'notice';

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  /** Where in the content (`body[3]`, `links[1]`, `title`), or null for the post as a whole. */
  readonly path: string | null;
}

/** What the catalog says about a product the post links to. */
export interface ProductFact {
  readonly onSale: boolean;
  readonly soldBySeller: boolean;
}

/** The answer of the certification check for the texts asked: the paths whose text claims. */
export type ClaimAnswer = { readonly hitPaths: ReadonlySet<string> } | null;

export interface CheckFacts {
  readonly kind: PostKind;
  readonly ownerType: OwnerType;
  readonly sellerId: string | null;
  readonly content: PostContent;
  readonly now: Temporal.Instant;
  /** The Market's currency code, for a price typed into the text. */
  readonly currencyCode: string;
  readonly healthTerms: readonly string[];
  /** Product id to its facts; `null` when the catalog could not be asked. */
  readonly products: ReadonlyMap<string, ProductFact> | null;
  readonly claims: ClaimAnswer;
}

/** The most findings answered. */
const MAX_FINDINGS = 100;

/** The texts of a version that readers see, with their paths. */
export function readableTexts(
  content: PostContent,
): readonly { readonly path: string; readonly text: string }[] {
  const texts: { path: string; text: string }[] = [{ path: 'title', text: content.title }];
  if (content.excerpt !== '') texts.push({ path: 'excerpt', text: content.excerpt });
  if (content.seoTitle !== null) texts.push({ path: 'seoTitle', text: content.seoTitle });
  if (content.seoDescription !== null) {
    texts.push({ path: 'seoDescription', text: content.seoDescription });
  }
  if (content.coverAlt !== null) texts.push({ path: 'coverAlt', text: content.coverAlt });
  texts.push(...bodyTexts(content.body));
  if (content.event?.statusMessage) {
    texts.push({ path: 'event.statusMessage', text: content.event.statusMessage });
  }
  return texts;
}

const TLDS =
  'com|net|org|io|co|info|biz|app|dev|shop|store|online|site|xyz|me|ly|gl|to|us|uk|au|nz|de|fr|jp|cn|in|ca|eu|tv|cc|link|page|blog|club|live|top|vip|work';
/** A scheme, `www.`, an e-mail address or a bare domain: a way off the site. */
const EXTERNAL = new RegExp(
  String.raw`(?:\b[a-z][a-z0-9+.-]{1,15}://|\bwww\.|\bmailto:|\b[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b(?:/\S*)?)`,
  'iu',
);

/** Whether a text points readers to somewhere outside the site. */
export const hasExternalLink = (text: string): boolean => EXTERNAL.test(text);

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** A price typed into the text: a currency symbol with a number, or a number with the code. */
export function hasPriceLikeText(text: string, currencyCode: string): boolean {
  const code = escapeRegExp(currencyCode);
  return new RegExp(
    String.raw`[$€£¥₩₹₫₱฿]\s?\d|\d[\d.,]*\s?[$€£¥₩₹₫₱฿]|\b\d[\d.,]*\s?${code}\b|\b${code}\s?\d`,
    'iu',
  ).test(text);
}

/** Whether the text holds one of the terms as whole words, ignoring case. */
export function hasHealthWording(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => {
    const needle = term.toLowerCase();
    return new RegExp(
      String.raw`(?<![\p{L}\p{N}])${escapeRegExp(needle)}(?![\p{L}\p{N}])`,
      'u',
    ).test(lower);
  });
}

/** Runs every check. Order: errors first, in the order of the content. */
export function runChecks(facts: CheckFacts): readonly Finding[] {
  const { content } = facts;
  const found: Finding[] = [];
  const add = (severity: Severity, code: string, path: string | null = null): void => {
    found.push({ severity, code, path });
  };

  if (content.coverImageId === null) add('error', 'cover-missing', 'coverImageId');
  else if (content.coverAlt === null || content.coverAlt.trim() === '') {
    add('error', 'cover-alt-missing', 'coverAlt');
  }
  if (content.categoryId === null) add('error', 'category-missing', 'categoryId');
  if (content.body.length === 0) add('error', 'body-empty', 'body');
  if (content.excerpt === '') add('warning', 'excerpt-missing', 'excerpt');
  for (const image of imagesOf(content.body)) {
    if (image.alt === '') add('error', 'image-alt-missing', image.path);
  }

  const links = linksOf(content);
  const productLinks = links.filter((link) => link.type === 'product');
  if (facts.kind === 'product' && productLinks.length === 0) {
    add('error', 'product-link-missing', 'links');
  }
  if (facts.kind === 'brand' && !links.some((link) => link.type === 'brand')) {
    add('error', 'brand-link-missing', 'links');
  }
  if (facts.kind === 'event') {
    if (content.event === null) add('error', 'event-missing', 'event');
    else {
      if (Temporal.Instant.compare(content.event.endsAt, facts.now) <= 0) {
        add('error', 'event-ended', 'event.endsAt');
      }
      if (content.event.registrationUrl !== null) {
        add('notice', 'registration-url-present', 'event.registrationUrl');
      }
    }
  }

  if (
    productLinks.length > 0 ||
    (facts.ownerType === 'seller' && productsOf(content.body).length > 0)
  ) {
    if (facts.products === null) add('error', 'products-unverifiable', 'links');
    else {
      for (const [index, link] of links.entries()) {
        if (link.type !== 'product') continue;
        const fact = facts.products.get(link.id);
        const path = `links[${index}]`;
        if (fact === undefined || !fact.onSale) add('error', 'product-not-on-sale', path);
        else if (facts.ownerType === 'seller' && !fact.soldBySeller) {
          add('error', 'product-not-own', path);
        }
      }
    }
  }
  if (facts.ownerType === 'seller') {
    for (const [index, link] of links.entries()) {
      if (link.type === 'seller' && link.id !== facts.sellerId) {
        add('error', 'seller-link-not-own', `links[${index}]`);
      }
      if (link.type === 'brand') add('notice', 'brand-link-unverified', `links[${index}]`);
    }
  }

  const texts = readableTexts(content);
  for (const { path, text } of texts) {
    if (hasExternalLink(text)) add('error', 'external-link', path);
  }
  if (facts.claims === null) add('error', 'claims-unverifiable', null);
  else {
    const hits = facts.claims.hitPaths;
    for (const { path } of texts) {
      if (hits.has(path)) add('error', 'certification-claim', path);
    }
  }
  const warned = new Set<string>();
  for (const { path, text } of texts) {
    if (hasPriceLikeText(text, facts.currencyCode) && !warned.has(`price:${path}`)) {
      warned.add(`price:${path}`);
      add('warning', 'price-in-text', path);
    }
    if (hasHealthWording(text, facts.healthTerms) && !warned.has(`health:${path}`)) {
      warned.add(`health:${path}`);
      add('warning', 'health-wording', path);
    }
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };
  return dedupe(found)
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, MAX_FINDINGS);
}

function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.severity}|${finding.code}|${finding.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

export const blocking = (findings: readonly Finding[]): readonly Finding[] =>
  findings.filter((finding) => finding.severity === 'error');
