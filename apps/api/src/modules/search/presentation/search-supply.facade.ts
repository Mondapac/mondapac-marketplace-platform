import type { CallContext } from '@mondapac/shared-kernel';
import type { CountLiveListings } from '../application/use-cases/count-live-listings.use-case';
import type { SearchSupplyFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class SearchSupplyFacadeImplementation implements SearchSupplyFacade {
  constructor(private readonly liveListingsUseCase: CountLiveListings) {}

  liveListings(context: CallContext, query: { readonly signal: AbortSignal }) {
    return this.liveListingsUseCase.execute(context, query);
  }
}
