import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import { BLOG_POST_READ, BLOG_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { POST_LIST_VIEWS, POST_SORT_KEYS } from '../../domain/admin-post-list';
import { parsePostSelector } from '../admin-post-list-flow';

// The list blog registers with `lists` (super list phase 4, PR10) so it has saved filters through
// the generic routes: the admin Blog posts list (26). The selector keys of a saved filter go
// through the list's own reading, so a saved value is exactly one the list accepts; the keys are
// the ones that guard it. The older list's `status` (read as the view) is not a saved key.

const POSTS: ListDefinition = {
  listKey: 'admin.blog.posts',
  population: 'admin',
  viewKey: BLOG_POST_READ.key,
  shareKey: BLOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: POST_LIST_VIEWS,
    filterKeys: ['kind', 'owner', 'sellerId', 'featured', 'from', 'to'],
    sorts: POST_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const filter = parsePostSelector(query, fields);
      return {
        fields,
        canonical: canonicalQuery({
          q: filter.search,
          kind: filter.kind,
          owner: filter.ownerType,
          sellerId: filter.sellerId,
          featured: filter.featured === null ? null : String(filter.featured),
          from: filter.from,
          to: filter.to,
        }),
      };
    },
  }),
};

export const BLOG_LISTS: readonly ListDefinition[] = [POSTS];
