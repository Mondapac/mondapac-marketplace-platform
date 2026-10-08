// The shop slug rules the page shows. The API checks them again; its descriptors do not carry them
// yet (apps/api sellers domain shop-slug.ts: 3 to 50 characters), so the numbers live here.
export const SLUG_MIN = 3;
export const SLUG_MAX = 50;

/** A slug suggested from the store name, by code (not AI): lowercase, hyphens, no edges. */
export function suggestSlug(storeName: string): string {
  return storeName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/** The local format check, so an invalid slug is never sent for an availability check. */
export function slugFormatOk(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  );
}
