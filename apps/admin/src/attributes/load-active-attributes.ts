import { callApi } from '../api/client.ts';
import { API_ATTRIBUTES, type AttributePage } from './types.ts';

/** The API's page size for the attribute list (`ATTRIBUTE_PAGE_MAX`): a larger `limit` is refused. */
const PAGE = 50;
/** At most this many pages are read (500 attributes), so a picker never loops on a bad cursor. */
const MAX_PAGES = 10;

export type ActiveAttributes =
  | { readonly ok: true; readonly items: AttributePage['items']; readonly locale: string }
  | { readonly ok: false; readonly status: number };

/** Every active attribute (of one data type, when given) for a picker, read page by page; a failed page fails the whole read. */
export async function loadActiveAttributes(type?: string): Promise<ActiveAttributes> {
  const items: AttributePage['items'][number][] = [];
  let locale = '';
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: 'active', limit: String(PAGE) });
    if (type !== undefined) query.set('type', type);
    if (afterId !== null) query.set('afterId', afterId);
    const result = await callApi<AttributePage>('GET', `${API_ATTRIBUTES}?${query.toString()}`);
    if (!result.ok) return { ok: false, status: result.failure.status };
    items.push(...result.body.items);
    locale = result.body.locales?.default ?? locale;
    afterId = result.body.nextAfterId ?? null;
    if (afterId === null) break;
  }
  return { ok: true, items, locale };
}
