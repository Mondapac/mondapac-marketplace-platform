import { canonicalJson } from '@mondapac/shared-kernel';
import type { ContentHash } from '@mondapac/shared-kernel';
import { sha256ContentHash } from '../../../../platform/hashing/content-hash';
import type { RevisionContent } from '../../domain/revision-content';

/**
 * The `contentHash` of a frozen revision (data design 3.7; ADR-0009): `sha256:` over the RFC 8785
 * canonical JSON of the content. The content is public business content, not personal, so the
 * plain hash is enough and anyone can recompute it. Key order does not matter; the order of the
 * lists that carry meaning (categories, variants, images, definition revisions) does.
 */
export function revisionContentHash(content: RevisionContent): ContentHash {
  const canonical = canonicalJson(content);
  if (!canonical.ok) {
    throw new TypeError(`revisionContentHash: content is not canonical (${canonical.error.code})`);
  }
  return sha256ContentHash(new TextEncoder().encode(canonical.value));
}
