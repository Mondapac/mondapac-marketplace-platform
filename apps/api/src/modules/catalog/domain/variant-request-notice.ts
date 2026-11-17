import type { VariantRequestStatus } from './variant-request';

// The one plain-text mail that tells a seller what became of their request for a new variant
// (variants plan, package V7). English, as the panels are; no link, no HTML. The reviewer's reason
// is quoted as plain text; nothing else of the product or the seller is named.

export interface VariantRequestNoticeFacts {
  readonly status: Exclude<VariantRequestStatus, 'open'>;
  /** The product's public code. */
  readonly productCode: string;
  /** What was asked for in the Market's default locale, e.g. `Size: L`. */
  readonly described: string;
  /** The reviewer's words (declined). */
  readonly reason: string | null;
}

export interface VariantRequestNoticeMail {
  readonly subject: string;
  readonly text: string;
}

export function variantRequestNoticeMail(
  facts: VariantRequestNoticeFacts,
): VariantRequestNoticeMail {
  const asked = `You asked for a new variant (${facts.described}) of product ${facts.productCode}.`;
  if (facts.status === 'approved') {
    return {
      subject: `Your requested variant of ${facts.productCode} was added`,
      text: [
        asked,
        '',
        'The variant was added to the product. It goes through the normal review, and you can sell it as soon as it is published. Open Sizes you sell on your offer in the seller panel to switch it on.',
      ].join('\n'),
    };
  }
  if (facts.status === 'mapped') {
    return {
      subject: `${facts.productCode} already has a variant that fits`,
      text: [
        asked,
        '',
        'The product already has a variant that fits your request. Open Sizes you sell on your offer in the seller panel and switch it on.',
      ].join('\n'),
    };
  }
  return {
    subject: `Your requested variant of ${facts.productCode} was not added`,
    text: [
      asked,
      '',
      'It was not added to the product.',
      ...(facts.reason === null ? [] : ['', `Reason: ${facts.reason}`]),
    ].join('\n'),
  };
}
