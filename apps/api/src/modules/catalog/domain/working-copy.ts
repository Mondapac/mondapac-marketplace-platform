import type { Id, Temporal } from '@mondapac/shared-kernel';

/** The version of the working-copy `content` shape a save writes (data design 3.6). */
export const WORKING_COPY_CONTENT_SCHEMA_VERSION = 1;

/** The largest serialised `content` a save accepts (UTF-8 bytes of its JSON). */
export const MAX_WORKING_COPY_CONTENT_BYTES = 256 * 1024;

/**
 * The editable draft of one product (catalog design 2.3 M-2): not a revision, one per product,
 * saved over the previous one. `content` is opaque JSON here; the schema that validates it is
 * the attribute schema of the product's family and arrives with the submit (slice 4c-4 and
 * later). `variantIds` are not stored in it: the variant registry of the product owns them.
 */
export interface WorkingCopy {
  readonly productId: Id<'Product'>;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentSchemaVersion: number;
  /** The published revision the draft was started from, or null for a never-published product. */
  readonly baseRevisionId: Id<'ProductRevision'> | null;
  readonly lastSavedAt: Temporal.Instant;
  readonly lastSavedByAccountId: Id<'Account'>;
}

/** A plain JSON object (not an array, not null) whose serialisation fits the size cap. */
export function isStorableContent(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  return json !== undefined && Buffer.byteLength(json, 'utf8') <= MAX_WORKING_COPY_CONTENT_BYTES;
}
