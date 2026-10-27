import { findProducts, type ProductPage, type ProductQuery } from '../storefront/catalog.ts';

/**
 * The products of pages `query.page` to `through` as one list (a phone listing that loaded more).
 * `total` and `hasMore` are the last page's; `page` stays the first one.
 */
export async function findProductsThrough(
  query: ProductQuery,
  through: number,
): Promise<ProductPage> {
  const first = await findProducts(query);
  if (through <= query.page || !first.hasMore) return first;
  const pages: ProductPage[] = [first];
  for (let page = query.page + 1; page <= through; page += 1) {
    const last = pages.at(-1);
    if (!last?.hasMore) break;
    pages.push(await findProducts({ ...query, page }));
  }
  const last = pages.at(-1) ?? first;
  return {
    items: pages.flatMap((p) => p.items),
    page: first.page,
    pageSize: first.pageSize,
    hasMore: last.hasMore,
    ...(first.total === undefined ? {} : { total: first.total }),
  };
}
