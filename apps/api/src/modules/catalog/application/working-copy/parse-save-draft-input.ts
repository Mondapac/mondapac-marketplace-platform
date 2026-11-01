import { err, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

/** The request as a route or the import job passes it: ids as strings, the draft as parsed JSON. */
export interface SaveDraftRequest {
  readonly productId: string;
  readonly content: unknown;
  /** The draft's variant list in order: an id the server minted, or null for a new variant. */
  readonly variantIds: readonly (string | null)[];
}

export type SaveDraftRequestFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export function parseSaveDraftInput(
  input: SaveDraftRequest,
): Result<
  { productId: Id<'Product'>; content: unknown; variantIds: (Id<'Variant'> | null)[] },
  SaveDraftRequestFailure
> {
  const fail = (path: string, code: string): Result<never, SaveDraftRequestFailure> =>
    err({ code: 'validation.failed', fields: [{ path, code }] });
  if (typeof input !== 'object' || input === null) return fail('body', 'type');
  const product = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
  if (product === null || !product.ok) return fail('productId', 'format');
  if (!Array.isArray(input.variantIds) || input.variantIds.length > 500) {
    return fail('variantIds', 'type');
  }
  const variantIds: (Id<'Variant'> | null)[] = [];
  for (const [index, value] of (input.variantIds as readonly unknown[]).entries()) {
    if (value === null) {
      variantIds.push(null);
      continue;
    }
    const variant = typeof value === 'string' ? parseId<'Variant'>(value) : null;
    if (variant === null || !variant.ok) return fail(`variantIds[${index}]`, 'format');
    variantIds.push(variant.value);
  }
  return { ok: true, value: { productId: product.value, content: input.content, variantIds } };
}
