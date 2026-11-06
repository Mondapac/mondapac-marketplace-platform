import type { IndexStamp, ReindexProgress } from './ports/reindex';
import type { SearchDependencies } from './search-dependencies';

/** What the attribute reindex needs: the sync ports plus its progress row and the catalog stamp. */
export interface ReindexDependencies extends SearchDependencies {
  readonly progress: ReindexProgress;
  readonly stamp: IndexStamp;
}
