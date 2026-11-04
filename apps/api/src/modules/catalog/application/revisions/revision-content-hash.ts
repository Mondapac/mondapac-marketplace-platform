import { canonicalJson } from '@mondapac/shared-kernel';
import type { ContentHash } from '@mondapac/shared-kernel';
import { sha256ContentHash } from '../../../../platform/hashing/content-hash';
import type { RevisionContent, RevisionVariantContent } from '../../domain/revision-content';

/**
 * The `contentHash` of a frozen revision (data design 3.7; ADR-0009): `sha256:` over the RFC 8785
 * canonical JSON of the content. The content is public business content, not personal, so the
 * plain hash is enough and anyone can recompute it. Key order does not matter; the order of the
 * lists that carry meaning (categories, variants, images, definition revisions) does.
 */
export function revisionContentHash(content: RevisionContent): ContentHash {
  const canonical = canonicalJson({ ...content, variants: content.variants.map(hashedVariant) });
  if (!canonical.ok) {
    throw new TypeError(`revisionContentHash: content is not canonical (${canonical.error.code})`);
  }
  return sha256ContentHash(new TextEncoder().encode(canonical.value));
}

/**
 * A variant as the hash sees it. The per-variant fields of V4 (GTIN, shipping, picks) are left
 * out while they hold their empty value, so a revision stored before V4, which carries none, still
 * hashes to the value it was stored with; the moment a field is set it joins the hash.
 */
function hashedVariant(variant: RevisionVariantContent): Record<string, unknown> {
  const {
    gtin,
    shippingWeightGrams,
    shippingLengthMm,
    shippingWidthMm,
    shippingHeightMm,
    imageIds,
    ...rest
  } = variant;
  return {
    ...rest,
    ...(gtin === null ? {} : { gtin }),
    ...(shippingWeightGrams === null ? {} : { shippingWeightGrams }),
    ...(shippingLengthMm === null ? {} : { shippingLengthMm }),
    ...(shippingWidthMm === null ? {} : { shippingWidthMm }),
    ...(shippingHeightMm === null ? {} : { shippingHeightMm }),
    ...(imageIds.length === 0 ? {} : { imageIds }),
  };
}
