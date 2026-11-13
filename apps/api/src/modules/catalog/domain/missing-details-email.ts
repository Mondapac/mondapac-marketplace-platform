// The "Email sellers" mail of the Missing details report (attributes package A4-4). The text is
// approved by john (11 Nov 2026) and is English only: every email to a seller is English, with no
// translated variant. It names products and the English catalogue names of the missing details; no
// price, no deadline and no threat of removal (decision ت۷: products stay on sale).

/** A seller and a product are asked for at most once in this many days. */
export const MISSING_DETAILS_EMAIL_THROTTLE_DAYS = 7;
/** Products one request may name. */
export const MISSING_DETAILS_EMAIL_MAX_PRODUCTS = 200;
/** Sends tried for one request before it is given up as `failed`. */
export const MISSING_DETAILS_EMAIL_MAX_ATTEMPTS = 3;
/** The most details listed on one product line; the rest is "and N more". */
const MAX_DETAILS_PER_LINE = 8;

export interface MissingDetailsEmailProduct {
  readonly productName: string;
  /** English names of the missing details, in the feature set's order. */
  readonly missingLabels: readonly string[];
}

export interface MissingDetailsEmailInput {
  readonly sellerName: string | null;
  readonly products: readonly MissingDetailsEmailProduct[];
  /** The seller panel's Products page; the mail opens it filtered to "Missing details". */
  readonly productsPage: string;
}

export interface MissingDetailsEmail {
  readonly subject: string;
  readonly text: string;
}

/** The link of the mail: the configured page with the "Missing details" filter. */
export function missingDetailsLink(productsPage: string): string {
  const url = new URL(productsPage);
  url.searchParams.set('filter', 'missing-details');
  return url.toString();
}

/** A header-safe single line: no control character, no line break. */
function oneLine(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
    out += control ? ' ' : char;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

function productLine(product: MissingDetailsEmailProduct): string {
  const labels = product.missingLabels.map(oneLine).filter((label) => label !== '');
  const shown = labels.slice(0, MAX_DETAILS_PER_LINE);
  const rest = labels.length - shown.length;
  const details = rest > 0 ? [...shown, `and ${rest} more`] : shown;
  return `- ${oneLine(product.productName)}: ${details.join(', ')}`;
}

/** Composes the one mail a seller gets, listing only that seller's requested products. */
export function missingDetailsEmail(input: MissingDetailsEmailInput): MissingDetailsEmail {
  const count = input.products.length;
  const subject =
    count === 1
      ? '1 of your products needs more details'
      : `${count} of your products need more details`;
  const name = input.sellerName === null ? '' : oneLine(input.sellerName);
  const text = [
    name === '' ? 'Hi,' : `Hi ${name},`,
    '',
    'We have added new required details for some product categories. The products below are still on sale, and nothing changes for buyers right now. The next time you update one of them, you will need to fill in these details:',
    '',
    ...input.products.map(productLine),
    '',
    'Adding them now takes a minute and helps buyers find and compare your products.',
    '',
    'Open your products:',
    missingDetailsLink(input.productsPage),
    '',
    'Questions? Reply to this email or contact seller support from your panel.',
    '',
    'The Mondapac team',
    '',
  ].join('\n');
  return { subject, text };
}
