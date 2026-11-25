import type { CallContext, Temporal } from '@mondapac/shared-kernel';
import type { ZeroResultTextsOf } from '../application/use-cases/zero-result-texts.use-case';
import type { SearchReportingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class SearchReportingFacadeImplementation implements SearchReportingFacade {
  constructor(private readonly texts: ZeroResultTextsOf) {}

  zeroResultTexts(
    context: CallContext,
    request: {
      readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
    },
  ) {
    return this.texts.execute(context, request);
  }
}
