import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogIndexFacade } from '../../catalog';
import type { IndexStamp } from '../application/ports/reindex';

/** {@link IndexStamp} over catalog's index facade (system actor only). A refusal is `null`. */
export class FacadeIndexStamp implements IndexStamp {
  constructor(private readonly catalog: CatalogIndexFacade) {}

  async current(context: CallContext): Promise<string | null> {
    const answer = await this.catalog.searchIndexStamp(context);
    return answer.ok ? answer.value : null;
  }
}
